/**
 * 审查面板的 IPC —— 四层契约的第 2 层。列表与 diff 都在主进程算：
 * task 来源读会话自己的快照账，git 来源只读跑 git。cwd 一律按 sessionId 从
 * meta 读（路径策略在主进程，不信 renderer 传来的任何路径）。review:diff 的 path 也是 renderer
 * 传来的：边界在两个来源里判（git 只认工作区内、task 只认文件账上），这里只管入参形状。
 * 拒绝与失败一律回 ReviewDiff.error，不再回一个会被显示成「二进制」的空结果。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  isReviewSource,
  reviewDiffError,
  type ReviewDiff,
  type ReviewList,
  type ReviewSource,
} from "../../shared/review.ts";
import type { SessionStore } from "../session/store.ts";
import { gitReviewDiff, gitReviewList, realDiffRunner, realGitRunner } from "./git-source.ts";
import { taskReviewDiff, taskReviewList } from "./task-source.ts";

export function registerReviewIpc(sessions: SessionStore): void {
  ipcMain.handle(
    ipcChannels.reviewList,
    async (_event, sessionId: string, rawSource: unknown): Promise<ReviewList> => {
      if (typeof sessionId !== "string" || !isReviewSource(rawSource)) {
        return { kind: "error", message: "invalid review request", cwd: "" };
      }
      const source: ReviewSource = rawSource;
      if (source === "task") return taskReviewList(sessions, sessionId);
      const meta = await sessions.readMeta(sessionId);
      if (meta === null) return { kind: "error", message: `task ${sessionId} not found`, cwd: "" };
      try {
        return await gitReviewList(realGitRunner, meta.cwd, source);
      } catch (cause) {
        return {
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
          cwd: meta.cwd,
        };
      }
    },
  );

  ipcMain.handle(
    ipcChannels.reviewDiff,
    async (_event, sessionId: unknown, rawSource: unknown, rawPath: unknown): Promise<ReviewDiff> => {
      if (typeof sessionId !== "string" || !isReviewSource(rawSource) || typeof rawPath !== "string") {
        return reviewDiffError("invalid-request", "invalid review diff request");
      }
      const source: ReviewSource = rawSource;
      const path = rawPath;
      try {
        if (source === "task") return await taskReviewDiff(sessions, sessionId, path);
        const meta = await sessions.readMeta(sessionId);
        if (meta === null) return reviewDiffError("task-not-found", `task ${sessionId} not found`);
        return await gitReviewDiff(realDiffRunner, meta.cwd, source, path);
      } catch (cause) {
        return reviewDiffError("failed", cause instanceof Error ? cause.message : String(cause));
      }
    },
  );
}
