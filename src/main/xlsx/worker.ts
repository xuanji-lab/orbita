/**
 * xlsx 解析的 worker 线程入口（打包成独立的 `out/main/xlsx-worker.js`，入口在
 * `electron.vite.config.ts` 的 main.input 里）。
 *
 * 为什么是线程而不是主进程内直接读：ExcelJS 解一份 20000 行 × 60 列的工作簿实测
 * 2.3 s，其中有一次 ~1.1 s 的连续同步解析——放在主进程里就是窗口整段假死。线程
 * 里的堆不进主进程的事件循环，窗口照常绘帧。
 *
 * 线程是**无状态**的：一条消息一次解析，回执带请求 id。多张表 / 多次刷新就是多条
 * 消息，主进程侧按 id 对号（`service.ts`）。
 */
import { parentPort } from "node:worker_threads";
import { readXlsxPreview } from "./read.ts";
import type { XlsxWorkerRequest, XlsxWorkerReply } from "./service.ts";

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

if (parentPort !== null) {
  parentPort.on("message", (request: XlsxWorkerRequest) => {
    void readXlsxPreview(request.path, { sheet: request.sheet }).then(
      (preview) => {
        const reply: XlsxWorkerReply = { id: request.id, ok: true, preview };
        parentPort?.postMessage(reply);
      },
      (cause: unknown) => {
        const reply: XlsxWorkerReply = { id: request.id, ok: false, error: failMessage(cause) };
        parentPort?.postMessage(reply);
      },
    );
  });
}
