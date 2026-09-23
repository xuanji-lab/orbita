import { useEffect, useState, type RefObject } from "react";

/**
 * 量出 pane 的总宽 P（px）——「chat 主区 + 右栏」之和，`clampRightPanelWidth` 的
 * 第二个参数。**左侧栏不在其中**：它走固定像素区间，比例规则只约束 chat 与右栏
 * 这一对（2026-09-22 wafo 澄清）。
 *
 * 为什么要量两个元素而不是只量 chat：P 必须是**不随右栏宽度变化的常量**，
 * 否则夹取会自激。chat 主区（`.pane-main`）是 `flex: 1`，右栏拿多少它就让多少，
 * 两者之和恒等于 pane 可分配的空间——所以「自己的实际宽 + chat 的实际宽」既是
 * 正确的 P，也天然抗住「落盘值越界、渲染值被夹小」那一步（量的是渲染后的宽，
 * 不是想要的宽；拿 state 去加 chat 会在夹取生效时来回震荡）。
 *
 * 用 ResizeObserver 而不是 window.resize：需要跟的不止窗口——左侧栏拖宽会改 chat
 * 的宽（于是改 P）、右栏自己拖动也会改 chat 的宽，这些都不发 resize 事件。
 *
 * `active` 为假（右栏转窄窗覆盖层）时不量也不夹：那种形态的宽度是写死的，
 * 量出来的 P 只会误导。返回 0 = 量不到，调用方应原样用未夹的宽度。
 */
export function usePaneTotalWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!active) {
      setTotal(0);
      return;
    }
    const own = ref.current;
    if (own === null) return;
    // 定位基准是 `.layer`（壳里只有一个 chat 主区）；跨过它去全局搜会捞到别的树
    const chat = own.closest(".layer")?.querySelector<HTMLElement>(".pane-main") ?? null;
    if (chat === null) return;
    const measure = (): void => {
      const next = Math.round(
        own.getBoundingClientRect().width + chat.getBoundingClientRect().width,
      );
      // 同值不写：夹取引起的第二次回调量到的是同一个和，写下去只会多一帧
      setTotal((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(own);
    observer.observe(chat);
    return () => observer.disconnect();
  }, [ref, active]);
  return total;
}

/**
 * 通道列（子会话 PR4b/PR4c fix）判断「放不放得下」要用的两个数：`.pane` 本身
 * 的宽度、与右栏此刻实际渲染的宽度。
 *
 * **不能复用上面 `usePaneTotalWidth` 的量法**：那个函数量的是「chat 主区实际
 * 渲染宽 + 右栏」，chat 主区的渲染宽本身会因为通道列当前占不占空间而变化——
 * 拿它来判断「通道列该不该占空间」是自己问自己的答案在问自己。这里改成直接量
 * `.pane` 自己：它是 `.layer` 里的一个 flex 项，宽度由祖先（侧栏宽度、窗口宽度）
 * 决定，不被它自己的子级（chat / 通道列 / 右栏）反向影响，天然不自指。
 *
 * 右栏的宽度同样直接量 `.right-panel-slot` 的渲染宽——它关着时 CSS 本来就是
 * `width: 0`（`.right-panel-slot` 没有 `.open` class），窄窗覆盖层模式下又是
 * `position: absolute`（不占 flex 空间），两种情况这里量出来天然都是「不该被
 * 减去的量」，调用方不需要再额外判断「右栏开没开 / 是不是覆盖层」。
 *
 * `ref` 传调用方自己树上的任一节点（通道列的根 div 即可）：用它找最近的 `.pane`
 * 祖先，再在其中找 `.right-panel-slot`——同 `usePaneTotalWidth` 的 `closest` /
 * `querySelector` 套路，不需要 App 往下传第二份 ref。
 */
export function usePaneAndRightPanelWidth(ref: RefObject<HTMLElement | null>): {
  paneWidth: number;
  rightPanelWidth: number;
} {
  const [size, setSize] = useState({ paneWidth: 0, rightPanelWidth: 0 });
  useEffect(() => {
    const own = ref.current;
    if (own === null) return;
    const pane = own.closest(".pane");
    if (pane === null) return;
    const rightPanel = pane.querySelector<HTMLElement>(".right-panel-slot");
    const measure = (): void => {
      const paneWidth = Math.round(pane.getBoundingClientRect().width);
      const rightPanelWidth = rightPanel === null ? 0 : Math.round(rightPanel.getBoundingClientRect().width);
      setSize((current) =>
        current.paneWidth === paneWidth && current.rightPanelWidth === rightPanelWidth
          ? current
          : { paneWidth, rightPanelWidth },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    if (rightPanel !== null) observer.observe(rightPanel);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
