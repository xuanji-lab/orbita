/**
 * 通道标记行与派出卡（子会话 PR4a）——ChatView.tsx 已 2600+ 行，新组件单独开文件，
 * ChatView 只加分支调用。
 *
 * 两处共用「虚线胶囊 + lucide 图标 + tone 色」语言（设计稿
 * `sub-sessions/three-column.html` 的 `.mark` / `.mark.q` / `.mark.acc`）：
 *   - 发送侧标记行（`ChannelToolMarkLine`，`ToolLine` 对 `reply_subsession` /
 *     `report_to_parent` 的分流消费）——文案来自那次工具调用的入参/kind；接收侧
 *     的文案间或经 `channelMarkLabel`（tool-results.ts，QueueStrip 也在用）。
 *   - 接收侧（对话流里收到对面消息的位置）不走胶囊：子侧是带引子的虚线气泡
 *     （`ChannelFromParentBubble`），父侧是一行问询胶囊（`ChannelFromChildPill`）。
 *
 * 派出卡（`DelegateCardView`）是另一种语言：GlassCard 同款 1px 边框 + panel 底的
 * 小卡片，不是一行标记。
 *
 * 父子会话面板删除后（2026-10-12 用户裁决：它总是自己弹出，且把两边对话抽走、
 * 变成第三个又长又啰嗦的地方）：标记行不再有「点开面板」的去处——父流的
 * question / done / failed 标记换成 `ChannelFromChildPill`（点开 Sub-sessions 面板），
 * 子流的父侧消息换成 `ChannelFromParentBubble`（正文直接进对话流），都在本文件。
 */
import type { ChannelMessage, ChannelMessageKind, ChannelSummary } from "@shared/channel";
import type { DelegateCard } from "@shared/agent-ipc";
import { thinkingLevelLabel } from "@shared/thinking";
import { useState } from "react";
import { Icon, type IconName } from "../../shell/Icon";
import { channelMarkLabel, type ChannelMarkTone } from "./tool-results";
import { EXIT_CARD_KICKER, EXIT_CARD_STYLE, ExitCard } from "./ExitCard";
import { MarkdownBlock } from "./MarkdownBlock";
import type { SessionEntry } from "./session-states";
import type { Messages } from "../../messages-en.ts";
import { useT } from "../../locale.ts";

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
  /**
   * 点主流里的派出卡 / 子会话消息胶囊 → 打开右栏 Sub-sessions 面板并直接进入该子
   * 会话的会话层。null = 不可点（辅助对话抽屉不传；子会话自己没有子会话入口）。
   */
  openSubSession: ((childId: string) => void) | null;
  /**
   * 右栏 Sub-sessions 面板会话层正开着的那个子会话 id；派出卡按它加 accent 描边
   * （设计稿 `.card.lit`）。null = 没有（面板没开，或开着的是别的父会话下的子会话）。
   */
  litSubSessionId: string | null;
  /**
   * 通道消息正文（key 是 messageId）：子会话视图（ownSide 为 "child"）拉的是**自己
   * 那条父子通道的全文**——任务 / 回复 / 叫停的气泡正文都在这里；根会话视图
   * （ownSide 为 "parent"）拉的是**全部子会话通道的合并**——question 胶囊的正文
   * 按 messageId 从这里查。`ChatView.tsx` 负责拉与建索引。
   */
  channelMessages: ReadonlyMap<string, ChannelMessage>;
  channelMessagesLoading: boolean;
  channelMessagesError: string | null;
}

/**
 * 对面（peer）的显示名：按 id 查会话列表，查不到就按 ownSide 给个通用兜底——
 * ownSide 是**我方**，兜底词说的是「对面是谁」：我方是父，对面（查不到时）就叫
 * Sub-session；我方是子，对面就叫 Parent session。
 */
