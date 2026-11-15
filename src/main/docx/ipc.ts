/**
 * docx 的 IPC —— 四层契约的第 2 层（契约在 `shared/docx.ts`）。
 *
 * 白名单与 `fs:read` 同一道：`resolveFileRoots` 现算 + `whitelistedTargetPath` 做 realpath
 * 之后的前缀校验。写入通道因此比读通道更危险——它同样只允许落在会话的三类根之内，
 * 且只认 `.docx`（realpath 之后判，改名的软链接被拒）。
 *
 * N2 在这里多两件事：
 *   1. **打开时盖章**：段落标识不完整的包进线程补 `w14:paraId`，把盖章后的字节交给
 *      renderer 当编辑基线（磁盘不动，首次保存自然写回）。失败不拦打开。
 *   2. **agent 的 `edit_docx` 中转**：请求转给 renderer 里活的编辑器，renderer 用
 *      `docxEditReply` 回执。主进程在这里只判白名单 + 找窗口 + 超时兜底——docx 的
 *      唯一写入口必须是那个活着的编辑器（见 shared/docx.ts 顶注释）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  DOCX_EDIT_TIMEOUT_MS,
  isDocxFile,
  type DocxEditOutcome,
  type DocxEditReplyMessage,
  type DocxEditRequestMessage,
  type DocxOpenResult,
  type DocxSaveRequest,
  type DocxSaveResult,
} from "../../shared/docx.ts";
import type { FileListRequest } from "../../shared/files.ts";
import { mainWindows } from "../window/main-windows.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedTargetPath } from "../files/list.ts";
import { readDocxFile } from "./read.ts";
import { ensureParaIdStamp } from "./stamp.ts";
import { saveDocxFile } from "./write.ts";

/** 在途的 docx 编辑请求：按 requestId 对号，renderer 回执时结账 */
interface PendingEdit {
  settle: (outcome: DocxEditOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingEdits = new Map<string, PendingEdit>();

/**
 * 把一条编辑请求交给 renderer 里活的编辑器，等它回执。
 *
 * 三个失败面都回**值**不回异常：没窗口 / renderer 没回 / 超时——模型据此说一句人话，
 * 不需要理解 Electron 的进程边界。
 */
export function dispatchDocxEdit(message: DocxEditRequestMessage): Promise<DocxEditOutcome> {
  const window = mainWindows.list()[0];
  if (window === undefined || window.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, reason: "not-open", error: "Orbita 窗口没开着，没有可以写入的编辑器。" });
  }
  return new Promise<DocxEditOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingEdits.delete(message.requestId);
      resolve({ ok: false, reason: "busy", error: `编辑器 ${DOCX_EDIT_TIMEOUT_MS / 1000} 秒内没有回执（文档可能太大或排版卡住了）。` });
    }, DOCX_EDIT_TIMEOUT_MS);
    pendingEdits.set(message.requestId, { settle: resolve, timer });
    window.webContents.send(ipcChannels.docxEditRequest, message);
  });
}

/**
 * @param backupDir 上一版的备份根（`<userData>/docx-backups`）。备份放应用数据目录，
 * 不进工作区——工作区里多出来的文件会出现在文件面板与 git 状态里。
 */
export function registerDocxIpc(workspaces: WorkspaceStore, sessions: SessionStore, backupDir: string): void {
  ipcMain.handle(ipcChannels.docxOpen, async (_event, req: FileListRequest): Promise<DocxOpenResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    // 打开也走 whitelistedTargetPath：文件在打开这一刻已经被外部删掉时，要回
    // invalid(missing) 让面板说一句人话，而不是把「目录不存在」的原始报错糊上去
    // （编辑器开着、用户在文件管理器里删了它、再点刷新——这是真会发生的顺序）
    const target = await whitelistedTargetPath(roots, req);
    if ("missing" in target) return { kind: "invalid", reason: "missing", size: 0, modifiedAt: 0 };
    if (!isDocxFile(target.path)) throw new Error(`Not a Word document: ${target.path}`);
    const result = await readDocxFile(target.path);
    if (result.kind !== "docx") return result;
    // 盖章：判据是包里的 paraId 覆盖率（见 stamp.ts）。`hash` 仍是磁盘原始内容的 hash，
    // 保存时的冲突判据不能换成盖章后的字节。
    const stamped = await ensureParaIdStamp(result.data, result.stats);
    return { ...result, data: stamped.data, stamp: stamped.stamp };
  });

  ipcMain.handle(ipcChannels.docxSave, async (_event, req: DocxSaveRequest): Promise<DocxSaveResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req.target);
    // 写通道用 whitelistedTargetPath：文件被外部删掉时它仍给出合法路径，
    // 「文件没了」于是走到 saveDocxFile 的 conflict(missing)，而不是一句
    // 「目录不存在」的原始 IPC 报错（2026-10-24 评审复现）
    const target = await whitelistedTargetPath(roots, req.target);
    if ("missing" in target) return { kind: "conflict", reason: "missing", modifiedAt: null };
    if (!isDocxFile(target.path)) throw new Error(`Not a Word document: ${target.path}`);
    if (!(req.data instanceof Uint8Array)) throw new Error("docx:save expects the serialized document bytes");
    return saveDocxFile({
      path: target.path,
      expectedHash: req.expectedHash,
      data: req.data,
      backupDir,
    });
  });

  // renderer 对 agent 编辑请求的回执。迟到的回执（已超时）直接丢弃——丢弃比结算两次安全
  ipcMain.handle(ipcChannels.docxEditReply, (_event, reply: DocxEditReplyMessage): void => {
    const pending = pendingEdits.get(reply.requestId);
    if (pending === undefined) return;
    pendingEdits.delete(reply.requestId);
    clearTimeout(pending.timer);
    pending.settle(reply.outcome);
  });
}
