/**
 * 每个 tab 此刻该不该绘制、该不该被后台节流 —— 纯决策，sandbox.ts 按结果调
 * `view.setVisible` / `webContents.setBackgroundThrottling`。
 *
 * 为什么要管：所有 tab 都挂在同一个窗口里、铺满同一块区域，「显示哪个」只是 z 序
 * （sandbox.ts 头注释）。被压在下面的视图对 Chromium 来说仍是可见的，页面里的
 * CSS 无限动画、rAF 照样每秒 60 帧地画；而视图建时又关了后台节流（agent 要在后台
 * tab 里干活），浏览器窗口关掉（= 隐藏）后也不停。2026-10-26 实测：用户开着 6 个
 * 带转圈 / 呼吸动画的本地原型页，4 个 tab 渲染进程各吃 10–23% CPU、GPU 进程 25%，
 * 一个半小时 MacBook 明显发烫掉电；关掉这些 tab 立刻凉下来。
 *
 * 规则：
 * - agent 的 tab：照旧一直绘制、不节流。agent 在后台 tab 里导航、截图是常态，
 *   闲置后由 AgentTabLedger 回收，不在这里省。
 * - 用户的 tab，显示中的那个：绘制，但打开后台节流——浏览器窗口隐藏 / 最小化时
 *   Chromium 就会停掉它的动画与计时器（和普通浏览器的后台标签页一样）。
 * - 用户的 tab，没显示：不绘制（setVisible(false)，页面进入 hidden，动画停）。
 * - 例外：agent 正在读某个没显示的用户 tab（browser_extract / observe / screenshot
 *   带 tab 参数）时，操作期间恢复绘制、关节流——没挂出来的视图不出帧，截出来是空的
 *   （sandbox.ts 头注释），读完再收回去。
 */

export interface TabPaintInput {
  owner: "user" | "agent";
  /** 是不是浏览器窗口里正显示的那个 tab（z 序最上） */
  shown: boolean;
  /** 有操作在这个 tab 上排队或执行（runOnTab 的 pending > 0） */
  busy: boolean;
}

export interface TabPaint {
  /** view.setVisible */
  visible: boolean;
  /** webContents.setBackgroundThrottling 的参数：true = 允许后台节流 */
  throttle: boolean;
}

export function tabPaint(input: TabPaintInput): TabPaint {
  if (input.owner === "agent" || input.busy) return { visible: true, throttle: false };
  if (input.shown) return { visible: true, throttle: true };
  return { visible: false, throttle: true };
}
