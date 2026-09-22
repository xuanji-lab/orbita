import { useEffect, useState, type RefObject } from "react";

/**
 * 量出「本侧栏 + chat 主区」的总宽 T（px）——`clampSideWidth` 的第二个参数。
 *
 * 为什么要量两个元素而不是只量 chat：T 必须是**不随本侧栏宽度变化的常量**，
 * 否则夹取会自激。chat 主区（`.pane-main`）是 `flex: 1`，侧栏拿多少它就让多少，
 * 两者之和恒等于这一侧可分配的空间——所以「自己的实际宽 + chat 的实际宽」既是
 * 正确的 T，也天然抗住「落盘值越界、渲染值被夹小」那一步（量的是渲染后的宽，
 * 不是想要的宽；拿 state 去加 chat 会在夹取生效时来回震荡）。
 *
 * 用 ResizeObserver 而不是 window.resize：需要跟的不止窗口——右面板开合会改
 * chat 的宽（于是改左栏的 T）、左栏拖动会改 chat 的宽，这些都不发 resize 事件。
 *
 * `active` 为假（左栏折成图标条、右面板转窄窗覆盖层）时不量也不夹：那两种形态的
 * 宽度是写死的，量出来的 T 只会误导。返回 0 = 量不到，调用方应原样用未夹的宽度。
 */
export function useSideTotalWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
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
