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
import { useState } from "react";
import { childSessions, type SessionMeta } from "@shared/session";
import type { ChannelSummary } from "@shared/channel";
import { Icon, type IconName } from "../../shell/Icon";
import { PanelIconButton, PanelLine, RightPanelFrame } from "../../shell/RightPanel";
import { useChannelSummaries } from "./useChannelSummaries";
import { sortSubSessionRows, subSessionRowStatus, type SubSessionRowStatus } from "./sub-sessions-rows";
import type { SubSessionsView } from "./sub-sessions-state";
import { ChatView } from "./ChatView";
import type { ChatSession, SessionEngine } from "./useChatSession";

const STATUS_COPY: Record<SubSessionRowStatus, string> = {
  running: "running",
  waiting: "waiting for you",
  approval: "needs approval",
  done: "done",
  failed: "failed",
  idle: "idle",
};

const STATUS_COLOR: Record<SubSessionRowStatus, string> = {
  running: "var(--color-accent)",
  waiting: "var(--color-warning)",
  approval: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-danger)",
  idle: "var(--color-text-tertiary)",
};

const STATUS_ICON: Record<SubSessionRowStatus, IconName> = {
  running: "loader-circle",
  waiting: "message-square",
  approval: "shield-check",
  done: "circle-check",
  failed: "triangle-alert",
  idle: "circle-off",
};

export function SubSessionsPanel(props: {
  parentId: string;
  parentTitle: string;
  /** 主槽的 ChatSession：读 `sessions`（子会话清单）与 `phaseOf`（在跑与否） */
  session: ChatSession;
  /** 只用它的 `states`（每条子会话的审批槽）——引擎级，不随「当前看哪条」变化 */
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
  onClose: () => void;
  providersError: string | null;
}) {
  const children = childSessions(props.session.sessions, props.parentId);
  const summaries = useChannelSummaries(props.parentId);

  if (props.nav.kind === "session") {
    const childId = props.nav.sessionId;
    const child = children.find((meta) => meta.id === childId);
    const status = statusOf(childId, summaries, props.engine, props.session);
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
          <PanelIconButton title="Back to sub-sessions" onClick={props.onBackToList}>
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
            {STATUS_COPY[status]}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => props.onOpenAsMain(childId)}
            title="Switch the main pane to this sub-session"
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
            Open as main
          </button>
          <PanelIconButton title="Close" onClick={props.onClose}>
            <Icon name="x" size={16} />
          </PanelIconButton>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* 只读查看 + 审批：不给输入框（hideComposer），不传 onOpenSubSession(s)/onOpenParent——
              「UI 只做一层」，面板里查看的子会话不再嵌一层它自己的通道/子会话入口 */}
          <ChatView session={props.view} providersError={props.providersError} hideComposer />
        </div>
        {child === undefined && (
          // 极少见：子会话在面板开着时被删了。ChatView 会走它自己的「这条会话不存在」
          // 降级，这里只补一行说明面板为什么显示得空落落的
          <div style={{ padding: "var(--space-3)" }}>
            <PanelLine>This sub-session is gone.</PanelLine>
          </div>
        )}
      </div>
    );
  }

  // 列表层：waiting 最前，其次 needs approval，其次 running，其余按派出顺序（sub-sessions-rows.ts）
  const rows = sortSubSessionRows(
    children.map((meta) => ({
      meta,
      status: statusOf(meta.id, summaries, props.engine, props.session),
    })),
  );

  return (
    <RightPanelFrame
      header={
        <>
          <Icon name="git-fork" size={16} style={{ color: "var(--color-text-secondary)" }} />
          <strong
            title={`Sub-sessions of "${props.parentTitle}"`}
            style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}
          >
            Sub-sessions ({children.length})
          </strong>
        </>
      }
      contentKey="list"
      onClose={props.onClose}
    >
      {rows.length === 0 ? (
        <div style={{ padding: "var(--space-3)" }}>
          <PanelLine>No sub-sessions yet.</PanelLine>
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

/** 一行的状态：通道摘要优先给 waiting/done/failed，审批槽给 approval，否则看 phase（子会话 PR4c）。 */
function statusOf(
  childId: string,
  summaries: ReadonlyMap<string, ChannelSummary>,
  engine: SessionEngine,
  session: ChatSession,
): SubSessionRowStatus {
  return subSessionRowStatus({
    channelStatus: summaries.get(childId)?.status,
    needsApproval: (engine.states.get(childId)?.approvals.length ?? 0) > 0,
    running: session.phaseOf(childId) !== "idle",
  });
}

function SubSessionRow(props: { meta: SessionMeta; status: SubSessionRowStatus; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const status = props.status;
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gap: 2,
        width: "100%",
        padding: "var(--space-2) var(--space-4)",
        border: 0,
        background: hover ? "var(--color-bg-hover)" : "transparent",
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
          {props.meta.title === "" ? "Untitled" : props.meta.title}
        </span>
        <span
          style={{
            flex: "0 0 auto",
            fontSize: "var(--font-size-caption)",
            color: STATUS_COLOR[status],
          }}
        >
          {STATUS_COPY[status]}
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
