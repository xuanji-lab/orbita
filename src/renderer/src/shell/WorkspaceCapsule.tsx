import type { SessionMeta } from "@shared/session";
import { Icon } from "./Icon";
import { CapTitle } from "./SessionCapsule.tsx";
import { IconButton } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { StatusPie } from "./StatusPie";
import { sessionAgeLabel } from "./relative-time.ts";
import { DustFigure, StarFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { useAvatarBySize, useGalaxyDesign } from "../features/galaxy-designer/useGalaxyDesign.ts";
import type { HeaderStatus } from "../features/chat/agent-status.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { useT } from "../locale.ts";
import "./agent-row.css";

/**
 * 编排的页头（照 Claude 桌面版 Bots 的页头：头像 + 名字 + 状态胶囊）。New Task 页与对话页都是它：
 * - 头像就是主智能体本身（这座星系的主星，与侧栏行同一份设计稿，静态），不是缩小的星系；名字是工作区名；
 * - 状态胶囊说真话：有等你的 → 「等你 · N」，点了直达那一件；有在跑的 → 「在跑 · N」；否则「空闲」；
 * - 对话页（正看着一条会话）在状态后面多一个次级的会话标题（可改名），不露会话 id；New Task 页没有这一段；
 * - 右端「会话」菜单：这个工作区最近几条，是右栏树状图之外的捷径。
 */
export function WorkspaceCapsule(props: {
  workspaceId: string | null;
  name: string;
  status: HeaderStatus;
  /** 给了 = 正看着这个工作区的一条会话（对话页）：状态后面接一个次级的会话标题，不露会话 id */
  task?: { title: string; onRename?: ((title: string) => void) | undefined } | null;
  recent: { rows: { meta: SessionMeta; state: SessionRunState }[]; total: number };
  now: number;
  onOpenSession: (id: string) => void;
  onSeeAll: () => void;
}) {
  const t = useT();
  const bySize = useAvatarBySize();
  const { design } = useGalaxyDesign(props.workspaceId ?? "");
  const { status } = props;
  const word = t.agents.status[status.status];
  const statusText = status.count === null ? word : `${word} · ${status.count}`;
  const statusBody = (
    <>
      {status.status === "idle" ? (
        <span className="cap-status-dot" aria-hidden="true" />
      ) : (
        <StatusPie state={status.status === "waiting" ? "waiting" : "running"} />
      )}
      <span>{statusText}</span>
    </>
  );
  const jump = status.sessionId;
  const items: MenuItem[] = [
    ...props.recent.rows.map(
      ({ meta, state }): MenuItem => ({
        id: meta.id,
        label: meta.title.trim() === "" ? t.common.newTask : meta.title,
        hint: sessionAgeLabel(meta.updatedAt, props.now, t),
        ...(state === null ? {} : { avatar: <StatusPie state={state} /> }),
        onSelect: () => props.onOpenSession(meta.id),
      }),
    ),
    ...(props.recent.rows.length === 0 ? [{ id: "none", label: t.agents.sessionsNone, disabled: true, onSelect: () => undefined }] : []),
    { id: "all-rule", label: "", rule: true },
    {
      id: "all",
      label: props.recent.total > props.recent.rows.length ? `${t.agents.sessionsAll} (${props.recent.total})` : t.agents.sessionsAll,
      icon: "bot",
      onSelect: props.onSeeAll,
    },
  ];
  return (
    <div className="cap-sess" style={{ width: "100%", height: "100%" }}>
      <div className="cap-sl" />
      <div className="cap-sc">
        <span className="cap-avatar">
          {props.workspaceId === null ? (
            <DustFigure size={22} label={t.agents.homeAvatar} />
          ) : (
            <StarFigure bySize={bySize} design={design} size={22} label={t.agents.avatar(props.name)} />
          )}
        </span>
        <strong className="cap-title" title={props.name}>
          {props.name}
        </strong>
        {jump !== null ? (
          <button type="button" className="quiet-control cap-status" title={t.agents.statusWaitingTip} onClick={() => props.onOpenSession(jump)}>
            {statusBody}
          </button>
        ) : (
          <span className="cap-status" data-kind={status.status}>
            {statusBody}
          </span>
        )}
        {props.task != null && (
          <span className="cap-task">
            <Icon name="chevron-right" size={12} strokeWidth={1.8} className="cap-sep" />
            <CapTitle title={props.task.title} onRename={props.task.onRename} />
          </span>
        )}
      </div>
      <div className="cap-sr">
        <Menu
          items={items}
          align="end"
          panelMinWidth={220}
          panelMaxWidth={320}
          trigger={({ open, toggle }) => (
            <IconButton label={t.agents.sessionsMenu} title={t.agents.sessionsMenuTip} size={24} active={open} ariaExpanded={open} onClick={toggle}>
              <Icon name="history" size={14} strokeWidth={1.8} />
            </IconButton>
          )}
        />
      </div>
    </div>
  );
}
