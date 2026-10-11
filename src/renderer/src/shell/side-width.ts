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
