/**
 * agent 终端工具请求（terminalRequest）→ 在会话自己的可见终端上执行 → 回执载荷。
 *
 * 六个动作一对一对牢 shared/terminal.ts 的 TerminalToolRequest。**PTY 全在主进程**：
 * agent 进程不碰 node-pty、不碰 userData（browserRequest 同一条边界），它那边只剩
 * 「工具定义 → requestId 问答」一层薄包装。
 *
 * 与人工终端的关系：**同一套 PTY、同一个面板 tab**。人在这边敲键盘与 agent 在那边
 * 写命令落在同一个 shell 上——这是「随时接管」的实现方式，也是 agent 干活必须可见的
 * 理由（主进程在开终端时广播 terminal:agent-open）。
 */
import { realpathSync, statSync } from "node:fs";
import type { TerminalInfo, TerminalToolOutcome, TerminalToolRequest, TerminalReadView } from "../../shared/terminal.ts";
import { pageTerminalOutput } from "../../shared/terminal.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { TerminalService } from "./service.ts";
import { ownedTerminal, resolveAgentTerminalCwd } from "./agent-policy.ts";

/** agent 写入的「回车」：ConPTY 与 posix PTY 都认 CR 为提交一行 */
const CARRIAGE_RETURN = "\r";
/** Ctrl+C */
const INTERRUPT = "\u0003";

/** 真的 fs 依赖（策略模块的注入点，生产环境就用真的） */
const fsDeps = {
  realpath: (path: string): string => realpathSync(path),
  isDirectory: (path: string): boolean => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};
/**
 * 一个 terminalRequest 的完整处理：算授权目录 → 派发动作。**任何路径都回执**——
 * 挂着不回的话 agent 进程里那次工具调用永远等下去（readTaskRequest 同一条纪律）。
 */
