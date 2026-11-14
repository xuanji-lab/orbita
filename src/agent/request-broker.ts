import type { AgentCommand } from "../shared/agent-ipc.ts";
import { randomUUID } from "node:crypto";

/**
 * agent 工具 → 主进程的 requestId 问答通道（4-3 立，B-1 泛化）。
 *
 * agent 只发带 requestId 的请求事件，主进程调自己的 store 后回命令结掉 promise
 * （permission 问答的同款模式）。消息类型在 shared/agent-ipc.ts，目前三对：
 * skillWriteRequest / mcpWriteRequest / readTaskRequest——本类不认识具体形状，
 * 只管配对、超时与「迟到回执丢弃」。
 *
 * 超时兜底：工具调用不悬死（主进程崩了的话，超时后模型拿到一句人话而不是永远
 * 转圈）。各消息对的失败分支同形（`{ ok: false, error }`），超时值借道它回。
 * 默认 30 秒；调用方可按请求放宽——浏览器导航要等页面加载，30 秒对慢站不够，
 * 而主进程侧有自己更短的超时，这里只是「主进程失联」的兜底。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class RequestBroker {
  private readonly pending = new Map<string, { settle: (result: unknown) => void; timer: NodeJS.Timeout }>();
  private readonly sendEvent: (event: object) => void;

  constructor(sendEvent: (event: object) => void) {
    this.sendEvent = sendEvent;
  }

  /** 发一个请求事件并等回执。结果形状由调用方声明——各消息对的载荷不同。 */
  request<T>(event: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: `主进程没有在 ${Math.round(timeoutMs / 1000)} 秒内回执（进程可能已退出）` } as T);
      }, timeoutMs);
      // 在途请求本身不该让进程活着（agent 进程靠 IPC 端口保活；测试里被中止的长等待不拖住退出）
      timer.unref();
      this.pending.set(requestId, { settle: resolve as (result: unknown) => void, timer });
      this.sendEvent({ ...event, requestId });
    });
  }

  /** runtime 收到 *Result 命令时调这个。超时后到的回执：丢弃。 */
  resolve(requestId: string, result: unknown): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return; // 超时后到的回执：丢弃
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.settle(result);
  }
}

/** 工具请求的回执命令（主进程 → agent 进程，各工具请求事件的应答） */
export type ToolReplyCommand = Extract<
  AgentCommand,
  {
    type:
      | "skillWriteResult"
      | "mcpWriteResult"
      | "readTaskResult"
      | "modelCostsResult"
      | "pluginInstallResult"
      | "pluginListResult"
      | "pluginPreviewResult"
      | "pluginBoardResult"
      | "memoryRecallResult"
      | "memoryToolResult"
      | "browserResult"
      | "slidesResult"
      | "docResult"
      | "terminalResult"
      | "delegateResult"
      | "automationResult"
      | "channelSendResult";
  }
>;

const TOOL_REPLY_TYPES: ReadonlySet<string> = new Set<ToolReplyCommand["type"]>([
  "skillWriteResult",
  "mcpWriteResult",
  "readTaskResult",
  "modelCostsResult",
  "pluginInstallResult",
  "pluginListResult",
  "pluginPreviewResult",
  "pluginBoardResult",
  "memoryRecallResult",
  "memoryToolResult",
  "browserResult",
  "slidesResult",
  "docResult",
  "terminalResult",
  "delegateResult",
  "automationResult",
  "channelSendResult",
]);

export function isToolReply(command: AgentCommand): command is ToolReplyCommand {
  return TOOL_REPLY_TYPES.has(command.type);
}

/**
 * 回执 → 在途工具调用认的结果形状。**两个内核共用这一份翻法**（旧内核 runtime.ts 的命令分支、新内核
 * kernel-runtime.ts 的 agent 命令）：多数回执形状即契约原样给，几种要补默认错误文案或挑字段。
 */
export function toolReplyResult(command: ToolReplyCommand): unknown {
  switch (command.type) {
    case "skillWriteResult":
      return command.ok
        ? { ok: true, ...(command.path === undefined ? {} : { path: command.path }) }
        : { ok: false, error: command.error ?? "Write failed" };
    case "mcpWriteResult":
      return command.ok
        ? { ok: true, ...(command.status === undefined ? {} : { status: command.status }) }
        : { ok: false, error: command.error ?? "Write failed" };
    case "readTaskResult":
      return command.ok
        ? { ok: true, card: command.card, text: command.text }
        : { ok: false, error: command.error ?? "Read failed" };
    case "browserResult":
      return command.ok
        ? {
            ok: true,
            text: command.text,
            card: command.card,
            ...(command.image === undefined ? {} : { image: command.image }),
          }
        : { ok: false, error: command.error ?? "Browser request failed" };
    case "delegateResult":
      return command.ok
        ? { ok: true, childId: command.childId, title: command.title, card: command.card }
        : { ok: false, error: command.error ?? "Delegate failed" };
    case "channelSendResult":
      return command.ok
        ? { ok: true, messageId: command.messageId }
        : { ok: false, error: command.error ?? "Send failed" };
    default:
      // 派发参考 / 插件 / 记忆召回与记忆工具 / 演示文稿与文档导出 / 终端 / 自动化：形状即契约（ok 双分支），原样给
      return command;
  }
}
