/**
 * 右栏 Sub-sessions 面板（子会话 PR4c；2026-10-12 起列表层是**收件箱**）：主槽
 * 正看着一条有子会话的根会话时，这里是它们的唯一面板位——列表层（每个子会话
 * 一行：状态饼 + 名字 + 最新一句 + 相对时间；「在问你」的行展开回答框）与
 * 会话层（挑中的那条，只读查看，不给输入框）。两层状态机在
 * `sub-sessions-state.ts`（纯函数，App 持有，本组件受控渲染）；排序 / 状态 /
 * 最新一句的推导在 `sub-sessions-rows.ts`。
 *
 * 会话层不用 `RightPanelFrame`——那会在 `ChatView` 自己的 `Pane` 头之上再叠一层
 * 标题栏，两条标题挤在一起（`Pane` 已经画标题/改名/完成入口）。照辅助对话抽屉的
 * 先例（`Drawer.tsx`：标签条 + `ChatView`，标签条不是第二个 `RightPanelFrame`）：
 * 一条瘦头部（返回 / 状态 / Open as main）+ 用户控制行（终止等，见
 * `SubSessionControls`——用户裁决：这些权限归用户，不经过父模型）+ `ChatView`
 * （自带标题头 + transcript，`hideComposer` 关掉输入框与排队条）。
 */
import { useContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { selectTranscript } from "../../../../shared/transcript-state.ts";
import { createPortal } from "react-dom";
import { childSessions, type SessionMeta } from "@shared/session";
import type { ModelPair } from "@shared/settings";
import { Icon, type IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { relativeTime } from "../../shell/relative-time.ts";
import { PanelIconButton, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { ToolbarPanelSlotContext } from "../../shell/Toolbar";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { api } from "../../api";
import { modelChipParts, ModelPickerMenu } from "../settings/model-menu";
import { useChannelSummaries } from "./useChannelSummaries";
import { useParentChannels } from "./useChannelMessages";
import {
  displaySubSessionTitle,
  splitDoneRows,
  subSessionHeadline,
  subSessionLine,
  sortSubSessionRows,
  subSessionMark,
  subSessionStatusOf,
  type SubSessionRowStatus,
} from "./sub-sessions-rows";
import type { SubSessionsView } from "./sub-sessions-state";
import { ChatView } from "./ChatView";
import type { ChatSession, SessionEngine } from "./useChatSession";
import { useT } from "../../locale.ts";


const STATUS_COLOR: Record<SubSessionRowStatus, string> = {
  running: "var(--color-accent)",
  waiting: "var(--color-warning)",
  interrupted: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-danger)",
  // stopped 是用户的裁决不是故障：中性灰，区别于 failed 的红（图标已经在说话）
  stopped: "var(--color-text-tertiary)",
  paused: "var(--color-text-tertiary)",
  idle: "var(--color-text-tertiary)",
};

const STATUS_ICON: Record<SubSessionRowStatus, IconName> = {
  running: "loader-circle",
  waiting: "message-square",
  // 与子会话页里「应用上次是异常退出的…继续」那一行同一个图标
  interrupted: "triangle-alert",
  done: "circle-check",
  failed: "triangle-alert",
  stopped: "octagon-x",
  paused: "pause",
  idle: "circle-off",
};

/** 子会话在 renderer 槽里的转录（没有槽 = 空：窗口晚于它开起来、还没收到过它的事件） */
function selectTranscriptOf(engine: SessionEngine, id: string) {
  const entry = engine.entryOf(id);
  return entry === undefined ? [] : selectTranscript(entry.transcript);
}

export function SubSessionsPanel(props: {
  parentId: string;
  parentTitle: string;
  /** 主槽的 ChatSession：读 `sessions`（子会话清单） */
  session: ChatSession;
  /** 只用它的 `phaseOf`（在跑与否）与 `interruptedOf`——引擎级，不随「当前看哪条」变化 */
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
  const summaries = useChannelSummaries(props.parentId);
  // 通道全文（收件箱行的最新一句）：hook 必须在两层分支之前——列表层用它，会话层
  // 不用也不能少这一条（hook 数量不能随层切换变，同 ChatView 首页分支的纪律）
  const channels = useParentChannels(props.parentId, children.map((meta) => meta.id));
  // 「没动静」要随时间变：列表层每 30 秒重画一次那一句（几分钟的粒度，不需要更密）
  const [now, setNow] = useState(() => Date.now());
  // 做完的折成末尾一行「做完 N 件」，点开才列
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
        {/* 用户对子会话的控制行（用户裁决：模型 / 终止都归用户，不归父模型）。
            key 按子会话 id：换一条就把确认步 / 错误行复位 */}
        {child !== undefined && (
          <SubSessionControls
            key={child.id}
            parentId={props.parentId}
            childId={child.id}
            view={props.view}
            stopped={summaries.get(child.id)?.status === "stopped"}
            starredModels={props.starredModels}
            onToggleStarModel={props.onToggleStarModel}
          />
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* 只读查看：不给输入框（hideComposer）。「UI 只做一层」：面板里
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

  // 列表层 = 收件箱（2026-10-12 用户裁决）：每个子会话一行——等你（question / 被打断）
  // 最前，其次 running、failed、done（2026-11-06 起在跑的提前），同组新的在前（sub-sessions-rows.ts）。
  // 最新一句来自通道账本（useParentChannels，上面已拉）。
  const rows = sortSubSessionRows(
    children.map((meta) => {
      const status = subSessionStatusOf(meta.id, summaries.get(meta.id)?.status, props.engine);
      const messages = channels.get(meta.id);
      const last = messages?.[messages.length - 1];
      const lastAt = last !== undefined ? last.createdAt : meta.createdAt;
      return { meta, status, lastAt, messages };
    }),
  );
  const headline = subSessionHeadline(rows, {
    interrupted: t.chat.subSessionInterruptedShort,
    waiting: t.subSessions.waitingCount,
    failed: t.subSessions.failedCount,
    working: t.subSessions.workingCount,
  });
  const { open, done, parked } = splitDoneRows(rows);
  const folded = [...done, ...parked];
  const renderRow = (row: (typeof rows)[number]) => (
    <SubSessionRow
      key={row.meta.id}
      meta={row.meta}
      status={row.status}
      latest={subSessionLine(
        {
          status: row.status,
          messages: row.messages,
          items: selectTranscriptOf(props.engine, row.meta.id),
          now,
          lastActivityAt: props.engine.lastActivityOf(row.meta.id),
        },
        t,
      )}
      lastAt={row.lastAt}
      onClick={() => props.onOpenChild(row.meta.id)}
      onContinue={row.status === "interrupted" ? () => props.engine.continueTurn(row.meta.id) : undefined}
    />
  );

  return (
    <RightPanelFrame
      header={
        <>
          <PanelTitle icon={FEATURE_ICON.subsessions} title={t.rail.subSessions(children.length)} tip={t.subSessions.of(props.parentTitle)} />
          {headline !== "" && <span className="inbox-waiting-count">{headline}</span>}
        </>
      }
      contentKey="list"
    >
      {rows.length === 0 ? (
        <PanelEmpty icon={FEATURE_ICON.subsessions}>{t.subSessions.none}</PanelEmpty>
      ) : (
        <div className="inbox-rows">
          {open.map(renderRow)}
          {folded.length > 0 && (
            <button type="button" className="inbox-done-fold" aria-expanded={showDone} onClick={() => setShowDone((value) => !value)}>
              <span className="inbox-row-mark done">
                <Icon name="check" size={12} strokeWidth={2} />
              </span>
              <span className="inbox-done-label">
                {[...(done.length > 0 ? [t.subSessions.doneCount(done.length)] : []), ...(parked.length > 0 ? [t.subSessions.parkedCount(parked.length)] : [])].join(" · ")}
              </span>
              <span className="row-trailing inbox-done-chev" aria-hidden="true">
                <Icon name={showDone ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
              </span>
            </button>
          )}
          {showDone && folded.map(renderRow)}
          <p className="inbox-foot">{t.subSessions.inboxFoot}</p>
        </div>
      )}
    </RightPanelFrame>
  );
}

/**
 * 收件箱的一行：行首记号（2026-11-17 减色：要你出手的橙点、在做灰点、做完灰勾，不再用四色饼）+ 名字 + 那一句 +
 * 相对时间（行尾，钉在行的右内边距上）。「回答它」的输入框去掉了（用户 2026-11-16：「子会话要我回答它时出现的那个框，
 * 我不可能去交互，可以不要」）——子会话的问题由主会话接，主会话答不了再在对话里问你。被崩溃打断的行在下面多一行
 * 「应用上次是异常退出的…继续」，不用点进去就能让它接着跑。行按钮与继续键是兄弟（button 不能嵌 button）。
 */
function SubSessionRow(props: {
  meta: SessionMeta;
  status: SubSessionRowStatus;
  latest: string;
  lastAt: number;
  onClick: () => void;
  /** 被崩溃打断的行：行下的「继续」（接着跑上次被打断的那一轮，与子会话页里的「继续」同一条路）；其余行不给 */
  onContinue: (() => void) | undefined;
}) {
  const t = useT();
  const status = props.status;
  const mark = subSessionMark(status);
  return (
    <div className="inbox-row">
      <button type="button" className="inbox-row-main" onClick={props.onClick} title={t.subSessions.rowStatus[status]}>
        <span className={`inbox-row-mark${mark === null ? "" : ` ${mark}`}`} aria-hidden="true">
          {mark === "done" ? <Icon name="check" size={12} strokeWidth={2} /> : mark !== null ? <span className="inbox-row-dot" /> : null}
        </span>
        <span className="inbox-row-item">
          <span className="inbox-row-l1">
            <b className={`inbox-row-title${mark === "done" || mark === null ? " done" : ""}`}>
              {props.meta.title === "" ? t.subSessions.untitled : displaySubSessionTitle(props.meta.title)}
            </b>
            <span className="inbox-row-ago row-trailing">{relativeTime(props.lastAt, t)}</span>
          </span>
          {props.latest !== "" && <span className="inbox-row-l2">{props.latest}</span>}
        </span>
      </button>
      {props.onContinue !== undefined && (
        <p className="inbox-row-resume">
          {t.chat.interruptedByCrash}
          <button type="button" className="notice-exit" onClick={props.onContinue}>
            {t.chat.continueTurn}
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * 会话层的控制行（用户裁决原话：「我觉得用户应该有自己修改子会话的权限，不管是
 * mode、模型、终止与否，这些目前都没有。」）：模型菜单在左，终止在右。档位菜单 2026-11-16 随档位删了（只留放行）。
 * 模型复用输入卡底栏同一套件（Chip + ModelPickerMenu），不另写一套；动作走查看槽的 chooseModel
 * （与「Open as main 后在输入卡底栏里改」同一条路，含 lastUsed 启动恢复点的跟随）。
 *
 * **与主槽的一个差别**：子会话的下一轮由主进程按 meta 装配（deliverToChild），
 * 不经 renderer 的排队投递——chooseModel 只在空闲时落 meta，子会话在跑时那一笔
 * 会丢（下一轮还是旧模型），所以在跑时补一发直连 IPC 把 meta 当场落下去。
 *
 * 终止的确认是**就地菜单**（不弹大窗）：点开菜单已是明确意图，后果行（fact）
 * 直接摆在 danger 确认键上方——与侧栏 Delete / Compact 的两段式同族，只是触发器
 * 是专用入口，省掉「再点一次才换出确认项」那一段。
 */
function SubSessionControls(props: {
  parentId: string;
  childId: string;
  /** 会话层的查看槽（正开着这条子会话）：model / usable / catalog 与改模型的函数都从它走 */
  view: ChatSession;
  stopped: boolean;
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
    </div>
  );
}
