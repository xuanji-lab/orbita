import { useState } from "react";
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
  save: "Save changes",
  discard: "Discard changes",
  edit: "Edit this queued item",
  runNow: "Now",
  cancel: "Cancel",
  cancelItem: "Cancel this queued item",
};

/**
 * 排队卡片（C-1）：输入框上方、逐条一行。**按输入顺序显示**（queueView 把 pi 队列
 * 与本地待办交错合成）——执行顺序仍由机制决定：pi 队列的消息本轮结束投递，
 * 本地 compact 必须等完全空闲，注脚各自如实写。
 *
 * 每条可编辑（笔图标，Enter 保存 / Esc 放弃）——排队期间随时改口是排队的意义之一；
 * compact 项不可编辑（它不是一条消息）。
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  view: readonly QueueViewEntry[];
  /** idle 时 pi 队列是「停止后滞留」态：下次发送时自动带上，注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onPromote: (index: number, text: string) => void;
  onCancel: (index: number, text: string) => void;
  onEdit: (index: number, text: string, newText: string) => void;
  onCancelPending: (index: number) => void;
  onEditPending: (index: number, text: string) => void;
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
          editValue={editValueOf(item)}
          onPromote={
            item.source === "pi"
              ? item.steering || haltedNote !== null
                ? undefined
                : () => props.onPromote(item.piIndex, item.text)
              : item.item.kind === "compact"
                ? () => props.onRunPendingNow(item.localIndex)
                : undefined
          }
          onCancel={() =>
            item.source === "pi"
              ? props.onCancel(item.piIndex, item.text)
              : props.onCancelPending(item.localIndex)
          }
          onEdit={
            item.source === "pi"
              ? (newText) => props.onEdit(item.piIndex, item.text, newText)
              : (newText) => props.onEditPending(item.localIndex, newText)
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

/** 编辑态的初值：compact 项编辑的是压缩要求（不带 /compact 前缀），空 = 无要求 */
function editValueOf(item: QueueViewEntry): string {
  if (item.source === "pi") return item.text;
  return item.item.kind === "text" ? item.item.text : item.item.instructions ?? "";
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

/** 一条排队项：图标 + 文本（截断）+ 状态注脚 + 操作；点笔进入行内编辑。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  /** 编辑态初值（compact 项编辑的是压缩要求，不带前缀）；不给 = 不可编辑 */
  editValue?: string;
  onPromote?: () => void;
  onCancel: () => void;
  onEdit?: (newText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const initial = props.editValue ?? props.text;
  const [draft, setDraft] = useState(initial);
  const editable = props.editValue !== undefined && props.onEdit !== undefined;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // 空串也传下去：compact 项空串 = 清掉压缩要求（editPendingSend 按项分流）
    if (next !== initial) props.onEdit?.(next);
  };
  const discard = () => {
    setDraft(initial);
    setEditing(false);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
      <span style={{ display: "inline-flex", color: "var(--color-text-secondary)", flex: "0 0 auto" }}>
        <Icon name={props.icon} size={12} />
      </span>
      {editing ? (
        <input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              discard();
            }
          }}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            padding: "2px var(--space-2)",
            border: "1px solid var(--glass-border)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-muted)",
            font: "inherit",
            fontSize: "var(--font-size-control)",
            color: "var(--color-text-primary)",
            outline: "none",
          }}
        />
      ) : (
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
      )}
      <span
        style={{
          flex: "0 0 auto",
          fontSize: "var(--font-size-micro)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.note}
      </span>
      {editing ? (
        <>
          {/* 显式的保存/放弃：只靠 Enter 收尾用户发现不了 */}
          <QueueAction title={COPY.save} onClick={commit}>
            <Icon name="check" size={12} />
          </QueueAction>
          <QueueAction title={COPY.discard} onClick={discard}>
            <Icon name="x" size={12} />
          </QueueAction>
        </>
      ) : (
        <>
          {editable && (
            <QueueAction
              title={COPY.edit}
              onClick={() => {
                setDraft(initial);
                setEditing(true);
              }}
            >
              <Icon name="pencil-line" size={12} />
            </QueueAction>
          )}
          {props.onPromote !== undefined && (
            <QueueAction onClick={props.onPromote}>{COPY.runNow}</QueueAction>
          )}
          <QueueAction title={COPY.cancelItem} onClick={props.onCancel}>
            {COPY.cancel}
          </QueueAction>
        </>
      )}
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
