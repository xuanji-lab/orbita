/**
 * 拆分条（论文工作台的几处边界共用）：竖条 = 左右分栏，横条 = 上下分栏。
 *
 * 为什么是 v4.5.1 之外新加的一层：侧栏 / 右栏那两条把手各自写死在组件里，
 * 而这一次要加四处（源码↔PDF、布局 B 对话栏、问题抽屉、PPT 页列表），
 * 四处的最小宽、存什么单位、双击复位目标都不一样——共用的是**交互与可访问性**，
 * 不是几何。所以这里只管事件：拖动走 `pointer-drag.ts`（iframe 收尾的坑已在
 * 那一层处理过），键盘 ±8 / Shift ±32、Home/End、Enter 与双击复位。
 * 限位与落盘由调用方按自己的单位做（`split-limits.ts` 是那几组数字的家）。
 */
import { useRef } from "react";
import { startPointerDrag } from "./pointer-drag.ts";

/** 方向键的一步（px）；按住 Shift 时是 4 倍 */
const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;

export interface SplitHandleProps {
  /** 竖条 = 左右分栏（col-resize），横条 = 上下分栏（row-resize） */
  orientation: "vertical" | "horizontal";
  /** 读屏名与悬停提示（从 locale 取，不用裸中文） */
  label: string;
  /** 开始拖（量起点用；没量到起点的调用方可以不给） */
  onDragStart?: () => void;
  /** 拖动中：正数 = 指针向右 / 向下 */
  onDrag: (delta: number) => void;
  /** 松手（落盘）；正数同 onDrag */
  onDragEnd: (delta: number) => void;
  /** 方向键：正数 = 把手向右 / 向下移动 */
  onStep: (delta: number) => void;
  /** Home / End：到最小 / 最大 */
  onEdge: (edge: "min" | "max") => void;
  /** 双击 / Enter：复位到默认 */
  onReset: () => void;
  className?: string;
}

export function SplitHandle(props: SplitHandleProps) {
  const vertical = props.orientation === "vertical";
  const axis = (delta: { x: number; y: number }): number => (vertical ? delta.x : delta.y);
  /**
   * 双击复位**在 pointerdown 上自己判**，不靠 onDoubleClick：`startPointerDrag` 对
   * pointerdown 调了 preventDefault（为了让拖动不选中文字），指针捕获期间浏览器
   * 不一定再合成 click / dblclick（CDP 真机复现：click 有、dblclick 没有）。
   * 两次按下间隔 < 400ms 且几乎同一位置 = 双击，直接复位，不开始拖动。
   */
  const lastDown = useRef<{ at: number; x: number; y: number } | null>(null);
  return (
    <div
      className={`split-handle${props.className === undefined ? "" : ` ${props.className}`}`}
      data-orientation={props.orientation}
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      // 悬停提示与读屏名同一句：这条把手没有可见文字，title 是唯一给鼠标用户的说明
      title={props.label}
      tabIndex={0}
      onPointerDown={(event) => {
        const now = performance.now();
        const last = lastDown.current;
        if (
          last !== null &&
          now - last.at < 400 &&
          Math.abs(event.clientX - last.x) < 6 &&
          Math.abs(event.clientY - last.y) < 6
        ) {
          lastDown.current = null;
          event.preventDefault();
          props.onReset();
          return;
        }
        lastDown.current = { at: now, x: event.clientX, y: event.clientY };
        const started = startPointerDrag(event, {
          cursor: vertical ? "col-resize" : "row-resize",
          onMove: (delta) => props.onDrag(axis(delta)),
          onEnd: (delta) => props.onDragEnd(axis(delta)),
        });
        if (started) props.onDragStart?.();
      }}
      onDoubleClick={props.onReset}
      onKeyDown={(event) => {
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key === back || event.key === forward) {
          event.preventDefault();
          const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * (event.key === back ? -1 : 1);
          props.onStep(step);
          return;
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          props.onEdge(event.key === "Home" ? "min" : "max");
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          props.onReset();
        }
      }}
    />
  );
}
