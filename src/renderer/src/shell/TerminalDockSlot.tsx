import { useEffect, useRef, useState } from "react";
import { clampTerminalHeight, TERMINAL_DOCK_HEIGHT_DEFAULT } from "@shared/settings";
import { useT } from "../locale.ts";

/**
 * 底部终端停靠壳（RightPanelSlot 的纵向镜像）：终端停靠在底部时横跨**对话区
 * 下方**（`.pane-col` = chat 主区 + 底部终端，与右栏并排——不跨侧栏、不跨右栏）。
 * 高度变量 `--terminal-dock-h` 由本壳注入，开合只有一条 height 过渡路径
 * （同 .right-panel-slot 的机制）；内容固定高，动画期间只被「拉下」不 reflow。
 *
 * 拖高热区骑在顶缘横线上（同右栏左缘竖线的做法）：拖动中禁过渡实时跟手、
 * 双击回默认 260；区间见 clampTerminalHeight（上限 pane 高度 2/3，地板 160）。
 * 高度**渲染时也夹一次**——盘上的值可能是在更高的窗口存下的，只夹渲染值、
 * 不回写 settings。
 */
export function TerminalDockSlot(props: {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onHeightCommit: (height: number) => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const { open } = props;
  const hostRef = useRef<HTMLElement | null>(null);
  /** 拖高中禁掉 height 过渡——实时跟手（同 .drawer / .right-panel-slot 的纪律） */
  const [resizing, setResizing] = useState(false);
  /** 可用高度（pane-col，不随终端高度变——chat 主区是 flex:1，终端拿多少它让多少） */
  const [paneHeight, setPaneHeight] = useState(0);
  const height = paneHeight > 0 ? clampTerminalHeight(props.height, paneHeight) : props.height;

  // 量 pane-col（父元素）的高度作夹取基准。ResizeObserver 而不是 window.resize：
  // 左栏拖宽不改它，但窗口缩放、右栏开合引起的换行都会改 chat 高度，这些不算
  // 全量 resize。同值不写，防夹取自激的第二次回调多渲一帧。
  useEffect(() => {
    const host = hostRef.current;
    const column = host?.parentElement ?? null;
    if (column === null) return;
    const measure = (): void => {
      const next = Math.round(column.getBoundingClientRect().height);
      setPaneHeight((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  /** 拖高：上移变高。paneHeight 拖动中恒定（chat 让多少终端就长多少），不必每帧重测 */
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const panel = hostRef.current;
    if (panel === null) return;
    event.preventDefault();
    setResizing(true);
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const clamp = (value: number): number => clampTerminalHeight(value, paneHeight);
    // 拖动期间全文选择与光标都固定成拖拽语义，松手还原
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const move = (ev: PointerEvent): void => {
      props.onHeightChange(clamp(startHeight - (ev.clientY - startY)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      props.onHeightCommit(clamp(startHeight - (ev.clientY - startY)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <section
      ref={hostRef}
      className={`terminal-dock-slot${open ? " open" : ""}${resizing ? " dragging" : ""}`}
      style={{ "--terminal-dock-h": `${height}px` } as React.CSSProperties}
    >
      {/* 拖高热区：顶缘 6px 骑在横线上；双击回 260。只在展开时给（收起动画期间
          高度归零，把手没有可拖的语义） */}
      {open && (
        <span
          className="terminal-dock-resizer no-drag"
          onPointerDown={startResize}
          onDoubleClick={() =>
            props.onHeightCommit(clampTerminalHeight(TERMINAL_DOCK_HEIGHT_DEFAULT, paneHeight))
          }
          title={t.common.dragResizeHeight}
        />
      )}
      <div className="terminal-dock-inner">{props.children}</div>
    </section>
  );
}
