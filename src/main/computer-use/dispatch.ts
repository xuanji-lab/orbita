/**
 * computerUseRequest 的接线层：**按动作选资源键 → 要租约 → 下发**。
 *
 * 这一层从 index.ts 里拆出来，只为一件事：让「sandbox_* 在别人持桌面时照常下发」这条
 * 回归能被测到。它不碰 electron、不碰沙箱，下发函数是注入的——测试数调用次数就够了。
 *
 * 键的选法（v1.5-2 / 0.9.0 / 0.10.0）：
 *   computer_*  → desktop:exclusive  像素工具共用唯一一块屏幕与前台焦点，必须排队
 *   screenshot + window → **不要租约**  按窗口截图（PrintWindow）读窗口自己的 surface，
 *                          被遮挡也拍得到、不抢焦点，所以多个会话可以各拍各的窗口
 *   uia-*       → **不要租约**        UIA 模式调用直接进控件（AutoSetFocus 已关），
 *                          不移动前台焦点、不依赖桌面现状——写操作也不占桌面
 *   sandbox_*   → browser:<session>  每会话自己的 Edge，永远立刻可用，不占桌面
 *
 * **硬上限的收尾也在这里**：桌面键被 15 分钟强制收回之后，那个会话的下一条命令不该因为
 * 「锁空着」就静默拿到——它已经在一个被判为「占得太久」的轮次里，要让它把这句话转告用户。
 * 只拦一条，说清楚就摘掉标记（否则这个会话以后再也用不了沙箱）。
 *
 * 窗口截图不进这条拦截：它不碰桌面，被收回的也只是一把它没用过的锁。拦截标记留着，
 * 下一条真正的像素命令再消费——「你的桌面操作权被收回了」这句话不能因为中间插了一张
 * 窗口图就消失。
 *
 * UIA 车道（uia-list / uia-act，桥 0.10.0）**同样不取桌面键**，虽然它是写操作：AutoSetFocus
 * 关掉之后，模式调用直接进目标控件，不移动前台焦点、也不依赖「屏幕上现在是什么」。它能
 * 与持着桌面的像素会话共存——这正是拆多个会话并行的意义。与窗口截图同一条边线：
 * 不进过期标记的拦截（它们不碰那把锁）。
 */
import {
  COMPUTER_USE_DESKTOP_KEY,
  COMPUTER_USE_LEASE,
  browserKey,
  computerUseLeaseErrors,
  isUiaRequest,
  isSandboxBrowserAction,
  isWindowScreenshotRequest,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
} from "../../shared/computer-use.ts";
import { runWithLease, type ComputerUseLease } from "./lease.ts";

export interface ComputerUseDispatcherDeps {
  lease: ComputerUseLease;
  /** 会话标题（只是错误文案素材）。读不出就回空串——租约不会塞一对空引号 */
  titleOf: (sessionId: string) => Promise<string>;
  /**
   * 像素通道（desktop:exclusive 之下）与 UIA 车道的执行入口。UIA 请求不取锁，
   * 但执行仍在 runPixels 里（agent-requests 只认一个下发口）。
   */
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
    // 按窗口截图**不占桌面租约**：PrintWindow 读的是目标窗口自己的合成 surface，
    // 被别人完全遮住也拍得到（2026-10-25 真沙箱实测与可见时逐像素一致），也不移动焦点、
    // 不改变前后台。它和「唯一一块屏幕」没有冲突，所以不进队列——这正是本 PR 的产品收益：
    // 多个会话可以同时各拍各的窗口，而不是抢同一个 desktop:exclusive。
    // 放在过期标记之前：这张图不碰桌面，不该被「上一轮占了太久」拦掉一把它没用过的锁。
    if (isWindowScreenshotRequest(request)) {
      return await deps.runPixels(sessionId, request);
    }
    // UIA 车道不占桌面租约：模式调用不移动前台焦点（AutoSetFocus 已关），不依赖桌面现状，
    // 所以它可以与别人持着的 desktop:exclusive 共存。放在过期标记之前：它也不该被
    // 「上一轮占得太久」拦掉一把它没用过的锁（理由同按窗口截图）。
    if (isUiaRequest(request)) {
      return await deps.runPixels(sessionId, request);
    }
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
