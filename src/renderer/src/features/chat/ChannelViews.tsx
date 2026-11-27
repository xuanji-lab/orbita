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
 *     （`ChannelFromParentBubble`），父侧是一张白卡（`ChannelFromChildCard` / `ChildLineCard`，2026-11-22 收掉了胶囊）。
 *
 * 派出卡（`DelegateCardView`）是另一种语言：GlassCard 同款 1px 边框 + panel 底的
 * 小卡片，不是一行标记。
 *
 * 父子会话面板删除后（2026-10-12 用户裁决：它总是自己弹出，且把两边对话抽走、
 * 变成第三个又长又啰嗦的地方）：标记行不再有「点开面板」的去处——父流的
 * question / done / failed 标记换成一行白卡 `ChildLineCard`（点开 Sub-sessions 面板），
 * 子流的父侧消息换成 `ChannelFromParentBubble`（正文直接进对话流），都在本文件。
 */
import type { ChannelEndInfo, ChannelMessage, ChannelMessageKind, ChannelSummary } from "@shared/channel";
import type { DelegateCard } from "@shared/agent-ipc";
import { thinkingLevelLabel } from "@shared/thinking";
import { Icon, type IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { questionAnswered, type ChannelMarkTone } from "./tool-results";
import { EXIT_CARD_KICKER, EXIT_CARD_STYLE, ExitCard } from "./ExitCard";
import { MarkdownBlock } from "./MarkdownBlock";
import type { SessionEntry } from "./session-states";
import type { SessionRunState } from "../notify/completion-notice.ts";
import type { Messages } from "../../messages-en.ts";
import { useT } from "../../locale.ts";
import { useState } from "react";
import { api } from "../../api";
import { Menu, type MenuItem } from "../../shell/Menu";
import { channelEndOf, channelEndText } from "./sub-sessions-rows.ts";

/**
 * 通道渲染面共用的上下文（子会话 PR4a）：`TranscriptColumn` 往下经 `EntryView` /
 * `TurnRollupLine` / `ToolLine` / `ToolGroupLine` 传的就是这一个对象，而不是四五个
 * 散装 props——**必须在调用方用 useMemo 建出稳定引用**（ChatView.tsx），否则
 * TranscriptColumn 的 memo 会被每次渲染新建的对象打穿（见该组件的注释）。
 */
export interface ChannelViewContext {
  /** 当前查看会话 id：派出卡的重试 / 终止复用 channel:speak / channel:stop。 */
  ownSessionId: string;
  /** 被查看会话相对通道的身份：父看到子发来的消息，子看到父发来的消息 */
  ownSide: "parent" | "child";
  /** 被查看会话自己的 parentId——仅 ownSide 为 "child" 时有意义（report_to_parent 的隐式对面） */
  ownParentId: string | null;
  /** 会话 id → 标题，标记行 / 派出卡按 peerId / childId 查对面的名字 */
  titles: ReadonlyMap<string, string>;
  /** 子会话 id → 它用的型号 id（交回卡左边的模型名标签用）；没有的退回派出卡上记的型号 */
  childModelIds: ReadonlyMap<string, string>;
  /** 型号 id → 显示名（声明名 > 白名单 > 目录名 > id，与模型菜单同一套） */
  modelNameOf: (modelId: string) => string;
  /** 被查看的这条会话自己的型号显示名（子会话视图顶行用）；还没选型号 null */
  ownModelName: string | null;
  /** 派出卡状态优先读它（done/failed/waiting），来自 useChannelSummaries */
  channelSummaries: ReadonlyMap<string, ChannelSummary>;
  /** 派出卡 / 交回产出读同一份 phase 快照；key 变化会让 ChatView 重建 channel 对象。 */
  childPhases: ReadonlyMap<string, SessionEntry["phase"]>;
  /**
   * 编排形态才给：子会话 id → 运行态（含「停下来问你」的等你，与侧栏 / 树同一份）。给了的话派出卡的
   * 在跑 / 等你 / 空闲用编排那一套词（agents.status），不用单智能体的「运行中」。null = 单智能体，照旧
   */
  childRunState?: ((id: string) => SessionRunState) | null;
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
    case "interrupted":
      return "circle-off";
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
  fontSize: "var(--font-size-xs)",
} satisfies React.CSSProperties;

/**
 * 通道标记胶囊：一行、宽度 fit-content、1px dashed 边框、mono xs、tertiary 底色，
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

/**
 * 发送侧的标记行：`reply_subsession` / `report_to_parent` 工具调用的折叠展示，
 * 虚线胶囊语言（`ChannelMarkPill`）。`ToolLine` 只在**非失败**时用它——
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

export type DelegateCardStatus = "running" | "waiting" | "done" | "failed" | "interrupted" | "stopped" | "idle";


function delegateStatusColor(status: DelegateCardStatus): string {
  switch (status) {
    case "running":
      return "var(--color-accent)";
    case "waiting":
      return "var(--color-warning)";
    case "done":
      return "var(--color-success)";
    case "failed":
    case "interrupted":
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
  /** 终局分类与正文（来自 ChannelSummary.end，无需为卡再读整份账本） */
  end?: ChannelEndInfo;
  /** 失败 / 中断：既有 channel:speak 重试与 channel:stop 终止。 */
  recovery?: { parentId: string; childId: string };
  onClick?: () => void;
  lit?: boolean;
  /** 子会话用的型号显示名：写在标题后面的灰色小字（「GLM-5.3」），同型号的子会话靠标题分开；缺 = 不写 */
  modelName?: string;
  /** 编排形态：在跑 / 等你 / 空闲用 agents.status 那一套词（侧栏、页头、树同一套） */
  agentWords?: boolean;
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
                fontSize: "var(--font-size-sm)",
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
  const endText = channelEndText(props.end, t, "");
  const failed = status === "failed" || status === "interrupted";
  return (
    <ExitCard
      kicker={t.channel.delegated}
      icon={FEATURE_ICON.subsessions}
      title={card.title}
      {...(props.modelName !== undefined ? { titleSuffix: <ModelNameLabel name={props.modelName} /> } : {})}
      status={{
        text: props.agentWords === true && (status === "running" || status === "waiting" || status === "idle") ? t.agents.status[status] : t.channel.delegateStatus[status],
        color: delegateStatusColor(status),
        active: status === "running",
      }}
      preview={failed && endText !== "" ? endText : props.taskPreview}
      meta={`${card.modelId} · ${thinkingLevelLabel(card.thinkingLevel, card.modelId)}`}
      {...(props.recovery === undefined
        ? {}
        : { footer: <SubSessionRecoveryActions parentId={props.recovery.parentId} childId={props.recovery.childId} /> })}
      {...(props.onClick !== undefined ? { onClick: props.onClick, clickTitle: t.chat.openTaskCard(card.title) } : {})}
      {...(props.lit !== undefined ? { lit: props.lit } : {})}
    />
  );
}

