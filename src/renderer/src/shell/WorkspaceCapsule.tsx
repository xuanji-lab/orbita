import type { SessionMeta } from "@shared/session";
import { Icon } from "./Icon";
import { CapTitle } from "./SessionCapsule.tsx";
import { IconButton } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { StatusPie } from "./StatusPie";
import { sessionAgeLabel } from "./relative-time.ts";
import { StarFigure } from "../features/galaxy-designer/GalaxyDesigner.tsx";
import { useAvatarBySize, useGalaxyDesign } from "../features/galaxy-designer/useGalaxyDesign.ts";
import type { HeaderStatus } from "../features/chat/agent-status.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { useT } from "../locale.ts";
import "./agent-row.css";

/**
 * 工作区自己的 New Task 页的页头（编排形态；照 Claude 桌面版 Bots 的页头：头像 + 名字 + 状态胶囊）。
 * 住在工具栏居中那颗胶囊里（与会话胶囊同一套 .cap-sess 几何，左对齐），不另造页头：
 * - 头像是这座星系的主星（与侧栏行同一份设计稿，静态）；名字是工作区名；
 * - 状态胶囊说真话：有等你的 → 「等你确认 · N」，点了直达那一件；有在跑的 → 「在外面干活 · N」；否则「就绪」。
 *   没有计时：数据里没有一次运行的起点，不拿「看到它的时刻」冒充；
 * - 右端「会话」菜单：编排侧不摆单智能体那套会话树，回看靠这里最近几条与「在单智能体里看全部」。
 */
export function WorkspaceCapsule(props: {
  workspaceId: string | null;
  name: string;
  status: HeaderStatus;
  /** 给了 = 正看着这个工作区的一条会话：页头变「头像 + 智能体名 › 任务名」，不摆状态胶囊（那是工作区页的），不露会话 id */
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
          <StarFigure bySize={bySize} design={design} size={22} label={t.agents.avatar(props.name)} />
        </span>
        <strong className="cap-title" title={props.name}>
          {props.name}
        </strong>
        {props.task != null ? (
          <>
            <Icon name="chevron-right" size={12} strokeWidth={1.8} className="cap-sep" />
            <CapTitle title={props.task.title} onRename={props.task.onRename} />
          </>
        ) : jump !== null ? (
          <button type="button" className="quiet-control cap-status" title={t.agents.statusWaitingTip} onClick={() => props.onOpenSession(jump)}>
            {statusBody}
          </button>
        ) : (
          <span className="cap-status" data-kind={status.status}>
            {statusBody}
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
