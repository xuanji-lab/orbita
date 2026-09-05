import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon";
import { placementFromOffset, resolveDropIndex, type DropPlacement } from "./queue-drop.ts";
import type { QueueViewEntry } from "./session-states.ts";

// ── 本模块全部用户可见文案（英文先行，中文化等真实需求出现再抽字典） ──
const COPY = {
  queued: "Queued messages",
  /** idle 时 pi 队列是「停止后滞留」态：下次发送时自动带上 */
  haltedNote: "Sends with your next message",
  steering: "Steering · next tool boundary",
  waitsTurnEnd: "Sends after this turn",
  waitsCompaction: "Sends when compaction finishes",
  compactsWhenIdle: "Compacts when idle (queued items go first)",
  /** 纯图标按钮必须有 title：图标自己说不出「会打断当前这一轮」 */
  runNow: "Send now — interrupts this turn",
  /** 空闲时没有当前轮可打断，同一个键退化成「直接发」 */
  runNowIdle: "Send now",
  runNowCompact: "Compact now",
  withdraw: "Withdraw to the input box",
  withdrawCompact: "Withdraw this compaction",
  reorder: "Drag to reorder",
};

/**
 * 排队卡片（C-1）：输入框上方、逐条一行。**按输入顺序显示**（queueView 把 pi 队列
 * 与本地待办交错合成）——执行顺序仍由机制决定：pi 队列的消息本轮结束投递，
 * 本地 compact 必须等完全空闲，注脚各自如实写。
 *
 * 每条只有两个按钮（见 docs/plans/2026-09-06-排队卡动作收敛.md）：
 * **立即发送**（回车图标）与**撤回**（undo 图标，文字落回输入框）；
 * 调顺序走**行首抓手拖拽**，不占按钮位。
 * 就地编辑已删：它在跟投递赛跑，而队列一动 rowKey 就变、编辑态连同草稿一起蒸发。
 * 撤回把条目从队列里拿走，竞态从根上消失——拿回来了想改多久改多久。
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  view: readonly QueueViewEntry[];
  /** idle 时 pi 队列是「停止后滞留」态：下次发送时自动带上，注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onInterrupt: (index: number, text: string) => void;
  /** 撤回：从队列移出，文字落回 composer 草稿 */
  onWithdraw: (index: number, text: string) => void;
  onWithdrawPending: (index: number) => void;
  /** 调顺序。只在 pi 队列项之间挪——本地 compact 的时机由机制定（必须等空闲） */
  onMove: (index: number, text: string, toIndex: number) => void;
  /** 本地 compact 待办的「立即」：马上压缩，不等空闲。与 pi 项的「立即」同名不同物 */
  onRunPendingNow: (index: number) => void;
}) {
  // 拖拽中的源（pi 下标）与当前落点。只活在拖拽过程里，不进任何持久状态。
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; placement: DropPlacement } | null>(null);
  if (props.view.length === 0) return null;
  const haltedNote = props.phase === "idle" ? COPY.haltedNote : null;
  // 只数 pi 项：调顺序在 pi 队列内部进行，中间夹的本地待办不参与（也不占位）
  const piCount = props.view.filter((item) => item.source === "pi").length;
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  return (
    <section
      aria-label={COPY.queued}
      style={{
        display: "grid",
        gap: "var(--space-1)",
        padding: "var(--space-3)",
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-popover)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
      }}
    >
      {props.view.map((item) => (
        <QueueRow
          key={rowKey(item)}
          icon={item.source === "pi" && item.steering ? "arrow-up" : "clock"}
          note={noteOf(item, haltedNote)}
          text={labelOf(item)}
          runNowTitle={
            item.source !== "pi"
              ? COPY.runNowCompact
              : haltedNote !== null
                ? COPY.runNowIdle
                : COPY.runNow
          }
          withdrawTitle={
            item.source === "pi" || item.item.kind === "text"
              ? COPY.withdraw
              : COPY.withdrawCompact
          }
          onInterrupt={
            item.source === "pi"
              ? // steering 项本来就在插队，再给一个「立即」没有意义；
                // 空闲滞留态则**保留入口**，只是不再打断任何东西
                item.steering
                ? undefined
                : () => props.onInterrupt(item.piIndex, item.text)
              : item.item.kind === "compact"
                ? () => props.onRunPendingNow(item.localIndex)
                : undefined
          }
          onWithdraw={() =>
            item.source === "pi"
              ? props.onWithdraw(item.piIndex, item.text)
              : props.onWithdrawPending(item.localIndex)
          }
          reorderTitle={COPY.reorder}
          // 单条时不给抓手：没有可交换的对象，一个拖不动的抓手只是误导
          draggable={item.source === "pi" && piCount > 1}
          dragging={item.source === "pi" && dragging === item.piIndex}
          dropPlacement={
            item.source === "pi" && dropAt?.index === item.piIndex ? dropAt.placement : null
          }
          onDragStart={
            item.source === "pi" ? () => setDragging(item.piIndex) : undefined
          }
          onDragOverRow={
            item.source === "pi"
              ? (placement) => {
                  if (dragging === null) return;
                  setDropAt({ index: item.piIndex, placement });
                }
              : undefined
          }
          onDropRow={
            item.source === "pi"
              ? (placement) => {
                  if (dragging === null) return;
                  const toIndex = resolveDropIndex(dragging, item.piIndex, placement);
                  const source = props.view.find(
                    (entry) => entry.source === "pi" && entry.piIndex === dragging,
                  );
                  // 拖回原位（toIndex 为 null）就什么都不发
                  if (toIndex !== null && source !== undefined && source.source === "pi") {
                    props.onMove(dragging, source.text, toIndex);
                  }
                  endDrag();
                }
              : undefined
          }
          onDragEnd={endDrag}
        />
      ))}
    </section>
  );
}

