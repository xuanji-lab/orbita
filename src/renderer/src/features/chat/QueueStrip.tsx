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
  /** 纯图标按钮必须有 title：图标自己说不出「会打断当前这一轮」 */
  runNow: "Send now — interrupts this turn",
  runNowCompact: "Compact now",
  withdraw: "Withdraw to the input box",
  withdrawCompact: "Withdraw this compaction",
};

/**
 * 排队卡片（C-1）：输入框上方、逐条一行。**按输入顺序显示**（queueView 把 pi 队列
 * 与本地待办交错合成）——执行顺序仍由机制决定：pi 队列的消息本轮结束投递，
 * 本地 compact 必须等完全空闲，注脚各自如实写。
 *
 * 每条只有两个动作（见 docs/plans/2026-09-06-排队卡动作收敛.md）：
 * **立即发送**（回车图标）与**撤回**（undo 图标，文字落回输入框）。
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
  /** 本地 compact 待办的「立即」：马上压缩，不等空闲。与 pi 项的「立即」同名不同物 */
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
          runNowTitle={item.source === "pi" ? COPY.runNow : COPY.runNowCompact}
          withdrawTitle={
            item.source === "pi" || item.item.kind === "text"
              ? COPY.withdraw
              : COPY.withdrawCompact
          }
          onInterrupt={
            item.source === "pi"
              ? item.steering || haltedNote !== null
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

/** 一条排队项：图标 + 文本（截断）+ 状态注脚 + 两个图标动作。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  runNowTitle: string;
  withdrawTitle: string;
  onInterrupt?: () => void;
  onWithdraw: () => void;
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
