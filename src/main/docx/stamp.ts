/**
 * 打开 docx 时给段落补齐 `w14:paraId`（「盖章」）—— N2 指哪打哪的前置动作。
 *
 * **为什么必须在打开时做**（2026-10-27 实测，见 N2 调研）：选择性保存会故意剥掉引擎给
 * 「源 XML 里没有 paraId 的段落」mint 的 id（作者的包长什么样，就得存成什么样）。于是
 * 「改一份 pandoc / python-docx / WPS 产的论文 → 存盘 → 重开」后同一段的 blockId 变了，
 * 所有锚点失效。先在打开时把 id 写进**编辑基线**（磁盘不动），首次保存就会把它们写回文件；
 * 实测仍是选择性保存（不是整份重排），重开后 blockId 原样存活。
 *
 * **为什么在线程里**：4145 段（≈104 页）实测 1618 ms，同步 CPU——放主进程就是窗口假死。
 * 线程入口是打包产物 `out/main/docx-worker.js`（与 xlsx-worker / pptx-worker 同一个做法）。
 *
 * **失败不拦打开**：签名包会被引擎拒绝（改包会作废数字签名），超时 / 未知错误同理——
 * 一律退回原始字节并如实回报原因，界面说一句「锚点只在本次打开内有效」。
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { DocxParaIdStamp, DocxPackageStats } from "../../shared/docx.ts";

/** 盖章的总时限：实测 1.6 s / 4145 段，20 s 是给病态文档留的余量 */
export const DOCX_STAMP_TIMEOUT_MS = 20_000;

/** 线程的堆上限（MB）：一份 50 MB 的包解压后可以吃掉几百 MB，撞上就丢线程 */
export const DOCX_STAMP_WORKER_HEAP_MB = 1024;

/** 这条线程的请求形状（`worker.ts` 收） */
export interface DocxStampRequest {
  id: number;
  bytes: Uint8Array;
}

/** 线程的回执：成功带盖章后的字节与计数；失败只说原因 */
export type DocxStampReply =
  | { id: number; ok: true; data: Uint8Array; assigned: number; deduplicated: number; alreadyComplete: boolean }
  | { id: number; ok: false; reason: "signed" | "failed"; error: string };

/** 打开时的盖章结论（`DocxParaIdStamp` 加上要交给 renderer 的字节） */
export interface DocxStamped {
  data: Uint8Array;
  stamp: DocxParaIdStamp;
}

/**
 * 要不要盖：段落数多于 paraId 数就得盖（Word / LibreOffice 存的包通常一个不缺）。
 * 纯函数，读盘时顺手从 document.xml 数出来（见 read.ts 的 packageStats）。
 */
export function needsStamp(stats: DocxPackageStats): boolean {
  return stats.paraIds < stats.paragraphs;
}

const failed = (bytes: Uint8Array, reason: "signed" | "timeout" | "failed"): DocxStamped => ({
  data: bytes,
  stamp: { ok: false, assigned: 0, deduplicated: 0, reason },
});

const STAMP_OK = { ok: true, assigned: 0, deduplicated: 0, reason: null } as const;

interface Pending {
  resolve: (reply: DocxStampReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function settle(id: number): Pending | undefined {
  const request = pending.get(id);
  if (request === undefined) return undefined;
  pending.delete(id);
  clearTimeout(request.timer);
  return request;
}

function failPending(reason: "timeout" | "failed"): void {
  for (const [id, request] of [...pending.entries()]) {
    // 线程已经不可信：统一按失败结账（迟到回执由 settle 丢弃）
    pending.delete(id);
    clearTimeout(request.timer);
    request.resolve({ id, ok: false, reason: "failed", error: reason });
  }
}

function discard(target: Worker): void {
  if (worker === target) worker = null;
  void target.terminate();
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  const created = new Worker(join(__dirname, "docx-worker.js"), {
    resourceLimits: { maxOldGenerationSizeMb: DOCX_STAMP_WORKER_HEAP_MB },
  });
  created.on("message", (reply: DocxStampReply) => {
    const request = settle(reply.id);
    if (request !== undefined) request.resolve(reply);
  });
  // error 之后会立刻重建；旧线程随后才 emit exit——只有它还是当前线程时才结账
  created.on("error", () => {
    if (worker === created) {
      worker = null;
      failPending("failed");
    }
  });
  created.on("exit", () => {
    if (worker === created) {
      worker = null;
      failPending("failed");
    }
  });
  worker = created;
  return created;
}

/** 在盖章线程里跑一次（调用方已判 needsStamp）。线程坏了就在下一次重建。 */
export function stampInWorker(bytes: Uint8Array, timeoutMs: number = DOCX_STAMP_TIMEOUT_MS): Promise<DocxStampReply> {
  const target = ensureWorker();
  const id = nextId++;
  return new Promise<DocxStampReply>((resolve) => {
    const timer = setTimeout(() => {
      const request = settle(id);
      if (request === undefined) return;
      // 超时的那一刻线程还在跑（同步 CPU 中断不了）：丢掉整条线程
      discard(target);
      request.resolve({ id, ok: false, reason: "failed", error: "timeout" });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    // **不带 transfer list**：结构化克隆替我们拷一份。转移会让调用方手里的字节变 detached，
    // 而盖章失败时我们要把**原始字节**还给 renderer——那才是打开能继续的前提。
    target.postMessage({ id, bytes } satisfies DocxStampRequest);
  });
}

/**
 * `docx:open` 的盖章一步：不需要就原样返回；需要就进线程，任何失败都退回原始字节。
 * `stamper` 只为测试注入（生产走 `stampInWorker`）。
 */
export async function ensureParaIdStamp(
  bytes: Uint8Array,
  stats: DocxPackageStats,
  stamper: (bytes: Uint8Array) => Promise<DocxStampReply> = stampInWorker,
): Promise<DocxStamped> {
  if (!needsStamp(stats)) return { data: bytes, stamp: { ...STAMP_OK } };
  let reply: DocxStampReply;
  try {
    reply = await stamper(bytes);
  } catch {
    return failed(bytes, "failed");
  }
  if (!reply.ok) {
    if (reply.error === "timeout") return failed(bytes, "timeout");
    return failed(bytes, reply.reason);
  }
  return {
    data: reply.data,
    stamp: {
      ok: true,
      assigned: reply.assigned,
      deduplicated: reply.deduplicated,
      // 判过 needsStamp 还是 alreadyComplete：计数对不上（并发改写 / 计数误判）也不报错，
      // 只是没东西可盖——按「盖上但零段」处理
      reason: null,
    },
  };
}