function rowKey(item: QueueViewEntry): string {
  return item.source === "pi"
    ? `s${item.piIndex}:${item.text}`
    : `p${item.localIndex}:${labelOf(item)}`;
}

function labelOf(item: QueueViewEntry): string {
  if (item.source === "pi") return item.text;
  return item.item.kind === "text"
    ? item.item.text
    : item.item.instructions === undefined
      ? "/compact"
      : `/compact ${item.item.instructions}`;
}

/** 注脚：pi 项按滞留/插队/等待三态；本地项按 kind 与 phase（compact 必须等完全空闲）。 */
function noteOf(item: QueueViewEntry, haltedNote: string | null): string {
  if (item.source === "pi") {
    if (haltedNote !== null) return haltedNote;
    return item.steering ? COPY.steering : COPY.waitsTurnEnd;
  }
  if (item.item.kind === "text") return COPY.waitsCompaction;
  // compact 排在 pi 队列消息之后执行（机制使然），如实写明
  return COPY.compactsWhenIdle;
}

/** 一条排队项：抓手 + 状态图标 + 文本（截断）+ 注脚 + 两个图标动作。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  runNowTitle: string;
  withdrawTitle: string;
  reorderTitle: string;
  draggable: boolean;
  /** 自己正被拖着 */
  dragging: boolean;
  /** 非 null = 落点在本行上/下沿，画一条插入线 */
  dropPlacement: DropPlacement | null;
  onInterrupt?: () => void;
  onWithdraw: () => void;
  onDragStart?: () => void;
  onDragOverRow?: (placement: DropPlacement) => void;
  onDropRow?: (placement: DropPlacement) => void;
  onDragEnd: () => void;
}) {
  const placementOf = (event: React.DragEvent<HTMLDivElement>): DropPlacement => {
    const box = event.currentTarget.getBoundingClientRect();
    return placementFromOffset(event.clientY - box.top, box.height);
  };
  return (
    <div
      draggable={props.draggable}
      onDragStart={(event) => {
        // Firefox 不设 dataTransfer 就不发 drag 事件；内容用不着，给个占位
        event.dataTransfer.setData("text/plain", "");
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart?.();
      }}
      onDragOver={(event) => {
        if (props.onDragOverRow === undefined) return;
        // 不阻止默认行为就不会触发 drop
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDragOverRow(placementOf(event));
      }}
      onDrop={(event) => {
        if (props.onDropRow === undefined) return;
        event.preventDefault();
        props.onDropRow(placementOf(event));
      }}
      onDragEnd={props.onDragEnd}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
        // 拖拽中的源行压淡，让注意力跟着落点走
        opacity: props.dragging ? 0.4 : 1,
        // 插入线用 box-shadow 而不是 border：不撑开布局，行不会因为悬停而跳
        boxShadow:
          props.dropPlacement === "before"
            ? "inset 0 1px 0 0 var(--color-accent)"
            : props.dropPlacement === "after"
              ? "inset 0 -1px 0 0 var(--color-accent)"
              : "none",
      }}
    >
      <span
        title={props.draggable ? props.reorderTitle : undefined}
        style={{
          display: "inline-flex",
          flex: "0 0 auto",
          color: "var(--color-text-tertiary)",
          cursor: props.draggable ? "grab" : "default",
          // 不可拖时保位：行首对齐不能因为能不能拖而变
          visibility: props.draggable ? "visible" : "hidden",
        }}
      >
        <Icon name="grip-vertical" size={12} />
      </span>
      <span style={{ display: "inline-flex", color: "var(--color-text-secondary)", flex: "0 0 auto" }}>
        <Icon name={props.icon} size={12} />
      </span>
      <span
        title={props.text}
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontSize: "var(--font-size-control)",
          color: "var(--color-text-primary)",
        }}
      >
        {props.text}
      </span>
      <span
        style={{
          flex: "0 0 auto",
          fontSize: "var(--font-size-micro)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.note}
      </span>
      {props.onInterrupt !== undefined && (
        <QueueAction title={props.runNowTitle} onClick={props.onInterrupt}>
          <Icon name="corner-down-left" size={12} />
        </QueueAction>
      )}
      <QueueAction title={props.withdrawTitle} onClick={props.onWithdraw}>
        <Icon name="undo-2" size={12} />
      </QueueAction>
    </div>
  );
}

/** 图标动作键：方形热区，`title` 是唯一的语义来源，不得缺。 */
function QueueAction(props: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      // Icon 是 aria-hidden，纯图标按钮对读屏就是一个空按钮——label 必须显式给
      aria-label={props.title}
      onClick={props.onClick}
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        // 图标键走方形热区，不再用文字键的左右 padding
        width: 22,
        height: 22,
        background: "var(--color-bg-muted)",
        color: "var(--color-text-secondary)",
        border: 0,
        borderRadius: "var(--radius-md)",
        font: "inherit",
        cursor: "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      {props.children}
    </button>
  );
}
