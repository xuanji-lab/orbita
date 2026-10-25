import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 量一行代码文本的高度（窗口化渲染共用的那一份）。
 *
 * 行高由 CSS 决定（`--font-size-sm` × `--line-height-code-block`，随界面字号缩放），
 * 而总高度、`translateY`、滚动位置 ↔ 行号全靠它——差一像素，滚到文件中部就会差出几百行，
 * 所以这里必须量准。三处容易量错的地方（都踩过）：
 *
 * 1. **不能量单个元素**：元素离视口很远时（分段预览默认落在 100 万行文件的末尾，
 *    `translateY` 把探针推到两千万像素之外），Chromium 会把它的 rect 吸附成整数
 *    ——同一个探针，在顶部量到 18.59375，在末尾量到 18（实测）。差 0.59 px/行
 *    乘以一百万行就是几万行。
 * 2. **量整块再除以行数**：`rowsRef` 指向的是装着当前窗口所有行的容器（`.file-preview-window-lines`），
 *    它的高度 = 行数 × 行高，吸附误差（≤1 px）被行数除掉：600 行时误差 0.002 px/行。
 * 3. **探针不一定在首帧就在**，也**不一定第一帧就量得准**（窗口还没到、容器高度为 0）：
 *    所以每次渲染都看一眼，节点换了就改挂观察器，拿到更准的值就更新。
 *
 * `rowHeight === 0` 表示还没量出来，调用方此时只渲染空的高度容器。
 */
export function useRowHeight(sampleRef?: RefObject<HTMLElement | null>): {
  probeRef: RefObject<HTMLDivElement | null>;
  rowHeight: number;
} {
  const [rowHeight, setRowHeight] = useState(0);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<Element[]>([]);

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe === null) return;
    const sample = sampleRef?.current ?? null;
    const targets = sample === null ? [probe] : [probe, sample];
    const same =
      observedRef.current.length === targets.length &&
      targets.every((node, at) => observedRef.current[at] === node);

    const measure = (): void => {
      const rows = sample?.childElementCount ?? 0;
      // 两行以上才用整块平均：一行时吸附误差没法被除掉
      const fromBlock = sample !== null && rows >= 2 ? sample.getBoundingClientRect().height / rows : 0;
      const measured = fromBlock > 0 ? fromBlock : probe.getBoundingClientRect().height;
      if (!(measured > 0)) return;
      setRowHeight((prev) => (Math.abs(measured - prev) > 0.5 ? measured : prev));
    };
    // 节点没换也要量一次：上一次可能是在行还很少 / 位置很远的时候量的
    measure();
    if (same) return;

    observerRef.current?.disconnect();
    const observer = new ResizeObserver(measure);
    for (const node of targets) observer.observe(node);
    observerRef.current = observer;
    observedRef.current = targets;
  });

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { probeRef, rowHeight };
}
