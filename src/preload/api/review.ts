/**
 * 审查面板的 contextBridge 面 —— 四层契约的第 3 层。
 * 列表与 diff 都在主进程算（git 只读、快照基线都在那边），renderer 只收结果。
 * cwd 不从 renderer 传——主进程按 sessionId 读会话自己的 meta（路径策略在主进程，
 * 同 fs:roots 的白名单纪律）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ReviewDiff, ReviewList, ReviewSource } from "../../shared/review.ts";

export const reviewApi = {
  /** 列一个来源的全部改动；source = task 时看的是这条会话自己的文件账 */
  list: (sessionId: string, source: ReviewSource): Promise<ReviewList> =>
    ipcRenderer.invoke(ipcChannels.reviewList, sessionId, source),
  /** 拉一个文件的 diff 正文（unified diff，按需展开） */
  diff: (sessionId: string, source: ReviewSource, path: string): Promise<ReviewDiff> =>
    ipcRenderer.invoke(ipcChannels.reviewDiff, sessionId, source, path),
};
