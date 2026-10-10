import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { TerminalToolOutcome, TerminalToolRequest } from "../shared/terminal.ts";

/**
 * agent 的终端工具组（PR2）：terminal_open / execute / read / list / interrupt / close。
 *
 * 形态取 Proma 的 `buildAgentTerminalTools`（6 个工具、输出拉取式），落地在本仓的
 * broker 先例上（browser-tools.ts 同款）：这一层**只是翻译**——参数 → terminalRequest →
 * 等 terminalResult → pi 工具结果。PTY、快照缓冲、所有权校验、cwd 授权全在主进程
 * （main/terminal/），agent 进程不碰 node-pty 也不碰 userData。
 *
 * 三条设计决定，改之前先读：
 *
 * 1. **执行结果不带输出**。`terminal_execute` 写完命令就返回，结果里明确
 *    `outputSharedWithAgent: false`。理由：可见终端是给**用户**看的通道，长驻命令
 *    （dev server、watch）永远不结束，等它「跑完」会把 agent 的一轮挂死；要结果用
 *    headless bash（输出直接进上下文）。两个通道职责不重叠，不给 execute 加等待模式。
 * 2. **复用纪律走 promptGuidelines，不走代码**。代码层只强制所有权与 running；
 *    「先用哪个终端」是判断不是规则（Proma 在这里踩过坑：不约束的话模型每条命令开
 *    一个新 tab）。所以纪律写在给模型看的地方，代码只保证写不进去错的终端。
 * 3. **终端必须可见**。主进程在开终端时广播 terminal:agent-open，renderer 自动点亮
 *    面板——agent 在用户眼前干活，人随时能接手敲键盘。没有用户在场的来源（定时任务、
 *    委派）根本不该有这套工具，见 runtime.ts 的注册处。
 */

/** 六个工具的名字。权限档描述（describePermissionMode）与测试都认这一份 */
export const TERMINAL_TOOL_NAMES = [
  "terminal_open",
  "terminal_execute",
  "terminal_read",
  "terminal_list",
  "terminal_interrupt",
  "terminal_close",
] as const;

/** 开轮时由 runtime 给的会话上下文：授权目录清单（cwd + 附加目录）与解析基准 */
export interface TerminalToolContext {
  /** 会话 cwd：相对 cwd 的解析基准，也是 cwd 缺席时终端开在哪 */
  cwd: string;
  /** 会话授权目录（cwd + 附加目录）。**只告知**：硬校验在主进程（agent-policy.ts） */
  authorizedDirs: readonly string[];
}