/** 子会话卡标题后面的型号名：灰色小字（不用位图头像——小尺寸下发灰辨认不清，2026-11-22 用户看过选文字标签） */
export function ModelNameLabel(props: { name: string }) {
  return <span className="model-name-label">{props.name}</span>;
}

const TASK_CARD_TOGGLE_STYLE = {
  width: "fit-content",
  border: 0,
  background: "transparent",
  color: "var(--color-accent)",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
} satisfies React.CSSProperties;

/**
 * 子会话对话流里的「来自父会话」消息（2026-10-12 用户裁决：父会话给子会话的命令
 * 要直接出现在子会话的渲染 UI 里）：一条虚线边的气泡，头顶一行小引子说清这是谁
 * 的什么话——「父会话派来的任务 / 父会话回复 / 你（以父会话身份）回复 / 父会话叫停」。
 * 正文走 MarkdownBlock（bubble 变体，与用户气泡同一套轻量渲染）。
 *
 * `message` 为 undefined 时说明通道账本还没拉到（loading）或拉失败（error 不吞，
 * 原样显示）——只画引子和一行状态，不假装有正文。stop 是用户的裁决标记不是谁说
 * 的话（applyStop 落的是空文本），只有引子没有气泡。
 */
export function ChannelFromParentBubble(props: {
  mark: { peerId: string; messageId: string; kind: ChannelMessageKind };
  message: ChannelMessage | undefined;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();
  const { mark, message } = props;
  // author 区分「模型回的」还是「你代父回的」；账本没到时按 model（多数路径），
  // 到了如果不对会随重渲染纠正
  const author = message?.author ?? "model";
  const lead =
    mark.kind === "task"
      ? t.channel.fromParentTask
      : mark.kind === "stop"
        ? t.channel.fromParentStop
        : author === "user"
          ? t.channel.fromParentYouReply
          : t.channel.fromParentReply;
  return (
    <div className="channel-from-parent">
      <p className="channel-from-lead">
        <Icon name="corner-down-left" size={11} strokeWidth={1.8} />
        {lead}
      </p>
      {message !== undefined ? (
        message.text !== "" && (
          <div className="channel-from-bubble">
            <MarkdownBlock text={message.text} variant="bubble" />
          </div>
        )
      ) : props.error !== null ? (
        <p role="alert" className="channel-from-note channel-from-note-error">
          {props.error}
        </p>
      ) : (
        <p className="channel-from-note">{props.loading ? t.common.loading : t.channel.messageNotFound}</p>
      )}
    </div>
  );
}

/**
 * 主流里子会话来往的白卡（2026-11-22：过程收进过程行、要用户看的做成白卡）：同交回卡的一行骨架——
 * 机器人 / 警示图标 +「「标题」…」+ 型号名小字 + 第一行 + 右侧描边小按钮。红只给图标，不染底。
 */
export function ChildLineCard(props: {
  icon: IconName;
  danger?: boolean;
  head: string;
  /** 子会话用的型号显示名（灰色小字）；空 = 不写 */
  model: string;
  /** 通道正文的第一行；读不到 / 空就不写（不显示「读取失败」） */
  first: string;
  action: { label: string; onClick: () => void } | null;
  /** 卡下面补一行（交回卡的「还改了 N 个别的文件」） */
  below?: React.ReactNode;
}) {
  return (
    <div className="child-report">
      <div className="child-report-head">
        <span className="exit-card-icon" style={props.danger === true ? { color: "var(--color-danger)" } : undefined}>
          <Icon name={props.icon} size={18} strokeWidth={1.6} />
        </span>
        <span className="child-report-line">
          <span className="exit-card-name">{props.head}</span>
          {props.model !== "" && <ModelNameLabel name={props.model} />}
          {props.first !== "" && <span className="child-report-first">{props.first}</span>}
        </span>
        {props.action !== null && (
          <button type="button" className="card-btn" onClick={props.action.onClick}>
            {props.action.label}
          </button>
        )}
      </div>
      {props.below}
    </div>
  );
}

/**
 * 父流里子会话发来的问询 / 失败（完成见 ChatView 的 ChildReportCard，它还要挂「改了别的文件」）。
 * 问询：「「标题」在问你 · 问题第一行 · 型号名」+［去回答］（打开右栏子会话面板定位到回答框）；答过了（通道后面有了回复）
 * 变成「「标题」问过你 · 已回答」，按钮去掉。失败：「「标题」失败了 · 原因第一行 · 型号名」+［看它的会话］。
 * 通道正文读不到（旧样张没有账本）时第一行留空，只写「在问你」「失败了」。
 */
export function ChannelFromChildCard(props: {
  mark: { peerId: string; messageId: string; kind: ChannelMessageKind };
  channel: ChannelViewContext;
}) {
  const t = useT();
  const { mark, channel } = props;
  const title = peerTitleOf(channel, mark.peerId, t);
  const message = channel.channelMessages.get(mark.messageId);
  const first = firstLineOf(message?.text ?? "");
  const model = channel.modelNameOf(channel.childModelIds.get(mark.peerId) ?? "");
  const open = channel.openSubSession;
  if (mark.kind === "failed" || mark.kind === "interrupted") {
    const end = channelEndOf(message === undefined ? undefined : [message], mark.kind);
    return (
      <ChildLineCard
        icon={mark.kind === "failed" ? "triangle-alert" : "circle-off"}
        danger
        head={mark.kind === "failed" ? t.channel.childFailedLine(title) : t.channel.childInterruptedLine(title)}
        model={model}
        first={channelEndText(end, t, first)}
        action={open === null ? null : { label: t.chat.childReportOpen, onClick: () => open(mark.peerId) }}
      />
    );
  }
  const answered = questionAnswered(channel.channelSummaries.get(mark.peerId), message);
  return (
    <ChildLineCard
      icon="circle-help"
      head={answered ? t.channel.askedYouLine(title) : t.channel.asksYouLine(title)}
      model={model}
      first={answered ? t.channel.answered : first}
      action={answered || open === null ? null : { label: t.channel.goAnswerShort, onClick: () => open(mark.peerId) }}
    />
  );
}

/** 失败 / 中断的恢复动作：重试就是一条既有父→子 reply；终止仍走既有三步。 */
export function SubSessionRecoveryActions(props: { parentId: string; childId: string }) {
  const t = useT();
  const [busy, setBusy] = useState<"retry" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = (cause: unknown): void => setError(cause instanceof Error ? cause.message : String(cause));
  const retry = (): void => {
    if (busy !== null) return;
    setBusy("retry");
    setError(null);
    void api.channel
      .speak({
        parentId: props.parentId,
        childId: props.childId,
        text: t.subSessions.retryPrompt,
        delivery: "followUp",
      })
      .catch(report)
      .finally(() => setBusy(null));
  };
  const stop = (): void => {
    if (busy !== null) return;
    setBusy("stop");
    setError(null);
    void api.channel
      .stop({ parentId: props.parentId, childId: props.childId })
      .catch(report)
      .finally(() => setBusy(null));
  };
  const stopItems: MenuItem[] = [
    { id: "stop-hint", label: t.subSessions.stopHint, fact: true },
    { id: "stop-confirm", label: t.subSessions.stopConfirm, icon: "octagon-x", danger: true, disabled: busy !== null, onSelect: stop },
    { id: "stop-cancel", label: t.common.cancel, icon: "x", onSelect: () => undefined },
  ];
  return (
    <span className="subsession-recovery">
      <button type="button" className="card-btn" title={t.subSessions.retryTip} disabled={busy !== null} onClick={retry}>
        {t.subSessions.retry}
      </button>
      <Menu
        items={stopItems}
        align="end"
        trigger={({ toggle }) => (
          <button type="button" className="card-btn" disabled={busy !== null} title={t.subSessions.stopTip} onClick={toggle}>
            {t.subSessions.stopLabel}
          </button>
        )}
      />
      {error !== null && (
        <span className="subsession-recovery-error" role="alert" title={error}>
          <Icon name="triangle-alert" size={12} />
          {firstLineOf(error)}
        </span>
      )}
    </span>
  );
}

/** 问题正文的首行：多行取第一行，压掉成段的空白——胶囊里只放得下一句话。 */
function firstLineOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim();
}
