/**
 * 右栏 Sub-sessions 面板（子会话 PR4c）：主槽正看着一条有子会话的根会话时，这里
 * 是它们的入口——列表层（全部子会话，按 2.1 的规则排序）与会话层（挑中的那条，
 * 只读查看 + 审批，不给输入框）。两层状态机在 `sub-sessions-state.ts`（纯函数，
 * App 持有，本组件受控渲染）；排序/状态推导在 `sub-sessions-rows.ts`。
 *
 * 会话层不用 `RightPanelFrame`——那会在 `ChatView` 自己的 `Pane` 头之上再叠一层
 * 标题栏，两条标题挤在一起（`Pane` 已经画标题/改名/完成入口）。照辅助对话抽屉的
 * 先例（`Drawer.tsx`：标签条 + `ChatView`，标签条不是第二个 `RightPanelFrame`）：
 * 一条瘦头部（返回 / 状态 / Open as main）+ `ChatView`（自带标题头 + transcript
 * + 审批条，`hideComposer` 关掉输入框与排队条）。
 */
import { useCallback } from "react";
import { childSessions, type SessionMeta } from "@shared/session";
import { Icon, type IconName } from "../../shell/Icon";
import { PanelIconButton, PanelLine, RightPanelFrame } from "../../shell/RightPanel";
import { useChannelSummaries } from "./useChannelSummaries";
import {
  sortSubSessionRows,
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
  /**
   * 子会话工作记录里点标记 → 打开父子会话面板定位到那条消息（App 的 openChannel：
   * 够宽开内联列，不够宽换进右栏槽——那时就替换掉本面板）
   */
  onOpenChannel: (childId: string, messageId: string | null) => void;
  onClose: () => void;
  providersError: string | null;
}) {
  const t = useT();
  const children = childSessions(props.session.sessions, props.parentId);
  const summaries = useChannelSummaries(props.parentId);
  // 稳定引用：ChatView 把它折进 memo 过的通道上下文，每次渲染新建一个函数会打穿
  // TranscriptColumn 的 memo，子会话流式输出时整列逐帧重渲染。hook 放在分支之前
  const sessionChildId = props.nav.kind === "session" ? props.nav.sessionId : null;
  const { onOpenChannel } = props;
  const openOwnChannel = useCallback(
    (messageId: string | null) => {
      if (sessionChildId !== null) onOpenChannel(sessionChildId, messageId);
    },
    [onOpenChannel, sessionChildId],
  );

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
            height: 30,
            padding: "12px 14px",
            boxSizing: "content-box",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <PanelIconButton title={t.subSessions.back} onClick={props.onBackToList}>
            <Icon name="arrow-left" size={16} />
          </PanelIconButton>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
              minWidth: 0,
              fontSize: "var(--font-size-caption)",
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
              fontSize: "var(--font-size-caption)",
              cursor: "pointer",
            }}
          >
            {t.subSessions.openAsMain}
          </button>
          <PanelIconButton title={t.common.close} onClick={props.onClose}>
            <Icon name="x" size={16} />
          </PanelIconButton>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* 只读查看 + 审批：不给输入框（hideComposer），不传 onOpenSubSession(s)/onOpenParent——
              「UI 只做一层」，面板里查看的子会话不再嵌一层它自己的子会话入口。标记可点
              （onOpenOwnChannel）不违背这条：打开的是母会话那一个父子会话面板，不是新的一层 */}
          <ChatView
            session={props.view}
            providersError={props.providersError}
            hideComposer
            onOpenOwnChannel={openOwnChannel}
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

  // 列表层：waiting 最前，其次 needs approval，其次 running，其余按派出顺序（sub-sessions-rows.ts）。
  // 状态与通道卡同源（subSessionStatusOf）——两处必须画出同一个状态
  const rows = sortSubSessionRows(
    children.map((meta) => ({
      meta,
      status: subSessionStatusOf(meta.id, summaries.get(meta.id)?.status, props.engine),
    })),
  );

  return (
    <RightPanelFrame
      header={
        <>
          <Icon name="git-fork" size={16} style={{ color: "var(--color-text-secondary)" }} />
          <strong
            title={t.subSessions.of(props.parentTitle)}
            style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}
          >
            {t.rail.subSessions(children.length)}
          </strong>
        </>
      }
      contentKey="list"
      onClose={props.onClose}
    >
      {rows.length === 0 ? (
        <div style={{ padding: "var(--space-3)" }}>
          <PanelLine>{t.subSessions.none}</PanelLine>
        </div>
      ) : (
        <div style={{ display: "grid", padding: "var(--space-2) 0" }}>
          {rows.map((row) => (
            <SubSessionRow
              key={row.meta.id}
              meta={row.meta}
              status={row.status}
              onClick={() => props.onOpenChild(row.meta.id)}
            />
          ))}
        </div>
      )}
    </RightPanelFrame>
  );
}

function SubSessionRow(props: { meta: SessionMeta; status: SubSessionRowStatus; onClick: () => void }) {
  const t = useT();
  const status = props.status;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="sub-session-row"
      style={{
        display: "grid",
        gap: 2,
        width: "100%",
        padding: "var(--space-2) var(--space-4)",
        border: 0,
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <Icon
          name={STATUS_ICON[status]}
          size={13}
          strokeWidth={1.8}
          spin={status === "running"}
          style={{ flex: "0 0 auto", color: STATUS_COLOR[status] }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "var(--font-size-control)",
            color: "var(--color-text-primary)",
          }}
        >
          {props.meta.title === "" ? t.subSessions.untitled : props.meta.title}
        </span>
        <span
          style={{
            flex: "0 0 auto",
            fontSize: "var(--font-size-caption)",
            color: STATUS_COLOR[status],
          }}
        >
          {t.subSessions.rowStatus[status]}
        </span>
      </span>
      <span
        style={{
          paddingInlineStart: 21,
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-micro)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.meta.modelId}
      </span>
    </button>
  );
}
