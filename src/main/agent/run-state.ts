/**
 * 主进程里的两样「agent 运行态」——都是随 agent 事件更新的内存表，不落盘。
 *
 * 1. `SessionPhases`：按 phase 事件维护的活会话状态（哪条会话此刻在跑）。子会话的投递、自动化的
 *    等待送达、会话迁移的「在跑不搬」都靠它判断；手机的「回一句」排在它后面。
 * 2. `AgentEventTap`：agent 事件的订阅点。手机服务要旁听 phase / failed / progress，以前这些
 *    事件只进窗口（`broadcastAgentEvent`），主进程里别处想听只能改泵。
 *
 * 纯模块：不 import electron，可被 `node --test` 直接加载。
 */
import type { SessionPhase } from "@earendil-works/pi-protocol";
import type { AgentEvent } from "../../shared/agent-ipc.ts";

/**
 * 活会话状态表。
 *
 * 继承 Map 是为了不动既有消费者：`ChannelReconciler` 与 `ChannelDeps` 拿的都是
 * `Map<string, SessionPhase>`，其中四处还直接写（派出子会话时先占坑写 `"turn"`、终止后删）。
 * 手机服务拿同一个实例，看到的就是那四处写入之后的真值。
 *
 * 写入方只有事件泵（index.ts）：收到 `phase` 事件就 set；runtime 整个退出时 clear——那时的活跑
 * 状态都不可信了。
 */
export class SessionPhases extends Map<string, SessionPhase> {
  /** 这条会话此刻在不在跑。没记录 = 没在跑 */
  isRunning(sessionId: string): boolean {
    return (this.get(sessionId) ?? "idle") !== "idle";
  }

  /** 此刻不在 idle 的会话 id（runtime 整个退出时拿它做子会话收尾） */
  runningIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, phase] of this) if (phase !== "idle") ids.push(sessionId);
    return ids;
  }
}

/**
 * agent 事件的订阅点。订阅了就不退（订阅者与应用同生命周期；要「忘掉某条会话」由订阅者自己按
 * 事件处理）。监听器抛错只记日志：一个旁听者出错不能拖垮别的事件泵里的处理。
 */
export class AgentEventTap {
  private readonly listeners: ((event: AgentEvent) => void)[] = [];

  subscribe(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  /** 按订阅顺序同步通知每一个监听器 */
  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (cause) {
        console.error("[agent] 事件订阅者处理出错", event.type, cause);
      }
    }
  }
}
