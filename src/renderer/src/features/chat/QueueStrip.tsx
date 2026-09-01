import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon";
import type { PendingSend } from "./session-states.ts";

/**
 * 排队卡片（C-1）：输入框上方、逐条一行的待发消息。三个来源统一显示：
 *  - pi 队列的 steering：已插队，等当前轮的下一个工具边界注入（不打断正在流式的输出）
 *  - pi 队列的 followUp：等本轮结束自动投递，可「立即」转插队、可取消
 *  - 本地待办：压缩期间的消息（pi 压缩中连入队入口都关着）与排队的手动 /compact
 *    （pi 队列只存消息文本，压缩指令进不去）
 *
 * 每条可编辑（笔图标，Enter 保存 / Esc 放弃）——排队期间随时改口是排队的意义之一；
 * compact 项不可编辑（它不是一条消息）。
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  queue: { steering: readonly string[]; followUp: readonly string[] };
  pendingSends: readonly PendingSend[];
  /** idle 时 pi 队列是「停止后滞留」态：下次发送时自动带上，注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onPromote: (index: number, text: string) => void;
  onCancel: (index: number, text: string) => void;
  onEdit: (index: number, text: string, newText: string) => void;
  onCancelPending: (index: number) => void;
  onEditPending: (index: number, text: string) => void;
}) {
  const { queue, pendingSends } = props;
  const empty =
    queue.steering.length === 0 && queue.followUp.length === 0 && pendingSends.length === 0;
  if (empty) return null;
  // 停止后的滞留态：本轮已不存在，消息等下一次发送时自动带上
  const haltedNote = props.phase === "idle" ? "下次发送时一起投递" : null;
  // pi 队列的命令下标指 [...steering, ...followUp] 拼接视图（runtime 按同一顺序重放）
  const offset = queue.steering.length;
  return (
    <section
      aria-label="排队中的消息"
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
      {queue.steering.map((text, i) => (
        <QueueRow
          key={`s${i}:${text}`}
          icon="arrow-up"
          note={haltedNote ?? "插队中 · 下个工具边界生效"}
          text={text}
          onCancel={() => props.onCancel(i, text)}
          onEdit={(newText) => props.onEdit(i, text, newText)}
        />
      ))}
      {queue.followUp.map((text, i) => (
        <QueueRow
          key={`f${i}:${text}`}
          icon="clock"
          note={haltedNote ?? "等本轮结束发送"}
          text={text}
          onPromote={() => props.onPromote(offset + i, text)}
          onCancel={() => props.onCancel(offset + i, text)}
          onEdit={(newText) => props.onEdit(offset + i, text, newText)}
        />
      ))}
      {pendingSends.map((item, i) => (
        <QueueRow
          key={`p${i}:${pendingLabel(item)}`}
          icon="clock"
          note={pendingNote(item, props.phase)}
          text={pendingLabel(item)}
          editable={item.kind === "text"}
          onCancel={() => props.onCancelPending(i)}
          onEdit={
            item.kind === "text" ? (newText) => props.onEditPending(i, newText) : undefined
          }
        />
      ))}
    </section>
  );
}

function pendingLabel(item: PendingSend): string {
  if (item.kind === "text") return item.text;
  return item.instructions === undefined ? "/compact" : `/compact ${item.instructions}`;
}

/** 本地待办的注脚：text 只在压缩期间产生；compact 必须等完全空闲——pi 队列里的
 *  排队消息全处理完才轮到它（反过来压会让消息滞留，且压不到最新内容）。 */
function pendingNote(item: PendingSend, phase: "idle" | "turn" | "compaction"): string {
  if (item.kind === "text") return "正在压缩上下文，压缩结束自动发送";
  return phase === "compaction" ? "当前压缩结束后再压缩" : "空闲后压缩（上面的排队先发）";
}

/** 一条排队项：图标 + 文本（截断）+ 状态注脚 + 操作；点笔进入行内编辑。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  /** compact 项不可编辑 */
  editable?: boolean;
  onPromote?: () => void;
  onCancel: () => void;
  onEdit?: (newText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.text);
  const editable = props.editable !== false && props.onEdit !== undefined;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== "" && next !== props.text) props.onEdit?.(next);
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
              setDraft(props.text);
              setEditing(false);
            }
          }}
          onBlur={commit}
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
      {editable && !editing && (
        <QueueAction
          title="编辑这条排队"
          onClick={() => {
            setDraft(props.text);
            setEditing(true);
          }}
        >
          <Icon name="pencil-line" size={12} />
        </QueueAction>
      )}
      {props.onPromote !== undefined && !editing && <QueueAction onClick={props.onPromote}>立即</QueueAction>}
      <QueueAction title="取消这条排队" onClick={props.onCancel}>
        取消
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
