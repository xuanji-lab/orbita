import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { textRows, textWindow, type TextWindow } from "./preview-view.ts";
import { useRowHeight } from "./useRowHeight.ts";

/**
 * 大文本的窗口化渲染（大文件预览，见 shared/files.ts 的 PREVIEW_WINDOW_LIMIT）：只把
 * 可视区上下各 WINDOW_OVERSCAN 行放进 DOM，滚动时滑动这个窗口——`main.log`、
 * `.bib`、长 `.tex` 这类 600 KB+ 的文件才不至于整篇建 DOM / 整篇重排。
 *
 * 窗口是**按显示行**算的：超过 PREVIEW_ROW_CHARS 的单行先被硬切成多条显示行（`textRows`），
 * 否则一条 minified JSON 那样几十 MB 的行会把整条行盒一次性建出来——32 MB 单行实测
 * 到屏 1.9 s，硬切后 24 ms。当前面板没有行号 gutter，所以「显示行」与「原始行」的差别
 * 只在滚动的总高度上，不影响任何行号语义。
 *
 * **行高必须固定**，所以窗口化一律不折行（`white-space: pre` + 横向滚动，与超过
 * PREVIEW_HIGHLIGHT_LIMIT 的代码同一条规矩）：`pre-wrap` 会让一行占多行高，窗口算出来的
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
  const rows = useMemo(() => textRows(props.text), [props.text]);
  // 行块容器：量行高时用「整块高度 / 行数」（单个元素离视口远时 rect 会被吸附成整数）
  const linesRef = useRef<HTMLDivElement | null>(null);
  const { probeRef, rowHeight } = useRowHeight(linesRef);
  const [win, setWin] = useState<TextWindow>(() => textWindow(rows.length, 0, 0, 0));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  // 换文件：回到顶部，窗口重算（新文件行数不同）。
  // 现实的换文件路径是**重挂载**（FilesPanel 给 FilePreviewPane 挂了 key=path），
  // 所以这条主要管重置滚动位置；软刷新同一个文件（resetKey 不变）不动窗口与位置。
  useEffect(() => {
    const scroller = props.scroller.current;
    if (scroller !== null) scroller.scrollTop = 0;
    setWin(textWindow(rowsRef.current.length, 0, scroller === null ? 0 : scroller.clientHeight, rowHeightRef.current));
  }, [props.scroller, props.resetKey]);

  // 滚动 / 容器尺寸变化 → 只挪窗口，不动 DOM 结构
  useLayoutEffect(() => {
    const scroller = props.scroller.current;
    if (scroller === null) return;
    const recompute = (): void => {
      const next = textWindow(
        rowsRef.current.length,
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
  }, [props.scroller, rowHeight, rows.length]);

  // 底部占位用 totalHeight 撑出来，滚动条长度才与全文一致；行块整体 translateY
  // 到 start 的位置，而不是用顶部占位 div——少一个会随滚动重排的兄弟节点。
  const totalHeight = rows.length * rowHeight;
  return (
    <div className="file-preview-window" style={{ height: totalHeight }}>
      <div className="file-preview-window-probe" ref={probeRef} aria-hidden>
        Ag
      </div>
      <div
        className="file-preview-window-lines"
        ref={linesRef}
        style={{ transform: `translateY(${win.start * rowHeight}px)` }}
      >
        {rows.slice(win.start, win.end).map((row, index) => (
          // 空行也得占一行：给个空格，否则空 div 没有行盒、高度塌成 0
          <div className="file-preview-window-line" key={win.start + index}>
            {row === "" ? " " : row}
          </div>
        ))}
      </div>
    </div>
  );
}
