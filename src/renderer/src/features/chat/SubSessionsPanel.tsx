/**
 * 右栏 Sub-sessions 面板（子会话 PR4c；2026-10-12 起列表层是**收件箱**）：主槽
 * 正看着一条有子会话的根会话时，这里是它们的唯一面板位——列表层（每个子会话
 * 一行：状态饼 + 名字 + 最新一句 + 相对时间；「在问你」的行展开回答框）与
 * 会话层（挑中的那条，只读查看 + 审批，不给输入框）。两层状态机在
 * `sub-sessions-state.ts`（纯函数，App 持有，本组件受控渲染）；排序 / 状态 /
 * 最新一句的推导在 `sub-sessions-rows.ts`。
 *
 * 会话层不用 `RightPanelFrame`——那会在 `ChatView` 自己的 `Pane` 头之上再叠一层
 * 标题栏，两条标题挤在一起（`Pane` 已经画标题/改名/完成入口）。照辅助对话抽屉的
 * 先例（`Drawer.tsx`：标签条 + `ChatView`，标签条不是第二个 `RightPanelFrame`）：
 * 一条瘦头部（返回 / 状态 / Open as main）+ 用户控制行（终止等，见
 * `SubSessionControls`——用户裁决：这些权限归用户，不经过父模型）+ `ChatView`
 * （自带标题头 + transcript + 审批条，`hideComposer` 关掉输入框与排队条）。
 */
