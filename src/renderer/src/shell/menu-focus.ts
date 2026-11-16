/**
 * Menu 的 manageFocus（opt-in）：关菜单后「还不还焦点给触发器」的判断。
 *
 * 在**真正执行 focus 的那一刻**判：焦点在 body（点外面 / 面板被销毁、Esc 关）才还；
 * 焦点已经在别的元素上（菜单项 onSelect 交出去的 autoFocus 输入框、用户点到的别的控件）就不抢。
 * 纯函数，不碰 DOM 全局，可被 node --test 直接加载。
 */
export function shouldReturnFocus(active: Element | null, body: Element): boolean {
  return active === null || active === body;
}