export function peerTitleOf(context: ChannelViewContext, peerId: string, t: Messages): string {
  const known = context.titles.get(peerId);
  if (known !== undefined && known !== "") return known;
  return context.ownSide === "parent" ? t.channel.subSession : t.channel.parentSession;
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
    // 用户终止：终止八边形，与通道卡 / 子会话列表的 stopped 状态同一枚图标
    case "stop":
      return "octagon-x";
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
 *
 * `onClick` 给定时渲染成 `button`（键盘可达、hover 抬亮到 primary）；不给时原样是
 * `span`。点击的悬停说明由调用方给（`clickTitle`）——去哪几件事客各不同，胶囊自己不知道。
 */
export function ChannelMarkPill(props: {
  icon: IconName;
  text: string;
  tone: ChannelMarkTone;
  breathing?: boolean;
  onClick?: () => void;
  clickTitle?: string;
}) {
  const color = toneColor(props.tone);
  const clickable = props.onClick !== undefined;
  const base: React.CSSProperties = {
    ...PILL_BASE,
    border: `1px dashed ${color === "var(--color-text-tertiary)" ? "var(--color-border-default)" : color}`,
  };
  const content = (
    <>
      <Icon name={props.icon} size={11} strokeWidth={1.8} />
      {props.text}
    </>
  );
  if (!clickable) {
    return (
      <span className={props.breathing === true ? "orbita-breath" : undefined} style={{ ...base, color }}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.clickTitle}
      className={`channel-mark-pill${props.breathing === true ? " orbita-breath" : ""}`}
      style={
        {
          ...base,
          background: "transparent",
          cursor: "pointer",
          // 静止态的字色是按 tone 算出来的，个例值——过 CSS 变量转交给 .channel-mark-pill，
          // hover 时样式表里的规则才盖得过它（inline color 会盖过任何 stylesheet 规则）
          "--pill-fg": color,
        } as React.CSSProperties
      }
    >
      {content}
    </button>
  );
}

/** 主流里的接收侧标记行：盘上 / 实时都落到这一行（`flattenRenderUnits` 保证 key 稳定）。
 *
 * 面板删除后的过渡形态：不可点。下一刀换成子侧虚线气泡与父侧问询胶囊后本组件整体退场。 */
export function ChannelMarkLine(props: {
  mark: { peerId: string; messageId: string; from: "parent" | "child"; kind: ChannelMessageKind };
  ownSide: "parent" | "child";
  peerTitle: string;
}) {
  const t = useT();
  const label = channelMarkLabel(props.mark, props.ownSide, props.peerTitle, t);
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
  /** 点击的悬停说明（去哪里） */
  onClick?: () => void;
  clickTitle?: string;
}) {
  return (
    <ChannelMarkPill
      icon={props.icon}
      text={props.text}
      tone={props.tone}
      breathing={props.running}
      onClick={props.onClick}
      clickTitle={props.clickTitle}
    />
  );
}

export type DelegateCardStatus = "running" | "waiting" | "done" | "failed" | "stopped" | "idle";


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
    // stopped 是用户的裁决不是故障：中性灰（同 Sub-sessions 面板的 STATUS_COLOR）
    case "stopped":
    case "idle":
      return "var(--color-text-tertiary)";
  }
}

/**
 * 派出卡：`delegate` 工具的结果卡（第一行 DELEGATED + 标题 + 状态，第二行任务
 * 首行截断，第三行模型 id · 思考档）。`card` 为 null 是 running 帧（details 随
 * 终态帧来，还没到）——只说「派出中」，不假装有数据。
 *
 * `status` 由调用方解出（channel summary 优先，否则看子会话在 renderer 会话槽
 * 里的 phase）——本组件是纯展示，不知道通道摘要或会话槽的存在。
 *
 * `onClick` 给定时渲染成 `button`（键盘可达）：子会话 PR4c，点了打开右栏
 * Sub-sessions 面板并直接进入这条子会话的会话层。不给（辅助对话抽屉 / running
 * 帧还没有 childId）时原样是 `div`，不可点——PR4a/4b 的行为原样保留。
 * `lit` 为 true 时加 accent 描边（该子会话正是会话层开着的那条）。
 */
