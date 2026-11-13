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
      "Open a visible terminal tab the user can watch and type in. Use it for a dev server, watcher, long build " +
      "or slow test run the user wants to see or you may need to stop; when you only need a command's output, " +
      "use the headless bash tool instead. Runs nothing — call terminal_execute next. Before the first " +
      "terminal_* call in a conversation, read the `terminal` skill. Authorized directories for cwd:\n  - " +
      authorized,
    promptSnippet: "Open a visible terminal the user can watch (bash is for silent runs).",
    parameters: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Inside the authorized directories; default: the working directory.",
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
      "Type one complete command line into a visible terminal owned by this session; the user sees it run and " +
      "can interrupt it. Returns at once WITHOUT the output (outputSharedWithAgent: false) — read it with " +
      "terminal_read. Call terminal_list first; never reuse an interactive, long-running or unverified-busy " +
      "terminal (your line would be typed into whatever is running there). Omit terminalId to open a new one.",
    promptSnippet: "Run a command in a visible terminal; read its output with terminal_read.",
    promptGuidelines: [
      "Before every visible terminal command, call terminal_list; never reuse an interactive, long-running, or " +
        "unverified-busy terminal. Before the first terminal_* call in a conversation, read the `terminal` skill.",
      "Use the visible terminal only when the user should watch, it runs long, or you may need to interrupt it; " +
        "for just a command's output use the headless bash tool. No exit-code event — confirm with terminal_read.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The complete command line (typed as one line; no shell wrapper).",
        },
        terminalId: {
          type: "string",
          description: "A safe idle terminal from terminal_list; omit to open a new one.",
        },
        cwd: {
          type: "string",
          description: "Only for a new terminal; inside the authorized directories.",
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
      "Read a visible terminal's buffered output as plain text (latest by default; the result gives the offset " +
      "to page back). Nothing is pushed to you — you must ask. A command has finished when a shell prompt " +
      "follows its output with nothing running. Readable after the shell exits, until the tab is closed.",
    promptSnippet: "Read a visible terminal's output (nothing is pushed to you).",
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "Terminal id." },
        offset: { type: "number", description: "Character offset to start from; omit for the latest output." },
        limit: { type: "number", description: "Max characters, 1–48000 (default 12000)." },
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
      "List this session's visible terminals: id, cwd, shell, running/exited (the shell, not whether a command " +
      "is busy). No output. Call it before every visible terminal command.",
    promptSnippet: "List this session's visible terminals (no output).",
    parameters: { type: "object", properties: {}, required: [] } as never,
    async execute(_toolCallId, _params, signal) {
      return call({ action: "list" }, signal);
    },
  };

  const interrupt: ToolDefinition = {
    name: "terminal_interrupt",
    label: "terminal_interrupt",
    description:
      "Send Ctrl+C to a running terminal of this session to stop its command; the tab stays open. Prefer this " +
      "over terminal_close; confirm with terminal_read.",
    promptSnippet: "Send Ctrl+C to a running terminal.",
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "Terminal id." },
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
      "Close and kill a terminal of this session: its output is discarded and the tab disappears from the " +
      "user's panel. Only close one you no longer need; leave it open if the user may want to look at it.",
    promptSnippet: "Close a terminal once it is no longer needed.",
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "Terminal id." },
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
