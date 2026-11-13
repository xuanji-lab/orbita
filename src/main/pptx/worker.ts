/**
 * pptx 解析的 worker 线程入口（打包成独立的 `out/main/pptx-worker.js`，入口在
 * `electron.vite.config.ts` 的 main.input 里）。
 *
 * 线程是**一次性**的：一条消息一次解析，回执后由 `service.ts` terminate。解析成本
 * 的预算在 `read.ts` 里（流式读取 + 字符 / 节点上限），这里只负责把结论搬回去。
 */
import { parentPort } from "node:worker_threads";
import { readPptx } from "./read.ts";
import type { PptxWorkerReply, PptxWorkerRequest } from "./service.ts";

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

if (parentPort !== null) {
  parentPort.on("message", (request: PptxWorkerRequest) => {
    void readPptx(request.path).then(
      (preview) => {
        const reply: PptxWorkerReply = { ok: true, preview };
        parentPort?.postMessage(reply);
      },
      (cause: unknown) => {
        const reply: PptxWorkerReply = { ok: false, error: failMessage(cause) };
        parentPort?.postMessage(reply);
      },
    );
  });
}
