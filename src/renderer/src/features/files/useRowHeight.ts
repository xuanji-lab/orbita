import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 量一行代码文本的高度（窗口化渲染共用的那一份）。
 *
 * 行高由 CSS 决定（`--font-size-sm` × `--line-height-code-block`，随界面字号缩放），
 * 所以调用方把探针 div 渲染在自己的内容里、用 `probeRef` 挂上，量一次；行高变了
 * 整个窗口都会错位（总高度、translateY 都按行高算），因此用 ResizeObserver 盯住探针。
 *
 * 探针必须是**一行**、且与正文行同一套字体 / 行高，量出来的值才等于一行的高度——
 * 样式见 `.file-preview-window-probe`。`rowHeight === 0` 表示还没量出来，调用方此时
 * 只渲染首屏 + overscan，绝不先全渲染再收。
 *
 * **探针不一定在首帧就在**：分段预览（RangeTextPreview）在行索引回来之前渲染的是
 * 加载态，探针要等索引就绪才出现。所以这里不能只在挂载时量一次——每次渲染都看一眼
 * 探针，第一次拿到节点时才挂观察器（换成别的节点时改挂新的）。
 */
export function useRowHeight(): { probeRef: RefObject<HTMLDivElement | null>; rowHeight: number } {
  const [rowHeight, setRowHeight] = useState(0);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe === null || observedRef.current === probe) return;
    const measure = (): void => {
      const measured = probe.getBoundingClientRect().height;
      if (measured <= 0) return;
      setRowHeight((prev) => (Math.abs(measured - prev) > 0.5 ? measured : prev));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    observerRef.current?.disconnect();
    observerRef.current = observer;
    observedRef.current = probe;
  });

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { probeRef, rowHeight };
}