export function DelegateCardView(props: {
  card: DelegateCard | null;
  status: DelegateCardStatus;
  taskPreview: string;
  /** 结果帧永远不来（interruptedToolCallIds）：null 卡不呼吸「委派中」，换静止的中性「已中断」 */
  interrupted?: boolean;
  onClick?: () => void;
  lit?: boolean;
}) {
  const t = useT();
  if (props.card === null) {
    // 已中断：这次委派从未发生（参数没发完连接先断）——不呼吸、不假装在派，
    // 任务预览留给用户看「当时要派什么」（入参里有，不必等结果）
    if (props.interrupted === true) {
      return (
        <div style={EXIT_CARD_STYLE}>
          <span
            style={{
              ...EXIT_CARD_KICKER,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--color-text-tertiary)",
            }}
          >
            <Icon name="circle-off" size={11} strokeWidth={1.8} />
            {t.chat.toolInterrupted}
          </span>
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
        </div>
      );
    }
    return (
      <div style={EXIT_CARD_STYLE}>
        <span className="orbita-breath" style={{ ...EXIT_CARD_KICKER, color: "var(--color-accent)" }}>
          {t.channel.delegating}
        </span>
      </div>
    );
  }
  const { card, status } = props;
  return (
    <ExitCard
      kicker={t.channel.delegated}
      title={card.title}
      status={{ text: t.channel.delegateStatus[status], color: delegateStatusColor(status), active: status === "running" }}
      preview={props.taskPreview}
      meta={`${card.modelId} · ${thinkingLevelLabel(card.thinkingLevel, card.modelId)}`}
      {...(props.onClick !== undefined ? { onClick: props.onClick, clickTitle: t.chat.openTaskCard(card.title) } : {})}
      {...(props.lit !== undefined ? { lit: props.lit } : {})}
    />
  );
}

const TASK_CARD_TOGGLE_STYLE = {
  width: "fit-content",
  border: 0,
  background: "transparent",
  color: "var(--color-accent)",
  font: "inherit",
  fontSize: "var(--font-size-caption)",
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
} satisfies React.CSSProperties;

/**
 * 子会话流里任务卡正文默认展示的行数——够看清任务在做什么，长任务不占满整个首屏。
 * （随通道列一起从 channel-column.ts 搬来，任务卡退场时一并删。）
 */
const TASK_CARD_PREVIEW_LINES = 12;

/** 任务卡正文的展开 / 折叠取值（纯函数化，组件本身按仓库惯例不测）。 */
function taskCardBody(text: string, expanded: boolean): { body: string; hasMore: boolean } {
  const lines = text.split("\n");
  const hasMore = lines.length > TASK_CARD_PREVIEW_LINES;
  const body = !expanded && hasMore ? lines.slice(0, TASK_CARD_PREVIEW_LINES).join("\n") : text;
  return { body, hasMore };
}

/**
 * 子会话自己 session 里的完整任务卡（子会话 2026-09-23 裁决①：父给子的第一条
 * 任务应该渲染在子会话自己的对话流里，不再是一行「task from … · view in
 * channel」胶囊）。样式照抄派出卡（`DelegateCardView`）：1px subtle 边框、lg
 * 圆角、panel 底。
 *
 * `message` 是 undefined 时说明通道账本还没拉到（`loading`）或拉失败
 * （`error`，不吞错，原样显示）；两者都只画卡头 + 一行状态，不假装有正文。
 * 正文超过 `TASK_CARD_PREVIEW_LINES` 行时默认截断，`Show full task` / `Collapse`
 * 切换（原生 `<button>`，键盘可达）。
 */
export function ChannelTaskCard(props: {
  peerTitle: string;
  message: ChannelMessage | undefined;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { message } = props;
  const { body, hasMore } = taskCardBody(message?.text ?? "", expanded);
  return (
    <div style={EXIT_CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={EXIT_CARD_KICKER}>{t.channel.taskKicker}</span>
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
          {t.channel.from(props.peerTitle)}
        </span>
      </div>
      {message !== undefined ? (
        <>
          <MarkdownBlock text={body} />
          {hasMore && (
            <button type="button" style={TASK_CARD_TOGGLE_STYLE} onClick={() => setExpanded((value) => !value)}>
              {expanded ? t.channel.collapse : t.channel.showFullTask}
            </button>
          )}
        </>
      ) : props.error !== null ? (
        <p role="alert" style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
          {props.error}
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.loading ? t.common.loading : t.channel.taskNotFound}
        </p>
      )}
    </div>
  );
}
