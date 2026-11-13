/**
 * xlsx 解析线程的持有者（`fs:read-xlsx` 只经过它，不直接读文件）。
 *
 * 一个常驻线程 + 按 id 对号在途请求：
 *   - 常驻：ExcelJS 与一份工作簿的解析都在这条线程里，反复起停反而更贵（切文件、
 *     切工作表一天几十次）。
 *   - 线程死了（OOM、打包漏了 worker 文件）就在途请求全部结掉并丢弃句柄，下一次
 *     请求重建线程——一个坏文件不该让这个功能永久失联。
 *   - **只结死掉那条线程的账**：`error` 之后会立刻重建，旧线程随后才 emit `exit`；
 *     `exit` 若无条件清空 pending，就会把新线程的在途请求一起拒掉（评审在 #341 抓到）。
 *   - 有内存上限与总超时：50 MB 限的是压缩后大小，病态工作簿解压后可以吃掉几个 GB。
 *     超时或撞上限就**丢弃整条线程**（半途的解析没法中断），下一次请求重建。
 *
 * 线程入口是打包产物 `out/main/xlsx-worker.js`（与本文件同目录），不是 `worker.ts`
 * 源码：dev 与打包后都是「主进程 bundle 的邻居」。
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { XlsxPreview } from "../../shared/xlsx.ts";

/** worker 的一条请求（`worker.ts` 收） */
export interface XlsxWorkerRequest {
  id: number;
  path: string;
  sheet: number;
}

/** worker 的回执：成功带预览结果，失败带一句可读原因 */
export type XlsxWorkerReply =
  | { id: number; ok: true; preview: XlsxPreview }
  | { id: number; ok: false; error: string };

interface PendingRequest {
  resolve: (preview: XlsxPreview) => void;
  reject: (error: Error) => void;
  /** 总超时计时器（settle 时清掉，别让它在结果回来以后还挂着） */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 一次解析的总时限。本机 20000×60、8 MB 的工作簿实测 2.2–2.3 s；60 s 是给病态文件
 * 留的余量——到点就丢线程，不让「这个功能到重启都不可用」。
 */
export const XLSX_PARSE_TIMEOUT_MS = 60_000;

/** 解析线程的堆上限（MB）：正常工作簿远用不到；撞上就是病态文件，丢掉重建 */
export const XLSX_WORKER_HEAP_MB = 1024;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function settle(id: number): PendingRequest | undefined {
  const request = pending.get(id);
  if (request === undefined) return undefined;
  pending.delete(id);
  clearTimeout(request.timer);
  return request;
}

function failPending(reason: string): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
}

/** 丢掉当前线程（它已经不可信：崩溃、超时、撞内存上限），下一次请求重建 */
function discard(target: Worker): void {
  if (worker === target) worker = null;
  void target.terminate();
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  const created = new Worker(join(__dirname, "xlsx-worker.js"), {
    resourceLimits: { maxOldGenerationSizeMb: XLSX_WORKER_HEAP_MB },
  });
  created.on("message", (reply: XlsxWorkerReply) => {
    const request = settle(reply.id);
    if (request === undefined) return;
    if (reply.ok) request.resolve(reply.preview);
    else request.reject(new Error(reply.error));
  });
  // 线程死了：只有在它还是「当前线程」时才结账。error 之后 error 的那条已经让位给
  // 新线程（或即将重建），它的 exit 不该动别人的请求。
  created.on("error", (cause: Error) => {
    if (worker === created) {
      worker = null;
      failPending(`xlsx worker failed: ${failMessage(cause)}`);
    }
  });
  created.on("exit", (code: number) => {
    if (worker === created) {
      worker = null;
      failPending(`xlsx worker exited (${code})`);
    }
  });
  worker = created;
  return created;
}

/**
 * 在解析线程里读一份 .xlsx（调用方已过白名单并确认扩展名）。
 * `timeoutMs` 只为测试注入更短的时限（同 read.ts 的 maxRows 一类），生产走常量。
 */
export function readXlsxInWorker(
  path: string,
  sheet: number,
  timeoutMs: number = XLSX_PARSE_TIMEOUT_MS,
): Promise<XlsxPreview> {
  const target = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const request = settle(id);
      if (request === undefined) return;
      discard(target);
      failPending(`xlsx worker timed out after ${Math.round(timeoutMs / 1000)}s`);
      request.reject(new Error(`解析超时（${Math.round(timeoutMs / 1000)} 秒），这个工作簿可能太大了`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.postMessage({ id, path, sheet } satisfies XlsxWorkerRequest);
  });
}
