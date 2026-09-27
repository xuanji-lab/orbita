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