import { parseFoldBook, SUBSESSION_FOLD_KEY, toggleFold, writeFold } from "./sub-sessions-fold.ts";
import { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { createPortal } from "react-dom";
import { childSessions, type SessionMeta, type TranscriptRecord } from "@shared/session";
import type { ChannelMessage, ChannelSummary } from "@shared/channel";
import { modelDisplayName } from "@shared/model-defaults";
import type { ModelPair } from "@shared/settings";
import { PERMISSION_MODES } from "@shared/permission";
import { Icon, type IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { isSubmitKey } from "../../shell/composer-keys.ts";
import { composerBoxHeight } from "../../shell/composer-height.ts";
import { relativeTime } from "../../shell/relative-time.ts";
import { PanelIconButton, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { ToolbarPanelSlotContext } from "../../shell/Toolbar";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { api } from "../../api";
import { modelChipParts, ModelPickerMenu } from "../settings/model-menu";
import { useChannelSummariesState } from "./useChannelSummaries";
import { childTailCache, openChildIds, readChildTails, type ChildTail } from "./child-tails.ts";
import { useParentChannels } from "./useChannelMessages";
import { channelHold, useChannelHold } from "./channel-hold-store.ts";
import "./channel-hold.css";
import {
  childActivityOf,
  elapsedText,
  FOLDED_GROUPS,
  groupPanelRows,
  nextTickIn,
  panelRowState,
  panelSecondLine,
  subSessionStatusOf,
  type PanelGroup,
  type PanelRowState,
  type PanelSecondLine,
  type SubSessionRowStatus,
} from "./sub-sessions-rows";
import type { SubSessionsView } from "./sub-sessions-state";
import { ChatView } from "./ChatView";
import { SubSessionRecoveryActions } from "./ChannelViews";
import type { ChatSession, SessionEngine } from "./useChatSession";
import type { PendingApproval } from "./session-states.ts";
import { planTimeline } from "../context/plan-timeline.ts";
import { toolWord } from "./builtin-commands.ts";
import { rollupToolKey, toolCallSummary } from "./tool-results.ts";
import { useT } from "../../locale.ts";


const STATUS_COLOR: Record<SubSessionRowStatus, string> = {
  running: "var(--color-accent)",
  waiting: "var(--color-warning)",
  approval: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-danger)",
  interrupted: "var(--color-danger)",
  // stopped 是用户的裁决不是故障：中性灰，区别于 failed 的红（图标已经在说话）
  stopped: "var(--color-text-tertiary)",
  idle: "var(--color-text-tertiary)",
};

const STATUS_ICON: Record<SubSessionRowStatus, IconName> = {
  running: "loader-circle",
  waiting: "message-square",
  approval: "shield-check",
  done: "circle-check",
  failed: "triangle-alert",
  interrupted: "circle-off",
  stopped: "octagon-x",
  idle: "circle-off",
};

export function SubSessionsPanel(props: {
  parentId: string;
  parentTitle: string;
  /** 主槽的 ChatSession：读 `sessions`（子会话清单） */
  session: ChatSession;
  /** 只用它的 `states`（审批槽）与 `phaseOf`（在跑与否）——引擎级，不随「当前看哪条」变化 */
  engine: SessionEngine;
  /** 会话层的查看槽（`useSessionView(engine, "subsessions")`，App 持有） */
  view: ChatSession;
  nav: SubSessionsView;
  /** 点列表行 / 派出卡：进会话层（App 的同一个稳定回调，两处共用） */
  onOpenChild: (childId: string) => void;
  /** 会话层的返回按钮：退回列表层 */
  onBackToList: () => void;
  /** 「Open as main」：主槽换看这条子会话，面板关闭 */
  onOpenAsMain: (childId: string) => void;
  providersError: string | null;
  /** 模型星标（AppSettings.starredModels）与开关：会话层的模型卡片与输入卡同一张，星标也同一份 */
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
}) {
  const t = useT();
  const children = childSessions(props.session.sessions, props.parentId);
  const { summaries, ready: summariesReady } = useChannelSummariesState(props.parentId);
  // 通道全文（收件箱行的最新一句）：hook 必须在两层分支之前——列表层用它，会话层
  // 不用也不能少这一条（hook 数量不能随层切换变，同 ChatView 首页分支的纪律）
  const channels = useParentChannels(props.parentId, children.map((meta) => meta.id));

  if (props.nav.kind === "session") {
    const childId = props.nav.sessionId;
    const child = children.find((meta) => meta.id === childId);
    const status = subSessionStatusOf(childId, summaries.get(childId)?.status, props.engine);
    const toolbarSlot = useContext(ToolbarPanelSlotContext);
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
        {toolbarSlot !== null &&
          createPortal(
            <div className="cap-panel-content" key={`subsessions:${childId}`}>
              <PanelIconButton title={t.subSessions.back} onClick={props.onBackToList}>
                <Icon name="arrow-left" size={16} strokeWidth={2} />
              </PanelIconButton>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  minWidth: 0,
                  fontSize: "var(--font-size-sm)",
                  color: STATUS_COLOR[status],
                }}
              >
                <Icon
                  name={STATUS_ICON[status]}
                  size={12}
                  strokeWidth={1.8}
                  spin={status === "running"}
                />
                {t.subSessions.rowStatus[status]}
              </span>
              <span className="cap-grow" />
              <button
                type="button"
                className="cap-sel no-drag"
                onClick={() => props.onOpenAsMain(childId)}
                title={t.subSessions.openAsMainTip}
              >
                {t.subSessions.openAsMain}
              </button>
            </div>,
            toolbarSlot,
          )}
        {/* 用户对子会话的控制行（用户裁决：mode / 模型 / 终止都归用户，不归父模型）。
            key 按子会话 id：换一条就把确认步 / 错误行复位 */}
        {child !== undefined && (
          <SubSessionControls
            key={child.id}
            parentId={props.parentId}
            childId={child.id}
            view={props.view}
            stopped={summaries.get(child.id)?.status === "stopped"}
            recoverable={status === "failed" || status === "interrupted"}
            starredModels={props.starredModels}
            onToggleStarModel={props.onToggleStarModel}
          />
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* 只读查看 + 审批：不给输入框（hideComposer）。「UI 只做一层」：面板里
              查看的子会话不再嵌一层它自己的子会话入口 */}
          <ChatView
            session={props.view}
            providersError={props.providersError}
            hideComposer
            scrollToEnd
          />
        </div>
        {child === undefined && (
          // 极少见：子会话在面板开着时被删了。ChatView 会走它自己的「这条会话不存在」
          // 降级，这里只补一行说明面板为什么显示得空落落的
          <PanelEmpty icon={FEATURE_ICON.subsessions}>{t.subSessions.gone}</PanelEmpty>
        )}
      </div>
    );
  }

  // 列表层（2026-11-22 重做）：四组——等你（在问你 / 待批 / 失败）→ 在跑（卡住的在前）→ 已交回 → 已停止，
  // 后两组默认收成一行。每行：机器人（状态色是第二信号）+ 标题 + 型号名 + 时间；第二行按状态说有用的话，
  // 在跑的写正在执行的调用与已跑多久（sub-sessions-rows.ts 的 panelRowState / groupPanelRows / panelSecondLine）。
  return (
    <RightPanelFrame
      header={
        <>
          <PanelTitle icon={FEATURE_ICON.subsessions} title={t.rail.subSessions(children.length)} tip={t.subSessions.of(props.parentTitle)} />
          <ListWaitingCount children={children} summaries={summaries} engine={props.engine} />
        </>
      }
      contentKey="list"
    >
      {children.length === 0 ? (
        <PanelEmpty icon={FEATURE_ICON.subsessions}>{t.subSessions.none}</PanelEmpty>
      ) : (
        <SubSessionList
          key={props.parentId}
          parentId={props.parentId}
          children={children}
          summaries={summaries}
          summariesReady={summariesReady}
          channels={channels}
          engine={props.engine}
          session={props.session}
          onOpenChild={props.onOpenChild}
        />
      )}
    </RightPanelFrame>
  );
}

