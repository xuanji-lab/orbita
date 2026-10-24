/**
 * computerUseRequest 的接线层：**按动作选资源键 → 要租约 → 下发**。
 *
 * 这一层从 index.ts 里拆出来，只为一件事：让「sandbox_* 在别人持桌面时照常下发」这条
 * 回归能被测到。它不碰 electron、不碰沙箱，下发函数是注入的——测试数调用次数就够了。
 *
 * 键的选法（v1.5-2）：
 *   computer_*  → desktop:exclusive  像素工具共用唯一一块屏幕与前台焦点，必须排队
 *   sandbox_*   → browser:<session>  每会话自己的 Edge，永远立刻可用，不占桌面
 *
 * **硬上限的收尾也在这里**：桌面键被 15 分钟强制收回之后，那个会话的下一条命令不该因为
 * 「锁空着」就静默拿到——它已经在一个被判为「占得太久」的轮次里，要让它把这句话转告用户。
 * 只拦一条，说清楚就摘掉标记（否则这个会话以后再也用不了沙箱）。
 */
import {
  COMPUTER_USE_DESKTOP_KEY,
  COMPUTER_USE_LEASE,
  browserKey,
  computerUseLeaseErrors,
  isSandboxBrowserAction,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
} from "../../shared/computer-use.ts";
import { runWithLease, type ComputerUseLease } from "./lease.ts";

export interface ComputerUseDispatcherDeps {
  lease: ComputerUseLease;
  /** 会话标题（只是错误文案素材）。读不出就回空串——租约不会塞一对空引号 */
  titleOf: (sessionId: string) => Promise<string>;
  /** 像素通道（desktop:exclusive 之下） */
  runPixels: (sessionId: string, request: ComputerUseToolRequest) => Promise<ComputerUseToolOutcome>;
  /** 浏览器通道（browser:<session> 之下） */
  runBrowser: (sessionId: string, request: ComputerUseToolRequest) => Promise<ComputerUseToolOutcome>;
}

export interface ComputerUseDispatcher {
  /** 任何路径都返回回执（不抛）：agent 进程里那次工具调用必须被结掉 */
  dispatch(sessionId: string, request: ComputerUseToolRequest): Promise<ComputerUseToolOutcome>;
  /** 桌面键被硬上限收回过：这个会话的下一条命令要看到终态错误 */
  noteHoldExpired(sessionId: string): void;
  /** 会话删了 / 重开了：忘掉它的硬上限标记 */
  forget(sessionId: string): void;
}

export function createComputerUseDispatcher(deps: ComputerUseDispatcherDeps): ComputerUseDispatcher {
  const expiredSessions = new Set<string>();

  const dispatch = async (
    sessionId: string,
    request: ComputerUseToolRequest,
  ): Promise<ComputerUseToolOutcome> => {
    const browser = isSandboxBrowserAction(request.action);
    const key = browser ? browserKey(sessionId) : COMPUTER_USE_DESKTOP_KEY;
    if (expiredSessions.has(sessionId)) {
      expiredSessions.delete(sessionId);
      return { ok: false, error: computerUseLeaseErrors.holdExpired(COMPUTER_USE_LEASE.holdMaxMs / 60_000) };
    }
    const title = await deps.titleOf(sessionId);
    // 这里**只是预检**（拿得到就立刻拿到，拿不到就是排队 / 报错），真正的 acquire 在
    // runWithLease 里——两处都要读同一个标题，所以先读一次 meta 交下去。预检拿到的锁
    // 紧接着被 runWithLease 的 acquire 命中（同一会话幂等续期），不会多占一个位置。
    const preflight = await deps.lease.acquire(key, sessionId, title);
    if (!preflight.ok) return { ok: false, error: preflight.error };
    return await runWithLease({
      lease: deps.lease,
      key,
      sessionId,
      title,
      run: async () =>
        browser
          ? await deps.runBrowser(sessionId, request)
          : await deps.runPixels(sessionId, request),
      rejected: (error) => ({ ok: false, error }),
    });
  };

  return {
    dispatch,
    noteHoldExpired: (sessionId) => expiredSessions.add(sessionId),
    forget: (sessionId) => expiredSessions.delete(sessionId),
  };
}
