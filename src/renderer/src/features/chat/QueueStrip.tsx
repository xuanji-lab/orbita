import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon";

/**
 * 排队卡片（C-1）：输入框上方、逐条一行的待发消息。三个来源统一显示：
 *  - pi 队列的 steering：已插队，等当前轮的下一个工具边界注入（不打断正在流式的输出）
 *  - pi 队列的 followUp：等本轮结束自动投递，可「立即」转插队、可取消
 *  - 压缩期间的本地缓冲：pi 在压缩中连入队入口都关着，压缩结束自动发出，只能取消
 *
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  queue: { steering: readonly string[]; followUp: readonly string[] };
  pendingSends: readonly string[];
  /** idle 时队列是「停止后滞留」态：pi 会在下次发送时自动带上，注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onPromote: (index: number, text: string) => void;
  onCancel: (index: number, text: string) => void;
  onCancelPending: (index: number) => void;
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
        />
      ))}
      {pendingSends.map((text, i) => (
        <QueueRow
          key={`p${i}:${text}`}
          icon="clock"
          note="正在压缩上下文，压缩结束自动发送"
          text={text}
          onCancel={() => props.onCancelPending(i)}
        />
      ))}
    </section>
  );
}

/** 一条排队项：图标 + 文本（截断）+ 状态注脚 + 操作。 */
function QueueRow(props: {
  icon: "clock" | "arrow-up";
  note: string;
  text: string;
  onPromote?: () => void;
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
      {props.onPromote !== undefined && (
        <QueueAction onClick={props.onPromote}>立即</QueueAction>
      )}
      <QueueAction onClick={props.onCancel}>取消</QueueAction>
    </div>
  );
}

function QueueAction(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        flex: "0 0 auto",
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
