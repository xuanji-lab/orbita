/**
 * docx 盖章线程的入口（打包成独立的 `out/main/docx-worker.js`，入口在
 * `electron.vite.config.ts` 的 main.input 里）。
 *
 * 只做一件事：`ensureParaIds(bytes)` —— 给所有段落补齐 / 去重 `w14:paraId`。
 * 4145 段实测 1.4–1.6 s 的同步 CPU，放主进程就是窗口假死，所以与 xlsx-worker /
 * pptx-worker 同一个做法：一条独立线程、一条消息一次活、按 id 对号。
 *
 * 线程是**无状态**的：不改磁盘、不缓存包——调用方（`stamp.ts`）负责判要不要盖、
 * 超时与失败降级。
 */
import { parentPort } from "node:worker_threads";
import { ensureParaIds } from "@stll/folio-core/docx/ensureParaIds";
import type { DocxStampReply, DocxStampRequest } from "./stamp.ts";

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 签名包的错误码在 EnsureParaIdsError.message 旁边（reason 字段），字符串匹配只作兜底 */
function signedReason(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const reason = (cause as { reason?: unknown }).reason;
  if (reason === "signed-package") return true;
  return /signed/i.test(failMessage(cause));
}

if (parentPort !== null) {
  parentPort.on("message", (request: DocxStampRequest) => {
    void ensureParaIds(request.bytes)
      .then((result) => {
        const reply: DocxStampReply = {
          id: request.id,
          ok: true,
          // 已完备时它原样回传输入；克隆过来的是新 buffer，直接交还即可
          data: result.docx,
          assigned: result.assigned,
          deduplicated: result.deduplicated,
          alreadyComplete: result.alreadyComplete,
        };
        parentPort?.postMessage(reply);
      })
      .catch((cause: unknown) => {
        const reply: DocxStampReply = signedReason(cause)
          ? { id: request.id, ok: false, reason: "signed", error: failMessage(cause) }
          : { id: request.id, ok: false, reason: "failed", error: failMessage(cause) };
        parentPort?.postMessage(reply);
      });
  });
}
