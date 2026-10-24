import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { textLines, textWindow, type TextWindow } from "./preview-view.ts";

/**
 * 大文本的窗口化渲染（大文件预览，见 preview-view.ts 的 WINDOW_TEXT_LIMIT）：只把
 * 可视区上下各 WINDOW_OVERSCAN 行放进 DOM，滚动时滑动这个窗口——`main.log`、
 * `.bib`、长 `.tex` 这类 600 KB+ 的文件才不至于整篇建 DOM / 整篇重排。
 *
 * **行高必须固定**，所以窗口化一律不折行（`white-space: pre` + 横向滚动，与超过
 * HIGHLIGHT_LIMIT 的代码同一条规矩）：`pre-wrap` 会让一行占多行高，窗口算出来的
 * 位置与实际排版对不上，滚动就会漂。行高由 CSS 决定（`--font-size-sm` ×
 * `--line-height-code-block`，随界面字号缩放），所以首帧先量一次探针，量到之前
 * 只渲染首屏 + overscan，绝不先全渲染再收。
 *
 * 滚动监听挂在**外层滚动容器**（`.file-preview-body`）上——窗口化不改滚动层，
 * 滚动条、面板内边距与其它预览形态保持一致。窗口没变时不 setState：滚动事件
 * 每帧都来，每次都重渲 400 行会把滚动本身变卡。
 */
export function WindowedText(props: {
  text: string;
  /** 外层滚动容器（`.file-preview-body`）；滚动位置与视口高度都从它读 */
  scroller: RefObject<HTMLDivElement | null>;
  /** 换文件时重置滚动与窗口（软刷新同文件时不重置，滚动位置要保留） */
  resetKey: string;
}) {
  const lines = useMemo(() => textLines(props.text), [props.text]);
  const [rowHeight, setRowHeight] = useState(0);
  const [win, setWin] = useState<TextWindow>(() => textWindow(lines.length, 0, 0, 0));
  const probeRef = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  // 量行高：探针与正文行同一套字体 / 行高，量出来的就是一行的高度。行高由
  // `--ui-font-size` 派生，**界面字号一改它就会变**——所以用 ResizeObserver 盯住探针，
  // 尺寸一变就重新量：总高度（= 行数 × 行高）与 translateY 都按行高算，行高留着旧值
  // 会让滚动条长度与滚动位置一起漂。
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe === null) return;
    const measure = (): void => {
      const measured = probe.getBoundingClientRect().height;
      if (measured <= 0) return;
      setRowHeight((prev) => (Math.abs(measured - prev) > 0.5 ? measured : prev));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);

  // 换文件：回到顶部，窗口重算（新文件行数不同）。
  // 现实的换文件路径是**重挂载**（FilesPanel 给 FilePreviewPane 挂了 key=path），
  // 所以这条主要管重置滚动位置；软刷新同一个文件（resetKey 不变）不动窗口与位置。
  useEffect(() => {
    const scroller = props.scroller.current;
    if (scroller !== null) scroller.scrollTop = 0;
    setWin(textWindow(linesRef.current.length, 0, scroller === null ? 0 : scroller.clientHeight, rowHeightRef.current));
  }, [props.scroller, props.resetKey]);

  // 滚动 / 容器尺寸变化 → 只挪窗口，不动 DOM 结构
  useLayoutEffect(() => {
    const scroller = props.scroller.current;
    if (scroller === null) return;
    const recompute = (): void => {
      const next = textWindow(
        linesRef.current.length,
        scroller.scrollTop,
        scroller.clientHeight,
        rowHeightRef.current,
      );
      setWin((prev) =>
        prev.start === next.start && prev.end === next.end && prev.totalLines === next.totalLines
          ? prev
          : next,
      );
    };
    recompute();
    scroller.addEventListener("scroll", recompute, { passive: true });
    const observer = new ResizeObserver(recompute);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", recompute);
      observer.disconnect();
    };
  }, [props.scroller, rowHeight, lines.length]);

  // 底部占位用 totalHeight 撑出来，滚动条长度才与全文一致；行块整体 translateY
  // 到 start 的位置，而不是用顶部占位 div——少一个会随滚动重排的兄弟节点。
  const totalHeight = lines.length * rowHeight;
  return (
    <div className="file-preview-window" style={{ height: totalHeight }}>
      <div className="file-preview-window-probe" ref={probeRef} aria-hidden>
        Ag
      </div>
      <div
        className="file-preview-window-lines"
        style={{ transform: `translateY(${win.start * rowHeight}px)` }}
      >
        {lines.slice(win.start, win.end).map((line, index) => (
          // 空行也得占一行：给个空格，否则空 div 没有行盒、高度塌成 0
          <div className="file-preview-window-line" key={win.start + index}>
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    </div>
  );
}
