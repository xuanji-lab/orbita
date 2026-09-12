import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon";
import type { QueuedMessage } from "./session-states.ts";
import { dropPlacement } from "./queue-drop.ts";

// ── 本模块全部用户可见文案（英文先行，中文化等真实需求出现再抽字典） ──
const COPY = {
  queued: "Queued messages",
  /** idle 时队列是「停止后滞留」态：下一轮开跑时才轮到它 */
  haltedNote: "Sends with your next message",
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
 * 排队卡片：输入框上方、逐条一行，**顺序即投递顺序**。
 *
 * 队列归我们所有（`docs/plans/2026-09-06-排队队列所有权收回.md`）：每条带稳定 id，
 * 所有操作按 id——撤回、拖拽、立即发送都是本地数组操作，没有下标对账、没有跨进程
 * 往返、没有中间态。旧实现把队列寄存在 pi 里，只能靠「下标 + 文本」对账，
 * 连续操作时必然落空（2026-09-06 一晚四个 bug）。
 *
 * 每条两个按钮：**立即发送**（回车图标）与**撤回**（undo 图标，文字落回输入框）；
 * 调顺序走**行首抓手拖拽**，不占按钮位。落点语义见 queue-drop.ts：落到谁身上就占谁的
 * 位置，悬停整行描边——与 Providers 厂商排序同一套手感。
 * 设计规则与 ApprovalBar 同源：浮起的玻璃卡（popover 阴影，比 composer 高一层）、
 * 状态用图标与文字、不拿 accent 染底——accent 留给发送键。
 */
export function QueueStrip(props: {
  items: readonly QueuedMessage[];
  /** idle 时队列是「停止后滞留」态：注脚要如实说 */
  phase: "idle" | "turn" | "compaction";
  onSendNow: (id: string) => void;
  onWithdraw: (id: string) => void;
  onMove: (sourceId: string, targetId: string, placement: "before" | "after") => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 正悬停在哪一行上（整行亮起）；悬在源自己身上不算 */
  const [dropOn, setDropOn] = useState<string | null>(null);
  if (props.items.length === 0) return null;
  const halted = props.phase === "idle";
  const endDrag = (): void => {
    setDraggingId(null);
    setDropOn(null);
  };
  const indexOf = (id: string): number => props.items.findIndex((item) => item.id === id);
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
      {props.items.map((item) => (
        <QueueRow
          key={item.id}
          text={labelOf(item)}
          note={noteOf(item, props.phase)}
          runNowTitle={
            item.kind === "compact" ? COPY.runNowCompact : halted ? COPY.runNowIdle : COPY.runNow
          }
          withdrawTitle={item.kind === "compact" ? COPY.withdrawCompact : COPY.withdraw}
          reorderTitle={COPY.reorder}
          // 单条时不给抓手：没有可交换的对象，一个拖不动的抓手只是误导
          draggable={props.items.length > 1}
          dragging={draggingId === item.id}
          dropOn={dropOn === item.id}
          onSendNow={() => props.onSendNow(item.id)}
          onWithdraw={() => props.onWithdraw(item.id)}
          onDragStart={() => setDraggingId(item.id)}
          onDragOverRow={() => {
            if (draggingId === null || draggingId === item.id) return;
            // 同值返回让 React 跳过无谓的重渲——dragover 是高频事件
            setDropOn((cur) => (cur === item.id ? cur : item.id));
          }}
          onDropRow={() => {
            if (draggingId !== null) {
              const placement = dropPlacement(indexOf(draggingId), indexOf(item.id));
              if (placement !== null) props.onMove(draggingId, item.id, placement);
            }
            endDrag();
          }}
          onDragEnd={endDrag}
        />
      ))}
    </section>
  );
}

function labelOf(item: QueuedMessage): string {
  if (item.kind === "text") return item.text;
  return item.instructions === undefined ? "/compact" : `/compact ${item.instructions}`;
}

/** 注脚：如实写清「这条什么时候会发出去」，机制约束不粉饰。 */
function noteOf(item: QueuedMessage, phase: "idle" | "turn" | "compaction"): string {
  if (item.kind === "compact") return COPY.compactsWhenIdle;
  if (phase === "compaction") return COPY.waitsCompaction;
  if (phase === "idle") return COPY.haltedNote;
  return COPY.waitsTurnEnd;
}

/**
 * 一条排队项：抓手 + 文本（截断）+ 注脚 + 两个图标动作。
 *
 * **`draggable` 只给行首抓手，不给整行**——这不是洁癖，是 bug 修复：
 * 整行 draggable 时，在行内任何位置（包括两个 22×22 的图标按钮）按下鼠标后指针只要
 * 移动过 Chromium 的拖拽阈值（约 3px），这次手势就被判给拖拽，dragstart 之后浏览器
 * **不再派发 click**。表现是「点了一次没反应、以为没点准、再点一次才出去」——
 * 2026-09-12 插队失效的真因：命令根本没进 `sendQueuedNow`，所以 runtime 侧查不到任何痕迹。
 * 触发与否取决于手抖几个像素，因此时灵时不灵；队列只剩一条时 `draggable` 为 false，反而从不复现。
 * 抓手自己做拖拽源之后，按钮与文本都不在 draggable 子树里，点击不可能再被吞。
 */
function QueueRow(props: {
  text: string;
  note: string;
  runNowTitle: string;
  withdrawTitle: string;
  reorderTitle: string;
  draggable: boolean;
  /** 自己正被拖着 */
  dragging: boolean;
  /** 正被拖着的那条悬在本行上：整行描边，松手就占本行的位置 */
  dropOn: boolean;
  onSendNow: () => void;
  onWithdraw: () => void;
  onDragStart: () => void;
  /** 只上报「悬停 / 落在本行」；行不看鼠标坐标，落点语义由 QueueStrip 按下标算 */
  onDragOverRow: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
  // 拖拽源是抓手，但拖影要拿整行——否则跟着指针走的只有一个 12px 的点
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rowRef}
      onDragOver={(event) => {
        // 不阻止默认行为就不会触发 drop
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDragOverRow();
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDropRow();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
        // 拖拽中的源行压淡，让注意力跟着落点走
        opacity: props.dragging ? 0.4 : 1,
        // 落点用整行内描边（Providers 厂商排序同款）：box-shadow 不撑开布局，行不会因悬停而跳
        borderRadius: "var(--radius-md)",
        boxShadow: props.dropOn ? "inset 0 0 0 1.5px var(--color-accent)" : "none",
      }}
    >
      <span
        title={props.draggable ? props.reorderTitle : undefined}
        draggable={props.draggable}
        onDragStart={(event) => {
          // Firefox 不设 dataTransfer 就不发 drag 事件；内容用不着，给个占位
          event.dataTransfer.setData("text/plain", "");
          event.dataTransfer.effectAllowed = "move";
          const row = rowRef.current;
          if (row !== null) {
            const rect = row.getBoundingClientRect();
            event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
          }
          props.onDragStart();
        }}
        // dragend 只在拖拽源上触发，所以收尾挂在抓手上（拖到空处松手也要复位）
        onDragEnd={props.onDragEnd}
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
        <Icon name="clock" size={12} />
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
      <QueueAction title={props.runNowTitle} onClick={props.onSendNow}>
        <Icon name="corner-down-left" size={12} />
      </QueueAction>
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