/** 页头「N 个在等你」：在问你 / 待批（与右栏图标条的角标、顶栏胶囊同一口径；失败在「要你看」组里，不算「在等你」） */
function ListWaitingCount(props: {
  children: readonly SessionMeta[];
  summaries: ReadonlyMap<string, ChannelSummary>;
  engine: SessionEngine;
}) {
  const t = useT();
  const count = props.children.filter((meta) => {
    const status = subSessionStatusOf(meta.id, props.summaries.get(meta.id)?.status, props.engine);
    return status === "waiting" || status === "approval";
  }).length;
  if (count === 0) return null;
  return (
    <span className="inbox-waiting-count" style={{ color: "var(--color-warning)" }}>
      {t.subSessions.waitingCount(count)}
    </span>
  );
}

function readUnfolded(parentId: string): ReadonlySet<PanelGroup> {
  try {
    return new Set(parseFoldBook(localStorage.getItem(SUBSESSION_FOLD_KEY))[parentId] ?? []);
  } catch {
    return new Set();
  }
}

function saveUnfolded(parentId: string, unfolded: ReadonlySet<PanelGroup>): void {
  try {
    const book = writeFold(parseFoldBook(localStorage.getItem(SUBSESSION_FOLD_KEY)), parentId, unfolded);
    localStorage.setItem(SUBSESSION_FOLD_KEY, JSON.stringify(book));
  } catch {
    // 存不下就只在这次打开里生效
  }
}

interface PanelRow {
  meta: SessionMeta;
  state: PanelRowState;
  line: PanelSecondLine;
  /** 通道最后一条消息的时间（没有往来 = 建立时间）：行尾「N 分钟前」与组内排序 */
  lastAt: number;
  /** 正在跑的那次调用开始的时刻；没在跑工具 = null */
  since: number | null;
  model: string;
}