export async function applyTerminalRequest(
  service: TerminalService,
  sessions: SessionStore,
  workspaces: WorkspaceStore,
  event: { sessionId: string; request: TerminalToolRequest },
): Promise<TerminalToolOutcome> {
  const roots = await sessionTerminalRoots(sessions, workspaces, event.sessionId);
  try {
    return await dispatch(service, event.sessionId, roots, event.request);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 会话授权目录 = 工作区根（meta.cwd）+ 工作区挂的附加目录。**与开轮目录清单同源**
 * （main/agent/turn-directories.ts 的 attached 走同一个 workspaces.attachedDirsOf）：
 * 模型在 prompt 里读到「你可以去这些目录」，终端的 cwd 授权就必须认同一份名单，
 * 不然提示词说的是假话。
 *
 * 工作台**不在**名单里：那是会话私有草稿区，不是「开终端干活」的地方。
 */
async function sessionTerminalRoots(
  sessions: SessionStore,
  workspaces: WorkspaceStore,
  sessionId: string,
): Promise<string[]> {
  const meta = await sessions.readMeta(sessionId);
  const attached = await workspaces.attachedDirsOf(meta?.workspaceId ?? null);
  return [...(meta?.cwd !== undefined ? [meta.cwd] : []), ...attached];
}

async function dispatch(
  service: TerminalService,
  sessionId: string,
  roots: readonly string[],
  request: TerminalToolRequest,
): Promise<TerminalToolOutcome> {
  const context = { roots, defaultCwd: roots[0] ?? "" };
  switch (request.action) {
    case "open": {
      const cwd = resolveAgentTerminalCwd(request.cwd, context, fsDeps);
      if (!cwd.ok) return { ok: false, error: cwd.error };
      const terminal = await service.createForAgent(sessionId, { cwd: cwd.cwd });
      return { ok: true, terminal, text: describeOpened(terminal) };
    }
    case "execute": {
      const command = request.command.trim();
      if (command === "") return { ok: false, error: "command is required — pass the complete command line." };
      let terminal: TerminalInfo;
      const reused = request.terminalId !== undefined;
      if (reused) {
        const found = ownedTerminal(service.list(), sessionId, request.terminalId ?? "", { requireRunning: true });
        if (!found.ok) return { ok: false, error: found.error };
        terminal = found.terminal;
      } else {
        const cwd = resolveAgentTerminalCwd(request.cwd, context, fsDeps);
        if (!cwd.ok) return { ok: false, error: cwd.error };
        terminal = await service.createForAgent(sessionId, { cwd: cwd.cwd });
      }
      try {
        service.input(terminal.terminalId, command + CARRIAGE_RETURN);
      } catch (cause) {
        // 人与 agent 共用同一个 tab：这一刻它可能刚被用户关掉。说清楚，别让模型重试同一个 id
        return {
          ok: false,
          error:
            `Terminal "${terminal.terminalId}" was closed while the command was being written ` +
            `(${cause instanceof Error ? cause.message : String(cause)}). Call terminal_list and start again.`,
        };
      }
      return { ok: true, terminal, text: describeExecuted(terminal, reused) };
    }
    case "read": {
      const found = ownedTerminal(service.list(), sessionId, request.terminalId, { requireRunning: false });
      if (!found.ok) return { ok: false, error: found.error };
      const view = pageTerminalOutput(service.snapshot(found.terminal.terminalId).output, {
        offset: request.offset,
        limit: request.limit,
      });
      return { ok: true, terminal: found.terminal, text: describeRead(found.terminal, view) };
    }
    case "list": {
      const owned = service
        .list()
        .filter((item) => item.owner.kind === "agent" && item.owner.sessionId === sessionId);
      return { ok: true, text: describeList(owned) };
    }
    case "interrupt": {
      const found = ownedTerminal(service.list(), sessionId, request.terminalId, { requireRunning: true });
      if (!found.ok) return { ok: false, error: found.error };
      service.input(found.terminal.terminalId, INTERRUPT);
      return { ok: true, terminal: found.terminal, text: describeInterrupted(found.terminal) };
    }
    case "close": {
      const found = ownedTerminal(service.list(), sessionId, request.terminalId, { requireRunning: false });
      if (!found.ok) return { ok: false, error: found.error };
      service.kill(found.terminal.terminalId);
      return { ok: true, terminal: found.terminal, text: describeClosed(found.terminal) };
    }
  }
}

// ── 给模型的正文。每条都要回答「下一步干什么」——工具结果是指令，不是状态回显 ──────

function describeOpened(terminal: TerminalInfo): string {
  return (
    `Opened a visible terminal (id ${terminal.terminalId}) at ${terminal.cwd} using ${terminal.shell}. ` +
    "The user can see it in the terminal panel and can type in it at any time — whatever they type shares " +
    "this same shell. No command has been run: call terminal_execute to run one, and terminal_read with " +
    "this terminalId to see what happened."
  );
}

function describeExecuted(terminal: TerminalInfo, reused: boolean): string {
  return (
    `Started the command in visible terminal ${terminal.terminalId} (cwd ${terminal.cwd}, shell ` +
    `${terminal.shell}, ${reused ? "reused an existing terminal" : "opened a new terminal"}).\n` +
    "outputSharedWithAgent: false — the command's output is NOT in this result. Call terminal_read with " +
    `terminalId "${terminal.terminalId}" to read it; it returns the tail of the plain-text output, and you ` +
    "can page back with offset. The user sees the command and its output live and can take over at any time."
  );
}

function describeRead(terminal: TerminalInfo, view: TerminalReadView): string {
  const lines = [
    `Terminal ${terminal.terminalId} — plain text, characters ${view.startOffset}–${view.endOffset} of ${view.total}` +
      `${view.hasMore ? ` (more remains: call terminal_read again with offset ${view.endOffset})` : " (this is the end)"}.`,
    ...(terminal.exited === null
      ? []
      : [`This terminal has exited (exit code ${terminal.exited}); the text below is what it printed before exiting.`]),
    "",
    view.text === "" ? "(no output yet)" : view.text,
  ];
  return lines.join("\n");
}

function describeList(terminals: readonly TerminalInfo[]): string {
  if (terminals.length === 0) {
    return (
      "This session owns no visible terminals yet. Open one with terminal_open, or let terminal_execute " +
      "open one by omitting terminalId. Every terminal the user opened by hand is visible in the panel too, " +
      "but this session cannot drive those."
    );
  }
  const rows = terminals.map(
    (item) =>
      `- ${item.terminalId} · cwd ${item.cwd} · ${item.shell} · ` +
      (item.exited === null ? "running" : `exited (code ${item.exited})`),
  );
  return [
    `Visible terminals owned by this session (${terminals.length}). Output is never included here — read it with terminal_read.`,
    ...rows,
  ].join("\n");
}

function describeInterrupted(terminal: TerminalInfo): string {
  return (
    `Sent Ctrl+C to terminal ${terminal.terminalId}. The terminal stays open and visible; ` +
    "use terminal_read to see where it stopped before deciding what to do next."
  );
}

function describeClosed(terminal: TerminalInfo): string {
  return (
    `Closed terminal ${terminal.terminalId} — its shell was terminated and its output buffer discarded. ` +
    "The tab is gone from the user's panel too."
  );
}
