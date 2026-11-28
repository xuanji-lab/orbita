/**
 * pptx 解析线程的持有者（`fs:read-pptx` 只经过它，不直接读文件）。
 *
 * 为什么必须离开主进程（R1）：解析是 jszip 解压 + 自写 XML 建树，成本由**文件内容**
 * 决定而不是文件大小。评审构造的 0.9 MB 包（40 页 × 15.7 MB 元素密集）在主进程里
 * 跑了 28.7 s、单次卡顿 938 ms、RSS 1.08 GB；`--max-old-space-size=256` 下直接
 * fatal OOM（不可 catch）。放进 worker 后主线程只等结果，崩溃也不带走窗口。
 *
 * **每次请求一个新线程，用完就 terminate**：
 *   - 解析成本已经被 read.ts 的流式预算钉住（单页 1.5 M 字符、全包 40 M、单页
 *     50 k 节点），线程起停的几十毫秒比常驻线程守着可能被 pause 的流更划算；
 *   - 构造包触发暂停流时，terminate 是唯一能确定释放解压状态的办法——常驻线程
 *     会把那份 paused 的 inflate 状态留到下一条请求。
 *
 * 资源上限两层：
 *   - `resourceLimits` 给 worker 的 JS 堆封顶（OOM 只会死在 worker 里）；
 *   - 总超时 `PPTX_WORKER_TIMEOUT_MS` 兜住「预算没算到的慢」；到点 terminate，
 *     回一个可读的 timeout 结果而不是把异常抛给渲染层。
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { PptxPreview } from "../../shared/pptx.ts";

/** 一次解析的总时限：正常 300 页纯文本大纲远小于它 */
const PPTX_WORKER_TIMEOUT_MS = 10_000;
/** worker 的 JS 堆上限（RSS 由它 + zip buffer 决定） */
const PPTX_WORKER_HEAP_MB = 192;

export interface PptxWorkerRequest {
  path: string;
}

export type PptxWorkerReply =
  | { ok: true; preview: PptxPreview }
  | { ok: false; error: string };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** stat 只用来给「读不了」的结论补 size / modifiedAt；文件刚被删也能回 0 */
async function fileFacts(path: string): Promise<{ size: number; modifiedAt: number }> {
  const stats = await stat(path).catch(() => null);
  return { size: stats?.size ?? 0, modifiedAt: stats?.mtimeMs ?? 0 };
}

/**
 * 在解析线程里读一份 .pptx（调用方已过白名单并确认扩展名）。
 * worker 崩溃 / 超时 / OOM 都不抛给调用方：回 `unreadable` 的可读结论，与
 * read.ts 对坏文件的处理保持同一种形状。
 */
export async function readPptxInWorker(path: string): Promise<PptxPreview> {
  let timedOut = false;
  let worker: Worker | null = null;
  try {
    worker = new Worker(join(__dirname, "pptx-worker.js"), {
      resourceLimits: {
        maxOldGenerationSizeMb: PPTX_WORKER_HEAP_MB,
        maxYoungGenerationSizeMb: 32,
      },
    });
    const target = worker;
    return await new Promise<PptxPreview>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        finish(() => reject(new Error(`pptx worker timed out after ${PPTX_WORKER_TIMEOUT_MS} ms`)));
      }, PPTX_WORKER_TIMEOUT_MS);
      target.once("message", (reply: PptxWorkerReply) => {
        finish(() => {
          if (reply.ok) resolve(reply.preview);
          else reject(new Error(reply.error));
        });
      });
      target.once("error", (cause: Error) => finish(() => reject(cause)));
      target.once("exit", (code: number) => {
        // 正常回执后线程被 terminate，exit 会晚于 message 到达——settled 挡住它
        finish(() => reject(new Error(`pptx worker exited (${code})`)));
      });
      target.postMessage({ path } satisfies PptxWorkerRequest);
    });
  } catch (cause) {
    const facts = await fileFacts(path);
    return {
      kind: "unreadable",
      reason: timedOut ? "timeout" : "complex",
      detail: failMessage(cause),
      ...facts,
    };
  } finally {
    if (worker !== null) await worker.terminate();
  }
}
