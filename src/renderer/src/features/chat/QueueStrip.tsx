import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon";
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
  recall: "Edit in composer",
  runNow: "Now",
  cancel: "Cancel",
  cancelItem: "Cancel this queued item",
};

/**
 * 排队卡片（C-1）：输入框上方、逐条一行。**按输入顺序显示**（queueView 把 pi 队列
 * 与本地待办交错合成）——执行顺序仍由机制决定：pi 队列的消息本轮结束投递，
 * 本地 compact 必须等完全空闲，注脚各自如实写。
 *
 * 改写 = 收回输入框（笔图标）：行内的小单行输入框写不了长文，点笔把该条从队列
 * 移除、文本放回 composer，改完重新发送即再次入队（排到队尾）。compact 项收回
 * 的是 `/compact` 指令原文，在输入框里改压缩要求同样顺手。
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  view: readonly QueueViewEntry[];
  /** idle 时 pi 队列是「停止后滞留」态：下次发送时自动带上，注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onInterrupt: (index: number, text: string) => void;
  onCancel: (index: number, text: string) => void;
  /** pi 队列项收回输入框：移出队列，text 放回 composer */
  onRecall: (index: number, text: string) => void;
  onCancelPending: (index: number) => void;
  /** 本地待办收回输入框：text 项原样回 composer，compact 项以 `/compact` 指令回 */
  onRecallPending: (index: number, text: string) => void;
  /** 本地 compact 待办的「立即」：马上压缩，不等空闲 */
  onRunPendingNow: (index: number) => void;
}) {
  if (props.view.length === 0) return null;
  const haltedNote = props.phase === "idle" ? COPY.haltedNote : null;
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
          onInterrupt={
            item.source === "pi"
              ? item.steering || haltedNote !== null
                ? undefined
                : () => props.onInterrupt(item.piIndex, item.text)
              : item.item.kind === "compact"
                ? () => props.onRunPendingNow(item.localIndex)
                : undefined
          }
          onRecall={() =>
            item.source === "pi"
              ? props.onRecall(item.piIndex, item.text)
              : props.onRecallPending(item.localIndex, labelOf(item))
          }
          onCancel={() =>
            item.source === "pi"
              ? props.onCancel(item.piIndex, item.text)
              : props.onCancelPending(item.localIndex)
          }
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

/** 一条排队项：图标 + 文本（截断）+ 状态注脚 + 操作；铅笔 = 收回输入框改写。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  onInterrupt?: () => void;
  onRecall: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
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
      <QueueAction title={COPY.recall} onClick={props.onRecall}>
        <Icon name="pencil-line" size={12} />
      </QueueAction>
      {props.onInterrupt !== undefined && (
        <QueueAction onClick={props.onInterrupt}>{COPY.runNow}</QueueAction>
      )}
      <QueueAction title={COPY.cancelItem} onClick={props.onCancel}>
        {COPY.cancel}
      </QueueAction>
    </div>
  );
}

function QueueAction(props: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 22,
        padding: "0 var(--space-3)",
        background: "var(--color-bg-muted)",
        color: "var(--color-text-primary)",
        border: 0,
        borderRadius: "var(--radius-md)",
        font: "inherit",
        fontSize: "var(--font-size-micro)",
        cursor: "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      {props.children}
    </button>
  );
}