function SubSessionList(props: {
  parentId: string;
  children: readonly SessionMeta[];
  summaries: ReadonlyMap<string, ChannelSummary>;
  /** 这个父的通道摘要取回来过没有：没取回来之前不知道谁还开着，不读任何子会话 */
  summariesReady: boolean;
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  engine: SessionEngine;
  session: ChatSession;
  onOpenChild: (childId: string) => void;
}) {
  const t = useT();
  const { children, summaries, summariesReady, channels, engine, session } = props;
  // 转录尾巴只给「通道还开着」的读（在跑什么、计划在做哪步）；交回 / 失败 / 停止的不读，四十个里只读在跑的那十几个；
  // 摘要没回来之前一个都不读（见 openChildIds）
  const openIds = useMemo(
    () => openChildIds(children, summaries, summariesReady),
    [children, summaries, summariesReady],
  );
  const tails = useChildTails(children, openIds, engine);
  const [now, setNow] = useState(() => Date.now());
  const callLine = useCallback(
    (toolName: string, input: unknown): string => {
      // 下划线 id（web_search、terminal_read……）不露给用户：给它一个词，认不得的写「工具」（同 #488 的 bgToolLabel）
      const word = toolWord(t.chat.rollupTool, rollupToolKey(toolName, input), input);
      const verb = word.includes("_") ? t.subSessions.toolLabel(word) : word;
      const summary = toolCallSummary(toolName, input);
      return summary === null || summary === "" ? verb : `${verb} · ${firstLine(summary)}`;
    },
    [t],
  );
  const modelName = useCallback(
    (modelId: string | undefined): string => {
      if (modelId === undefined || modelId === "") return "";
      const declared = session.usable.flatMap((provider) => provider.models.declared).find((model) => model.id === modelId);
      return modelDisplayName(session.catalog, modelId, {}, declared?.name);
    },
    [session.usable, session.catalog],
  );

  const rows: PanelRow[] = children.map((meta) => {
    const records = tails.get(meta.id) ?? null;
    const activity = records === null ? null : childActivityOf(records);
    const channelStatus = summaries.get(meta.id)?.status;
    const approvals = engine.states.get(meta.id)?.approvals ?? [];
    const state = panelRowState({
      channelStatus,
      needsApproval: approvals.length > 0,
      enginePhaseRunning: engine.phaseOf(meta.id) !== "idle",
      activity,
      now,
    });
    const messages = channels.get(meta.id);
    const last = messages?.[messages.length - 1];
    const first = approvals[0] as PendingApproval | undefined;
    const planStep =
      records === null
        ? null
        : (planTimeline(records)?.current.items.find((item) => item.status === "in_progress")?.text ?? null);
    const line = panelSecondLine(
      { state, activity, planStep, messages, approval: first === undefined ? null : { toolName: first.toolName, input: first.input } },
      callLine,
      t,
    );
    return {
      meta,
      state,
      line,
      lastAt: last !== undefined ? last.createdAt : meta.createdAt,
      since: line.since,
      model: modelName(meta.modelId),
    };
  });
  // 「待讨论」：交回了、主会话还没看到的（不打岔攒着的）单列一组放最上面——内容在这里看、在这里回复，
  // 不进主会话的对话流；点「现在讨论」才合成一条交给主会话。其余行照旧分组。
  const hold = useChannelHold(props.parentId);
  const heldChildIds = new Set(hold?.held.map((item) => item.childId));
  const heldRows = rows
    .filter((row) => heldChildIds.has(row.meta.id))
    .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || b.lastAt - a.lastAt);
  const groups = groupPanelRows(rows.filter((row) => !heldChildIds.has(row.meta.id)));
  // 走表：只有在跑工具的行才走；窗口不在前台停；不到一分钟按秒、否则按分钟跳（nextTickIn）
  useTicker(
    rows.flatMap((row) => (row.since === null ? [] : [row.since])),
    setNow,
  );
  // 「已交回 / 已停止」的开合按母会话记住（sub-sessions-fold.ts，存 localStorage）
  const [unfolded, setUnfolded] = useState<ReadonlySet<PanelGroup>>(() => readUnfolded(props.parentId));
  const toggle = (group: PanelGroup): void =>
    setUnfolded((prev) => {
      const next = toggleFold(prev, group);
      saveUnfolded(props.parentId, next);
      return next;
    });

  return (
    <div className="ssp-list">
      {heldRows.length > 0 && (
        <section className="ssp-group" aria-label={t.channelHold.panelGroup}>
          <header className="ssp-group-head" title={t.channelHold.panelGroupTip}>
            <span>{t.channelHold.panelGroup}</span>
            <span className="ssp-group-n">{heldRows.length}</span>
            <button
              type="button"
              className="ch-btn row-trailing"
              data-primary="true"
              title={t.channelHold.discussTitle}
              onClick={() => channelHold.release(props.parentId)}
            >
              {t.channelHold.discuss}
            </button>
          </header>
          <div className="ssp-card">
            {heldRows.map((row) => (
              <SubSessionRow key={row.meta.id} row={row} now={now} held onClick={() => props.onOpenChild(row.meta.id)} />
            ))}
          </div>
        </section>
      )}
      {groups.map(({ group, rows: list }) => {
        const folded = FOLDED_GROUPS.has(group) && !unfolded.has(group);
        if (folded) {
          return (
            <button key={group} type="button" className="ssp-fold" aria-expanded={false} onClick={() => toggle(group)}>
              <Icon name={FEATURE_ICON.subsessions} size={14} strokeWidth={1.8} className="ssp-fold-glyph" />
              <span>{t.subSessions.folded(group === "handed" ? "handed" : "stopped", list.length)}</span>
              <Icon name="chevron-right" size={14} strokeWidth={1.8} className="row-trailing" />
            </button>
          );
        }
        return (
          <section key={group} className="ssp-group" aria-label={t.subSessions.groups[group]}>
            {FOLDED_GROUPS.has(group) ? (
              // 能收起的组：整行组头就是开合键（2026-11-23 用户：「已交回，能不能一整行都可以展开和收齐」）
              <button type="button" className="ssp-group-head ssp-group-toggle" aria-expanded title={t.subSessions.foldTip} onClick={() => toggle(group)}>
                <span>{t.subSessions.groups[group]}</span>
                <span className="ssp-group-n">{list.length}</span>
                <Icon name="chevron-up" size={12} strokeWidth={1.8} className="row-trailing" />
              </button>
            ) : (
              <header className="ssp-group-head">
                <span>{t.subSessions.groups[group]}</span>
                <span className="ssp-group-n">{list.length}</span>
              </header>
            )}
            <div className="ssp-card">
              {list.map((row) => (
                <SubSessionRow key={row.meta.id} row={row} now={now} onClick={() => props.onOpenChild(row.meta.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * 列表的一行：机器人（状态色是第二信号，文字在组名与第二行里）+ 标题（常规字重，一行省略，悬停全文）+ 型号名 + 时间；
 * 第二行是这一状态下有用的那句话，在跑的行尾走表。「在问你」的行多一个［去回答］，点开回答框（ChannelReplyBox）。
 * 行按钮与回答框 / 去回答是兄弟（button 不能嵌 button）。
 */
function SubSessionRow(props: { row: PanelRow; now: number; onClick: () => void; held?: boolean }) {
  const t = useT();
  const { row } = props;
  const [answering, setAnswering] = useState(false);
  const title = row.meta.title === "" ? t.subSessions.untitled : row.meta.title;
  const running = row.state === "running" || row.state === "stuck";
  const elapsed = row.since === null ? null : props.now - row.since;
  return (
    <div className="ssp-row" data-state={row.state}>
      <button type="button" className="ssp-row-main" onClick={props.onClick} title={title}>
        <span className="ssp-bot" title={t.subSessions.rowStatus[row.state === "stuck" ? "running" : row.state]}>
          <Icon name={FEATURE_ICON.subsessions} size={14} strokeWidth={1.8} />
        </span>
        <span className="ssp-body">
          <span className="ssp-l1">
            <span className="ssp-title">{title}</span>
            {row.model !== "" && <span className="model-name-label">{row.model}</span>}
            {!running && <span className="ssp-time row-trailing">{relativeTime(row.lastAt, t)}</span>}
          </span>
          <span className="ssp-l2" data-tone={row.line.tone}>
            {row.state === "stuck" && <Icon name="triangle-alert" size={12} strokeWidth={1.8} className="ssp-stuck" />}
            {row.line.lead !== null && <span className="ssp-lead">{row.line.lead}</span>}
            <span className={row.line.mono ? "ssp-line mono" : "ssp-line"}>{row.line.text}</span>
            {elapsed !== null && (
              <span
                className="ssp-elapsed row-trailing"
                {...(row.state === "stuck" ? { title: t.subSessions.stuckTip(Math.floor(elapsed / 60_000)) } : {})}
              >
                {elapsedText(elapsed, t)}
              </span>
            )}
          </span>
        </span>
      </button>
      {/* 失败 / 中断优先给恢复动作；其它待讨论 / 在问你的行保留原回答框。 */}
      {row.state === "failed" || row.state === "interrupted" ? (
        <div className="ssp-answer">
          <SubSessionRecoveryActions parentId={row.meta.parentId ?? ""} childId={row.meta.id} />
        </div>
      ) : (row.state === "waiting" || props.held === true) && (
        <div className="ssp-answer">
          {answering ? (
            <ChannelReplyBox parentId={row.meta.parentId ?? ""} childId={row.meta.id} autoFocus onCancel={() => setAnswering(false)} />
          ) : (
            <button type="button" className="card-btn" onClick={() => setAnswering(true)}>
              {row.state === "waiting" ? t.subSessions.answer : t.channelHold.reply}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 多行文字取第一行（命令里常带换行） */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? text;
}

/**
 * 走表（照搬 proto/chat-workbench ChatStatus.tsx 的 useTicker）：since 列表空就不走；窗口失焦 / 隐藏就停，
 * 回到前台立刻补一次；不到一分钟按秒、否则对齐到分钟边界跳（nextTickIn）。
 */
function useTicker(sinces: readonly number[], setNow: (now: number) => void): void {
  const key = sinces.join(",");
  useEffect(() => {
    if (sinces.length === 0) return undefined;
    let timer: number | undefined;
    const active = (): boolean => document.visibilityState === "visible" && document.hasFocus();
    const schedule = (): void => {
      window.clearTimeout(timer);
      if (!active()) return;
      const wait = nextTickIn(sinces, Date.now());
      if (wait === null) return;
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, wait);
    };
    const wake = (): void => {
      setNow(Date.now());
      schedule();
    };
    schedule();
    window.addEventListener("focus", wake);
    window.addEventListener("blur", schedule);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("blur", schedule);
      document.removeEventListener("visibilitychange", wake);
    };
    // sinces 的内容由 key 代表
  }, [key]);
}

/**
 * 子会话的转录尾巴：引擎槽里载着的（正在面板 / 主槽看着、或真在跑的）用槽里的实时记录；没载过的读一次尾窗
 * （api.session.load 的首屏窗口，与状态卡原型 useChildTails 同一做法）。
 * 读过的按子会话 id 缓存在模块里（`childTailCache`，meta 的 updatedAt 变了才重读）——面板卸载重挂、
 * 换个父会话再换回来，第一帧就是完整的，不重读；换父 / 卸载时排队里还没发出去的读取不再发。
 * 只读 `ids` 里的（通道还开着的）——交回 / 失败 / 停止的行不需要「在跑什么」。
 * 真做时这一段应由主进程推一行「在跑什么」（见报告：要不要改契约）。
 */
function useChildTails(
  children: readonly SessionMeta[],
  ids: readonly string[],
  engine: SessionEngine,
): ReadonlyMap<string, ChildTail> {
  // 读完往缓存里写，不进 state；这个计数只负责通知「缓存变了，重画」
  const [, setReadVersion] = useState(0);
  const wanted = new Set(ids);
  const key = children
    .filter((meta) => wanted.has(meta.id) && engine.states.get(meta.id) === undefined)
    .map((meta) => `${meta.id}:${meta.updatedAt}`)
    .join(",");
  useEffect(() => {
    let alive = true;
    const list = key === "" ? [] : key.split(",").map((part) => {
      const cut = part.lastIndexOf(":");
      return { id: part.slice(0, cut), updatedAt: Number(part.slice(cut + 1)) };
    });
    void readChildTails(list, {
      load: (id) => api.session.load(id),
      cache: childTailCache,
      isCancelled: () => !alive,
    }).then(() => {
      if (alive) setReadVersion((version) => version + 1);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const out = new Map<string, ChildTail>();
  for (const id of ids) {
    const entry = engine.states.get(id);
    if (entry !== undefined) out.set(id, selectTranscript(entry.transcript) as ChildTail);
    else {
      const tail = childTailCache.peek(id);
      if (tail !== undefined) out.set(id, tail);
    }
  }
  return out;
}

/**
 * 「在问你」的行下展开的回答框：发送走 channel:speak（代父回信的既有路径，
 * author=user 的 reply），delivery 固定 steer——等回答的子会话是空闲的，steer
 * 本就退化为普通开轮；往它正在跑的那一轮里插话的场景留给父模型的 reply_subsession。
 * 原 ChannelColumn 的 composer（随面板删除）搬来：按内容定高（1–6 行）、Enter 发送
 * Shift+Enter 换行、失败就地亮错不吞。
 */
function ChannelReplyBox(props: { parentId: string; childId: string; autoFocus?: boolean; onCancel?: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 按内容定高（1–6 行，composerBoxHeight 同一套口径）：面板宽度稳定，只听文字
  const fitHeight = useCallback(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const computed = getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight);
    const padding = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
    const { height, scrollable } = composerBoxHeight(
      el.scrollHeight,
      Number.isFinite(lineHeight) ? lineHeight : 18,
      Number.isFinite(padding) ? padding : 0,
      1,
      6,
    );
    el.style.height = `${height}px`;
    el.style.overflowY = scrollable ? "auto" : "hidden";
  }, []);
  useLayoutEffect(fitHeight, [text, fitHeight]);
  // 点［去回答］展开时直接落焦点：用户要做的下一件事就是打字
  useEffect(() => {
    if (props.autoFocus === true) textareaRef.current?.focus();
  }, [props.autoFocus]);

  const send = (): void => {
    const value = text.trim();
    if (value === "" || sending) return;
    setSending(true);
    setError(null);
    void api.channel
      .speak({ parentId: props.parentId, childId: props.childId, text: value, delivery: "steer" })
      .then(() => setText(""))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false));
  };

  return (
    <div className="channel-reply-box">
      {error !== null && (
        <p role="alert" className="channel-reply-error">
          {error}
        </p>
      )}
      <div className="channel-reply-row">
        <textarea
          ref={textareaRef}
          rows={1}
          className="channel-reply-input"
          placeholder={t.channel.answerIt}
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Esc 收起回答框（草稿是空的才收，写了一半的不丢）
            if (event.key === "Escape" && props.onCancel !== undefined && text.trim() === "") {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
              return;
            }
            if (
              !isSubmitKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              })
            ) {
              return;
            }
            event.preventDefault();
            send();
          }}
        />
        <button
          type="button"
          className="channel-reply-send"
          aria-label={t.composer.send}
          title={t.composer.send}
          disabled={sending || text.trim() === ""}
          onClick={send}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * 会话层的控制行（用户裁决原话：「我觉得用户应该有自己修改子会话的权限，不管是
 * mode、模型、终止与否，这些目前都没有。」）：档位 / 模型菜单在左，终止在右。
 * 档位与模型复用输入卡底栏同一套件（Menu + Chip + ModelPickerMenu + t.permissionModes），
 * 不另写一套；动作走查看槽的 changeMode / chooseModel（与「Open as main 后在输入卡
 * 底栏里改」同一条路，含 lastUsed 启动恢复点的跟随）。
 *
 * **与主槽的一个差别**：子会话的下一轮由主进程按 meta 装配（deliverToChild），
 * 不经 renderer 的排队投递——chooseModel 只在空闲时落 meta，子会话在跑时那一笔
 * 会丢（下一轮还是旧模型），所以在跑时补一发直连 IPC 把 meta 当场落下去。
 * changeMode 不用补：它不论空闲与否都发 agent:set-mode（档位联动子会话那一刀改的）。**在跑时两者都当场生效，不等下一轮**：档位改的是 agent 进程账本，工具
 * 审批闸门每次调用现场读账；模型经 pi 的 setModel 写进 agent.state.model，pi 在同一次
 * 运行的下一次模型调用前（prepareNextTurn）就换上新模型。
 *
 * 终止的确认是**就地菜单**（不弹大窗）：点开菜单已是明确意图，后果行（fact）
 * 直接摆在 danger 确认键上方——与侧栏 Delete / Compact 的两段式同族，只是触发器
 * 是专用入口，省掉「再点一次才换出确认项」那一段。
 */
function SubSessionControls(props: {
  parentId: string;
  childId: string;
  /** 会话层的查看槽（正开着这条子会话）：mode / model / usable / catalog 与两个改档函数都从它走 */
  view: ChatSession;
  stopped: boolean;
  recoverable: boolean;
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
}) {
  const t = useT();
  const { view } = props;
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 在跑时补发的直连 IPC 失败要就地报，不静默（空闲路径的失败走 engine 的红字，与主槽同源） */
  const report = (cause: unknown): void =>
    setError(cause instanceof Error ? cause.message : String(cause));

  const chooseModel = (providerId: string, modelId: string): void => {
    view.chooseModel(providerId, modelId);
    if (view.phaseOf(props.childId) !== "idle") {
      // 成功经 model 事件回环：recorder 落 meta，查看槽的 chip 由 alignModel 对齐
      void api.agent.setModel(props.childId, providerId, modelId).catch(report);
    }
  };

  const stop = (): void => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    void api.channel
      .stop({ parentId: props.parentId, childId: props.childId })
      .catch(report)
      .finally(() => setStopping(false));
  };

  const modeItems: MenuItem[] = PERMISSION_MODES.map((value) => ({
    id: value,
    label: t.permissionModes[value].label,
    checked: view.mode === value,
    onSelect: () => view.changeMode(value),
  }));

  const stopItems: MenuItem[] = [
    // 一句话说完的事实行：Menu 里无 hint 的事实行会换行，不会被省略号切掉半句
    { id: "stop-hint", label: t.subSessions.stopHint, fact: true },
    {
      id: "stop-confirm",
      label: t.subSessions.stopConfirm,
      icon: "octagon-x",
      danger: true,
      disabled: stopping,
      onSelect: stop,
    },
    { id: "stop-cancel", label: t.common.cancel, icon: "x", onSelect: () => undefined },
  ];
  return (
    <div
      className="subsession-controls"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
        padding: "6px 14px",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      {/* 档位 / 模型：与输入卡底栏同一套菜单件，checked 标当前（状态优先图标与文字） */}
      <Menu
        items={modeItems}
        panelMinWidth={112}
        trigger={({ open, toggle }) => (
          <Chip
            icon="shield-check"
            active={open}
            fixedWidth={84}
            chevron
            title={t.permissionModes[view.mode].hint}
            onClick={toggle}
          >
            {t.permissionModes[view.mode].label}
          </Chip>
        )}
      />
      {/* 与输入卡的模型芯片同一张卡片（ModelPickerMenu）：左栏过滤、星标、定高定宽 */}
      {view.usable.length > 0 && (
        <ModelPickerMenu
          t={t}
          providers={view.usable}
          catalog={view.catalog}
          selected={view.model}
          starred={props.starredModels}
          onToggleStar={props.onToggleStarModel}
          onSelect={chooseModel}
          trigger={({ open, toggle }) => {
            // 与输入卡的模型芯片同一口径：头像 + 显示名，服务商与 id 进悬停提示
            const parts = view.model === null ? null : modelChipParts(view.usable, view.catalog, view.model);
            return (
              <Chip
                active={open}
                chevron
                title={parts === null ? t.chat.modelTip : `${parts.name} · ${parts.detail}\n${t.chat.modelTip}`}
                onClick={toggle}
                leading={parts?.avatar}
              >
                {parts?.name ?? t.chat.noModel}
              </Chip>
            );
          }}
        />
      )}
      {error !== null && (
        <span style={{ minWidth: 0, overflow: "hidden" }} role="alert">
          <PanelLine danger>{error}</PanelLine>
        </span>
      )}
      <span style={{ flex: 1 }} />
      {/* 终止不参与收缩：模型名长时由模型芯片省略，「终止」两字不被挤成「终…」（验收截图） */}
      {props.recoverable ? (
        <SubSessionRecoveryActions parentId={props.parentId} childId={props.childId} />
      ) : (
        <span style={{ flex: "none", display: "inline-flex" }}>
          <Menu
            items={stopItems}
            align="end"
            trigger={({ open, toggle }) => (
              <Chip
                icon="octagon-x"
                active={open}
                chevron
                disabled={props.stopped}
                title={props.stopped ? t.subSessions.stoppedHint : t.subSessions.stopTip}
                onClick={toggle}
              >
                {t.subSessions.stopLabel}
              </Chip>
            )}
          />
        </span>
      )}
    </div>
  );
}