/** 铸工具组。broker 由 runtime 持有并接回执；这里只包 execute 的翻译。 */
export function createTerminalTools(
  broker: RequestBroker,
  sessionId: string,
  context: TerminalToolContext,
): ToolDefinition[] {
  const roots = context.authorizedDirs.length > 0 ? context.authorizedDirs : [context.cwd];
  const authorized = roots.join("\n  - ");

  /**
   * 发请求并等回执；**这一轮被停掉（signal abort）就立刻放手**——pi 等工具返回才结束
   * 一轮，不放手的话「停止」按钮在慢动作上会失灵（browser-tools.ts 同款）。
   */
  const call = async (request: TerminalToolRequest, signal: AbortSignal | undefined) => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<TerminalToolOutcome>({ type: "terminalRequest", sessionId, request });
    const result =
      signal === undefined
        ? await pending
        : await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
            ),
          ]);
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: "text" as const, text: result.text }], details: undefined };
  };

  /** 非空字符串才算给了（模型常传 "" 表示「没有」） */
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  /** 模型偶尔把数字写成字符串（"120"）：认；其余一律当没给 */
  const number = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  };

  const open: ToolDefinition = {
    name: "terminal_open",
    label: "terminal_open",
    description:
      "Open a visible terminal tab in Orbita's terminal panel — the user sees it and can type in it at any " +
      "time. Use it when a command should run where the user can watch it and take over (a dev server, a long " +
      "build, something you may need to interrupt), not to run commands silently. It opens an interactive " +
      "shell and runs nothing; call terminal_execute to run a command. Authorized directories for cwd:\n  - " +
      authorized,
    promptSnippet:
      "Open a visible terminal the user can watch and take over. Not for silently running commands — use the " +
      "headless bash tool when you only need a command's output.",
    parameters: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Absolute, or relative to the session's working directory. It must resolve inside the session's " +
            "authorized directories (listed above); anything else fails. Omit to use the session's working directory.",
        },
      },
      required: [],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      return call({ action: "open", ...(text(args["cwd"]) === undefined ? {} : { cwd: text(args["cwd"]) }) }, signal);
    },
  };

  const execute: ToolDefinition = {
    name: "terminal_execute",
    label: "terminal_execute",
    description:
      "Write one complete command line into a visible terminal owned by this session and start it — the user " +
      "sees it run and can interrupt it. Returns as soon as the line is written: the command's output is never " +
      "included in this result (outputSharedWithAgent: false), so call terminal_read with the returned " +
      "terminalId to see it. Pass terminalId to reuse a safe existing terminal; omit it to open a new one at " +
      "an authorized cwd.",
    promptSnippet:
      "Run a user-attended command in a visible terminal; its output is never returned — read it with " +
      "terminal_read.",
    promptGuidelines: [
      "Before every visible terminal command, call terminal_list and prefer a current-session terminal that is " +
        "still running, whose cwd matches, and whose previous command you observed finish. Pass its terminalId " +
        "instead of opening another tab.",
      "Do not reuse an interactive, long-running, or unverified-busy terminal: your command would be typed into " +
        "whatever is running there.",
      "Omit terminalId only when no safe candidate exists, the cwd must differ, or the user needs a separately " +
        "visible concurrent session.",
      "The visible terminal is not for silently running commands: when you only need a command's output, use the " +
        "headless bash tool. Use the visible terminal when the user should watch it, when it runs long, or when " +
        "you may need to interrupt it.",
      "terminal_execute returns as soon as the line is written — there is no exit-code callback. Confirm " +
        "completion with terminal_read.",
      "When you have finished checking your own work, leave the terminal open: the user often wants to look at " +
        "it themselves.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The complete command to run in the shell. Do not prepend shell wrappers — it is typed as one line " +
            "and submitted with Enter.",
        },
        terminalId: {
          type: "string",
          description:
            "Preferred when a matching safe current-session terminal is available. Inspect candidates with " +
            "terminal_list first; do not reuse an interactive, long-running, or unverified-busy terminal. Omit " +
            "to open a new terminal.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute, or relative to the session's working directory. Used only when opening a new terminal " +
            "(no terminalId); it must resolve inside the session's authorized directories.",
        },
      },
      required: ["command"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const command = text(args["command"]);
      if (command === undefined) throw new Error("command is required — pass the complete command line.");
      const terminalId = text(args["terminalId"]);
      const cwd = text(args["cwd"]);
      return call(
        {
          action: "execute",
          command,
          ...(terminalId === undefined ? {} : { terminalId }),
          ...(cwd === undefined ? {} : { cwd }),
        },
        signal,
      );
    },
  };

  const read: ToolDefinition = {
    name: "terminal_read",
    label: "terminal_read",
    description:
      "Read the buffered output of a visible terminal owned by this session as plain text (terminal control " +
      "sequences stripped). By default returns the last 12,000 characters; use offset and limit to page " +
      "(limit at most 48,000). Nothing is ever pushed to you — you have to ask for it. You can still read a " +
      "terminal after its shell exits, as long as the tab has not been closed.",
    promptSnippet: "Read a visible terminal's output as plain text. Nothing is pushed to you — ask for it.",
    promptGuidelines: [
      "After starting a visible terminal command, call terminal_read whenever you need its result or need to " +
        "confirm it finished. A shell prompt with nothing running after it means the previous command finished; " +
        "there is no exit-code event.",
      "Start with the default tail. The result tells you the total length and the offset to continue from.",
    ],
    parameters: {
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          description: "Terminal id returned by terminal_open, terminal_execute, or terminal_list.",
        },
        offset: {
          type: "number",
          description:
            "Character offset in the plain-text view to start from. Omit to read the latest output. Negative " +
            "values are clamped to 0.",
        },
        limit: {
          type: "number",
          description: "Maximum characters to return, 1–48000. Defaults to 12000. Larger values are clamped.",
        },
      },
      required: ["terminalId"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const terminalId = text(args["terminalId"]);
      if (terminalId === undefined) throw new Error("terminalId is required.");
      const offset = number(args["offset"]);
      const limit = number(args["limit"]);
      return call(
        {
          action: "read",
          terminalId,
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
        },
        signal,
      );
    },
  };

  const list: ToolDefinition = {
    name: "terminal_list",
    label: "terminal_list",
    description:
      "List the visible terminals this session owns, with cwd, shell and running/exited state. It never " +
      "includes output. Call it before every visible terminal command to find a safe terminal to reuse.",
    promptSnippet:
      "List the visible terminals this session owns (never their output) — call it before every visible " +
      "terminal command.",
    parameters: { type: "object", properties: {}, required: [] } as never,
    async execute(_toolCallId, _params, signal) {
      return call({ action: "list" }, signal);
    },
  };

  const interrupt: ToolDefinition = {
    name: "terminal_interrupt",
    label: "terminal_interrupt",
    description:
      "Send Ctrl+C to a running terminal owned by this session. The terminal stays open and visible; use " +
      "terminal_read to see where it stopped.",
    promptSnippet: "Send Ctrl+C to one of this session's running terminals.",
    parameters: {
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          description: "Terminal id returned by terminal_open, terminal_execute, or terminal_list.",
        },
      },
      required: ["terminalId"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const terminalId = text(args["terminalId"]);
      if (terminalId === undefined) throw new Error("terminalId is required.");
      return call({ action: "interrupt", terminalId }, signal);
    },
  };

  const close: ToolDefinition = {
    name: "terminal_close",
    label: "terminal_close",
    description:
      "Close and terminate a terminal owned by this session — its shell is killed, its output buffer is " +
      "discarded, and the tab disappears from the user's panel. Only close a terminal you no longer need.",
    promptSnippet: "Close one of this session's terminals once it is no longer needed.",
    parameters: {
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          description: "Terminal id returned by terminal_open, terminal_execute, or terminal_list.",
        },
      },
      required: ["terminalId"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const terminalId = text(args["terminalId"]);
      if (terminalId === undefined) throw new Error("terminalId is required.");
      return call({ action: "close", terminalId }, signal);
    },
  };

  return [open, execute, read, list, interrupt, close];
}
