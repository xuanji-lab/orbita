/**
 * 通道标记行与派出卡（子会话 PR4a）——ChatView.tsx 已 2600+ 行，新组件单独开文件，
 * ChatView 只加分支调用。
 *
 * 两处共用「虚线胶囊 + lucide 图标 + tone 色」语言（设计稿
 * `sub-sessions/three-column.html` 的 `.mark` / `.mark.q` / `.mark.acc`）：
 *   - 接收侧标记行（`ChannelMarkLine`，`EntryView` 的 `channelMark` 分支消费）——
 *     文案来自盘上/实时的 `ChannelMarkRecord`。
 *   - 发送侧标记行（`ChannelToolMarkLine`，`ToolLine` 对 `reply_subsession` /
 *     `report_to_parent` 的分流消费）——文案来自那次工具调用的入参/kind。
 * 两者的文案与语气都经同一个纯函数 `channelMarkLabel`（tool-results.ts），只是
 * 「谁在跟谁说话」的字段来源不同。
 *
 * 派出卡（`DelegateCardView`）是另一种语言：GlassCard 同款 1px 边框 + panel 底的
 * 小卡片，不是一行标记。
 *
 * 本 PR 标记与派出卡**均不可点**——打开通道 / 跳转子会话是后续 PR 的事。
 */
import type { ChannelMessageKind, ChannelSummary } from "@shared/channel";
import type { DelegateCard } from "@shared/agent-ipc";
import { thinkingLevelLabel } from "@shared/thinking";
import { Icon, type IconName } from "../../shell/Icon";
import { channelMarkLabel, type ChannelMarkTone } from "./tool-results";
import type { SessionEntry } from "./session-states";

/**
 * 通道渲染面共用的上下文（子会话 PR4a）：`TranscriptColumn` 往下经 `EntryView` /
 * `TurnRollupLine` / `ToolLine` / `ToolGroupLine` 传的就是这一个对象，而不是四五个
 * 散装 props——**必须在调用方用 useMemo 建出稳定引用**（ChatView.tsx），否则
 * TranscriptColumn 的 memo 会被每次渲染新建的对象打穿（见该组件的注释）。
 */
export interface ChannelViewContext {
  /** 被查看会话相对通道的身份：父看到子发来的消息，子看到父发来的消息 */
  ownSide: "parent" | "child";
  /** 被查看会话自己的 parentId——仅 ownSide 为 "child" 时有意义（report_to_parent 的隐式对面） */
  ownParentId: string | null;
  /** 会话 id → 标题，标记行 / 派出卡按 peerId / childId 查对面的名字 */
  titles: ReadonlyMap<string, string>;
  /** 派出卡状态优先读它（done/failed/waiting），来自 useChannelSummaries */
  channelSummaries: ReadonlyMap<string, ChannelSummary>;
  /** 派出卡状态的兜底——channelSummaries 没有终态时看子会话是否还在跑 */
  childPhaseOf: (id: string) => SessionEntry["phase"];
}

/**
 * 对面（peer）的显示名：按 id 查会话列表，查不到就按 ownSide 给个通用兜底——
 * ownSide 是**我方**，兜底词说的是「对面是谁」：我方是父，对面（查不到时）就叫
 * Sub-session；我方是子，对面就叫 Parent session。
 */
export function peerTitleOf(context: ChannelViewContext, peerId: string): string {
  const known = context.titles.get(peerId);
  if (known !== undefined && known !== "") return known;
  return context.ownSide === "parent" ? "Sub-session" : "Parent session";
}

/** tone → 颜色 token。颜色是第二信号——行首图标已经说清楚是什么事，这里只补一眼。 */
function toneColor(tone: ChannelMarkTone): string {
  switch (tone) {
    case "question":
      return "var(--color-warning)";
    case "reply":
      return "var(--color-accent)";
    case "done":
      return "var(--color-success)";
    case "failed":
      return "var(--color-danger)";
    default:
      return "var(--color-text-tertiary)";
  }
}

/**
 * kind → 行首图标。设计系统的 Icon 组件只登记「真正用到的图标」（46 个子集），
 * 没有精确对应的 lucide 名字（message-circle-question / corner-down-right /
 * send / activity / circle-x）时换仓库已登记的近义名，不新增图标资产。
 *
 * 导出给 `QueueStrip` 用：排队里的 channel 条目同一套图标词汇，不重开一份。
 */
export function channelKindIcon(kind: ChannelMessageKind): IconName {
  switch (kind) {
    case "question":
      return "message-square";
    case "reply":
      return "undo-2";
    case "task":
      return "arrow-up";
    case "progress":
      return "refresh-cw";
    case "done":
      return "circle-check";
    case "failed":
      return "triangle-alert";
    default:
      return "message-square";
  }
}

const PILL_BASE = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  width: "fit-content",
  padding: "2px 8px",
  borderRadius: "var(--radius-pill)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
} satisfies React.CSSProperties;

