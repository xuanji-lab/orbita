import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 侧栏列表的滚动边：
 * - gap：滚动条占的宽（offsetWidth − clientWidth）。列表把右内边距减掉这么多，滚动条就落在原来的右留白里，
 *   内容右缘不因出现滚动条而左移（行尾血线不动）；没有滚动条时 gap = 0；
 * - fade：下面还有内容没滚到——列表底部渐隐，最后一行不会被切一半还像完整的一行。
 * 纯判定在 scrollEdges（有测试）；这里只量 DOM、接事件。
 */
export interface ScrollEdges {
  gap: number;
  fade: boolean;
}

export function scrollEdges(box: { offsetWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTop: number }): ScrollEdges {
  const overflowing = box.scrollHeight - box.clientHeight > 1;
  return {
    gap: Math.max(0, box.offsetWidth - box.clientWidth),
    // 距底不到 4px 视为到底
    fade: overflowing && box.scrollHeight - box.clientHeight - box.scrollTop > 4,
  };
}

export function useScrollEdges(enabled: boolean): { ref: (el: HTMLDivElement | null) => void; edges: ScrollEdges; onScroll: () => void } {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ gap: 0, fade: false });
  const measure = useCallback(() => {
    const el = elRef.current;
    if (el === null) return;
    const next = scrollEdges(el);
    setEdges((current) => (current.gap === next.gap && current.fade === next.fade ? current : next));
  }, []);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      if (el !== null) measure();
    },
    [measure],
  );
  useEffect(() => {
    const el = elRef.current;
    if (!enabled || el === null) {
      setEdges((current) => (current.gap === 0 && !current.fade ? current : { gap: 0, fade: false }));
      return;
    }
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    // 内容增减（行变多 / 变少）不触发容器尺寸变化：看子树
    const mutation = new MutationObserver(schedule);
    mutation.observe(el, { childList: true, subtree: true });
    measure();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [enabled, measure]);
  return { ref, edges, onScroll: measure };
}
