/**
 * 窗口是否处于「不该有持续动效」的状态：失焦，或者标签页/窗口整体不可见。
 *
 * 为什么要做这件事：去掉 backdrop blur 之后 GPU 数字降了一截，但只要屏上还有一处在动的
 * 像素，窗口每帧仍要整窗重新合成（vibrancy 没关）——实测 1 个转圈与 5 个转圈耗一样多，
 * 唯一能再省的是「窗口不在前台时干脆停」。
 *
 * 判定拆成纯函数，方便测：真正挂事件、写 DOM 属性的部分在 `watchWindowActivity`
 * 里，不测——它只是把这个判定接到 blur/focus/visibilitychange 上。
 */
export function isWindowInactive(state: {
  hasFocus: boolean;
  visibilityState: DocumentVisibilityState;
}): boolean {
  return !state.hasFocus || state.visibilityState === "hidden";
}

/** `document.documentElement` 上的标记属性名（写作 `data-window-inactive`）。 */
const INACTIVE_ATTR = "windowInactive";

function applyWindowActivity(): void {
  const inactive = isWindowInactive({
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
  });
  if (inactive) document.documentElement.dataset[INACTIVE_ATTR] = "true";
  else delete document.documentElement.dataset[INACTIVE_ATTR];
}

/**
 * 挂接窗口活跃度监听，全局只调一次（`main.tsx`，`createRoot` 之前）。
 * `styles.css` 用 `[data-window-inactive="true"]` 暂停持续动效（`.anim-continuous`
 * 与 `.orbita-breath`）。
 */
export function watchWindowActivity(): void {
  applyWindowActivity();
  window.addEventListener("blur", applyWindowActivity);
  window.addEventListener("focus", applyWindowActivity);
  document.addEventListener("visibilitychange", applyWindowActivity);
}