/**
 * 通道标记胶囊：一行、宽度 fit-content、1px dashed 边框、mono micro、tertiary 底色，
 * tone 命中时描边与文字换色（颜色是第二信号，图标已经在说话）。
 * `breathing` 给 running 帧用（reply_subsession / report_to_parent 还没落定的结果）。
 */
export function ChannelMarkPill(props: {
  icon: IconName;
  text: string;
  tone: ChannelMarkTone;
  breathing?: boolean;
}) {
  const color = toneColor(props.tone);
  return (
    <span
      className={props.breathing === true ? "orbita-breath" : undefined}
      style={{
        ...PILL_BASE,
        border: `1px dashed ${color === "var(--color-text-tertiary)" ? "var(--color-border-default)" : color}`,
        color,
      }}
    >
      <Icon name={props.icon} size={11} strokeWidth={1.8} />
      {props.text}
    </span>
  );
}

/** 主流里的接收侧标记行：盘上 / 实时都落到这一行（`flattenRenderUnits` 保证 key 稳定）。 */
export function ChannelMarkLine(props: {
  mark: { peerId: string; messageId: string; from: "parent" | "child"; kind: ChannelMessageKind };
  ownSide: "parent" | "child";
  peerTitle: string;
}) {
  const label = channelMarkLabel(props.mark, props.ownSide, props.peerTitle);
  return <ChannelMarkPill icon={channelKindIcon(props.mark.kind)} text={label.text} tone={label.tone} />;
}

/**
 * 发送侧的标记行：`reply_subsession` / `report_to_parent` 工具调用的折叠展示，
 * 与 `ChannelMarkLine` 同一套胶囊语言。`ToolLine` 只在**非失败**时用它——
 * 工具调用本身失败（`result.status === "error"`）要照 `ToolLine` 的失败样式走
 * （红色 triangle-alert + 可展开看错误），不能被这行的「成功语气」盖过去。
 */
export function ChannelToolMarkLine(props: {
  icon: IconName;
  text: string;
  tone: ChannelMarkTone;
  running: boolean;
}) {
  return <ChannelMarkPill icon={props.icon} text={props.text} tone={props.tone} breathing={props.running} />;
}

export type DelegateCardStatus = "running" | "waiting" | "done" | "failed" | "idle";

const DELEGATE_STATUS_COPY: Record<DelegateCardStatus, string> = {
  running: "running",
  waiting: "waiting for reply",
  done: "done",
  failed: "failed",
  idle: "idle",
};

function delegateStatusColor(status: DelegateCardStatus): string {
  switch (status) {
    case "running":
      return "var(--color-accent)";
    case "waiting":
      return "var(--color-warning)";
    case "done":
      return "var(--color-success)";
    case "failed":
      return "var(--color-danger)";
    case "idle":
      return "var(--color-text-tertiary)";
  }
}

const CARD_STYLE = {
  display: "grid",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--color-border-subtle)",
  background: "var(--color-bg-panel)",
  minWidth: 0,
} satisfies React.CSSProperties;

const CARD_KICKER = {
  flex: "0 0 auto",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--color-text-tertiary)",
} satisfies React.CSSProperties;

/**
 * 派出卡：`delegate` 工具的结果卡（第一行 DELEGATED + 标题 + 状态，第二行任务
 * 首行截断，第三行模型 id · 思考档）。`card` 为 null 是 running 帧（details 随
 * 终态帧来，还没到）——只说「派出中」，不假装有数据。
 *
 * `status` 由调用方解出（channel summary 优先，否则看子会话在 renderer 会话槽
 * 里的 phase）——本组件是纯展示，不知道通道摘要或会话槽的存在。
 */
export function DelegateCardView(props: {
  card: DelegateCard | null;
  status: DelegateCardStatus;
  taskPreview: string;
}) {
  if (props.card === null) {
    return (
      <div style={CARD_STYLE}>
        <span className="orbita-breath" style={{ ...CARD_KICKER, color: "var(--color-accent)" }}>
          delegating…
        </span>
      </div>
    );
  }
  const { card, status } = props;
  const color = delegateStatusColor(status);
  return (
    <div style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <span style={CARD_KICKER}>DELEGATED</span>
        <span
          style={{
            fontWeight: "var(--weight-strong)",
            fontSize: "var(--font-size-body)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        <span
          className={status === "running" ? "orbita-breath" : undefined}
          style={{
            marginLeft: "auto",
            flex: "0 0 auto",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-micro)",
            color,
          }}
        >
          {DELEGATE_STATUS_COPY[status]}
        </span>
      </div>
      {props.taskPreview !== "" && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-caption)",
            color: "var(--color-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.taskPreview}
        </p>
      )}
      <span
        style={{
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-micro)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {card.modelId} · {thinkingLevelLabel(card.thinkingLevel, card.modelId)}
      </span>
    </div>
  );
}
