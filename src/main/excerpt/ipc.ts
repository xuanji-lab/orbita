/**
 * 摘抄的 IPC —— 四层契约的第 2 层。三个通道（add / list / remove），契约在
 * shared/excerpt.ts。入参当不可信数据：过不了校验的抛错（invoke 在 renderer 侧
 * 变 rejected promise）。list 顺带补出处会话标题——SessionStore 读 meta，同一
 * 会话只读一次；会话已删 → sessionTitle = null（摘抄不级联删，2026-10-15 裁决）。
 */
import { ipcMain } from "electron";
import {
  excerptChannels,
  type ExcerptAddResponse,
  type ExcerptListResponse,
  type ExcerptRemoveResponse,
} from "../../shared/excerpt.ts";
import type { SessionStore } from "../session/store.ts";
import { attachSessionTitles, ExcerptStore } from "./store.ts";
import { parseExcerptAddRequest, parseExcerptRemoveRequest } from "./validate.ts";

export function registerExcerptIpc(excerpts: ExcerptStore, sessions: SessionStore): void {
  ipcMain.handle(excerptChannels.add, (_event, raw: unknown): Promise<ExcerptAddResponse> => {
    const request = parseExcerptAddRequest(raw);
    if (request === null) throw new Error("invalid excerpt add request");
    return excerpts.add(request);
  });

  ipcMain.handle(excerptChannels.list, async (_event): Promise<ExcerptListResponse> => {
    // 全量拉给 renderer：量小，按会话过滤与关键词搜索在界面侧做（契约头部注释的分工）
    const all = await excerpts.list();
    return { items: await attachSessionTitles(all, sessions) };
  });

  ipcMain.handle(excerptChannels.remove, (_event, raw: unknown): Promise<ExcerptRemoveResponse> => {
    const request = parseExcerptRemoveRequest(raw);
    if (request === null) throw new Error("invalid excerpt remove request");
    return excerpts.remove(request.id).then((removed): ExcerptRemoveResponse => ({ removed }));
  });
}
