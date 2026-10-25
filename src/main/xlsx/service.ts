/**
 * xlsx 解析线程的持有者（`fs:read-xlsx` 只经过它，不直接读文件）。
 *
 * 一个常驻线程 + 按 id 对号在途请求：
 *   - 常驻：ExcelJS 与一份工作簿的解析都在这条线程里，反复起停反而更贵（切文件、
 *     切工作表一天几十次）。
 *   - 线程死了（OOM、打包漏了 worker 文件）就在途请求全部结掉并丢弃句柄，下一次
 *     请求重建线程——一个坏文件不该让这个功能永久失联。
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
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

function failPending(reason: string): void {
  for (const request of pending.values()) request.reject(new Error(reason));
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  const created = new Worker(join(__dirname, "xlsx-worker.js"));
  created.on("message", (reply: XlsxWorkerReply) => {
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.preview);
    else request.reject(new Error(reply.error));
  });
  created.on("error", (cause: Error) => {
    if (worker === created) worker = null;
    failPending(`xlsx worker failed: ${cause.message}`);
  });
  created.on("exit", (code: number) => {
    if (worker === created) worker = null;
    failPending(`xlsx worker exited (${code})`);
  });
  worker = created;
  return created;
}

/** 在解析线程里读一份 .xlsx（调用方已过白名单并确认扩展名） */
export function readXlsxInWorker(path: string, sheet: number): Promise<XlsxPreview> {
  const target = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, path, sheet } satisfies XlsxWorkerRequest);
  });
}
