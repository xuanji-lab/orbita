/**
 * 右栏 Sub-sessions 面板（子会话 PR4c；2026-10-12 起列表层是**收件箱**）：主槽
 * 正看着一条有子会话的根会话时，这里是它们的唯一面板位——列表层（每个子会话
 * 一行：三节竖条 + 名字 + 最新一句 + 相对时间；「在问你」的行展开回答框）与
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
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { childSessions, type SessionMeta } from "@shared/session";
import type { ModelPair } from "@shared/settings";
import { PERMISSION_MODES } from "@shared/permission";
import { Icon, type IconName } from "../../shell/Icon";
import { isSubmitKey } from "../../shell/composer-keys.ts";
import { composerBoxHeight } from "../../shell/composer-height.ts";
import { relativeTime } from "../../shell/relative-time.ts";
import { PanelIconButton, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { api } from "../../api";
import { ModelPickerMenu } from "../settings/model-menu";
import { useChannelSummaries } from "./useChannelSummaries";
import { useParentChannels } from "./useChannelMessages";
import {
  latestChannelLine,
  sortSubSessionRows,
  subSessionBarFill,
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
  approval: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-danger)",
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
  const summaries = useChannelSummaries(props.parentId);
  // 通道全文（收件箱行的最新一句）：hook 必须在两层分支之前——列表层用它，会话层
  // 不用也不能少这一条（hook 数量不能随层切换变，同 ChatView 首页分支的纪律）
  const channels = useParentChannels(props.parentId, children.map((meta) => meta.id));

  if (props.nav.kind === "session") {
    const childId = props.nav.sessionId;
    const child = children.find((meta) => meta.id === childId);
    const status = subSessionStatusOf(childId, summaries.get(childId)?.status, props.engine);
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          className="titlebar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minWidth: 0,
            // 页头 --titlebar-row（含 1px 底线）：与右栏标题行（.panel-head）同高，两边
            // 底线连成一条；行中心钉在红绿灯中心那条线上（window-tools.ts）
            height: "var(--titlebar-row)",
            padding: "0 14px",
            boxSizing: "border-box",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <PanelIconButton title={t.subSessions.back} onClick={props.onBackToList}>
            <Icon name="arrow-left" size={14} />
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
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => props.onOpenAsMain(childId)}
            title={t.subSessions.openAsMainTip}
            style={{
              flex: "0 0 auto",
              height: 24,
              padding: "0 var(--space-2)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--color-text-secondary)",
              font: "inherit",
              fontSize: "var(--font-size-sm)",
              cursor: "pointer",
            }}
          >
            {t.subSessions.openAsMain}
          </button>
        </div>
        {/* 用户对子会话的控制行（用户裁决：mode / 模型 / 终止都归用户，不归父模型）。
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
          <div style={{ padding: "var(--space-3)" }}>
            <PanelLine>{t.subSessions.gone}</PanelLine>
          </div>
        )}
      </div>
    );
  }

  // 列表层 = 收件箱（2026-10-12 用户裁决）：每个子会话一行——等你（question / 审批）
  // 最前，其次 failed、done、running，同组新的在前（sub-sessions-rows.ts）。
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
  const waitingCount = rows.filter((row) => row.status === "waiting" || row.status === "approval").length;

  return (
    <RightPanelFrame
      header={
        <>
          <PanelTitle icon="git-fork" title={t.rail.subSessions(children.length)} tip={t.subSessions.of(props.parentTitle)} />
          {waitingCount > 0 && (
            <span className="inbox-waiting-count" style={{ color: "var(--color-warning)" }}>
              {t.subSessions.waitingCount(waitingCount)}
            </span>
          )}
        </>
      }
      contentKey="list"
    >
      {rows.length === 0 ? (
        <div style={{ padding: "var(--space-3)" }}>
          <PanelLine>{t.subSessions.none}</PanelLine>
        </div>
      ) : (
        <div className="inbox-rows">
          {rows.map((row) => (
            <SubSessionRow
              key={row.meta.id}
              meta={row.meta}
              status={row.status}
              latest={latestChannelLine(row.messages, row.status, t)}
              lastAt={row.lastAt}
              asking={row.status === "waiting"}
              onClick={() => props.onOpenChild(row.meta.id)}
            />
          ))}
          <p className="inbox-foot">{t.subSessions.inboxFoot}</p>
        </div>
      )}
    </RightPanelFrame>
  );
}

/**
 * 收件箱的一行（2026-10-12）：行首三节竖条（与侧栏 / 铃铛清单同一根 `.status-bar`，
 * `subSessionBarFill` 定亮几节）+ 名字 + 最新一句 + 相对时间（行尾，钉在行的右内
 * 边距上）。**只有「在问你」的行展开回答框**（ChannelReplyBox）——其余行单行收着，
 * 点击进会话层看完整往来。行按钮与回答框是兄弟（button 不能嵌 button），整行 hover
 * 由外层 `.inbox-row` 统一画。
 */
function SubSessionRow(props: {
  meta: SessionMeta;
  status: SubSessionRowStatus;
  latest: string;
  lastAt: number;
  /** waiting：行下展开「回答它」输入框（代父回信，同一个 send 路径） */
  asking: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const status = props.status;
  const bar = subSessionBarFill(status);
  return (
    <div className={`inbox-row${props.asking ? " asking" : ""}`}>
      <button type="button" className="inbox-row-main" onClick={props.onClick}>
        {bar !== undefined && (
          <span className="status-bar inbox-row-bar" data-fill={bar} title={t.subSessions.rowStatus[status]}>
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="inbox-row-item">
          <span className="inbox-row-l1">
            <b className="inbox-row-title">{props.meta.title === "" ? t.subSessions.untitled : props.meta.title}</b>
            <span className="inbox-row-ago row-trailing">{relativeTime(props.lastAt, t)}</span>
          </span>
          <span className="inbox-row-l2">{props.latest}</span>
        </span>
      </button>
      {props.asking && <ChannelReplyBox parentId={props.meta.parentId ?? ""} childId={props.meta.id} />}
    </div>
  );
}

/**
 * 「在问你」的行下展开的回答框：发送走 channel:speak（代父回信的既有路径，
 * author=user 的 reply），delivery 固定 steer——等回答的子会话是空闲的，steer
 * 本就退化为普通开轮；往它正在跑的那一轮里插话的场景留给父模型的 reply_subsession。
 * 原 ChannelColumn 的 composer（随面板删除）搬来：按内容定高（1–6 行）、Enter 发送
 * Shift+Enter 换行、失败就地亮错不吞。
 */
function ChannelReplyBox(props: { parentId: string; childId: string }) {
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
          trigger={({ open, toggle }) => (
            <Chip active={open} chevron title={t.chat.modelTip} onClick={toggle}>
              {view.model?.modelId ?? t.chat.noModel}
            </Chip>
          )}
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
