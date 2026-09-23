import { useEffect, useState, type RefObject } from "react";

/**
 * 量 `.pane` 本身的宽度与右栏此刻实际渲染的宽度。
 *
 * - `paneWidth` 是两条比例规则共同的分母 P（`clampRightPanelWidth` 的 [P/3, 2P/3]、
 *   `clampChannelColumnWidth` 的 [P/6, P/3]）：左侧栏右边、右图标条左边的整块，
 *   chat 主区 + 通道列 + 右栏都在里面。
 * - 通道列（子会话 PR4c fix）判断「放不放得下」要的是这两个数一起。
 *
 * **直接量 `.pane`，不拿子级相加**：`.pane` 是 `.layer` 里的一个 flex 项，宽度由
 * 祖先（侧栏宽度、窗口宽度）决定，不被它自己的子级（chat / 通道列 / 右栏）反向
 * 影响——拖任一列时 P 恒定，夹取不会自激；也不会像旧量法「chat 主区渲染宽 + 右栏」
 * 那样漏掉后来插进来的列（2026-09-23：通道列插在两者之间后，右栏的 P 一直少算
 * 一个通道列宽）。用 ResizeObserver 而不是 window.resize：左侧栏拖宽也会改 `.pane`，
 * 那不发 resize 事件。
 *
 * 右栏的宽度直接量 `.right-panel-slot` 的渲染宽——它关着时 CSS 本来就是
 * `width: 0`（`.right-panel-slot` 没有 `.open` class），窄窗覆盖层模式下又是
 * `position: absolute`（不占 flex 空间），两种情况这里量出来天然都是「不该被
 * 减去的量」，调用方不需要再额外判断「右栏开没开 / 是不是覆盖层」。
 *
 * `ref` 传调用方自己树上的任一节点（通道列 / 右栏的根即可）：用它找最近的
 * `.pane` 祖先，再在其中找 `.right-panel-slot`——不需要 App 往下传第二份 ref。
 * 返回 0 = 还没量到，调用方应原样用未夹的宽度。
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
