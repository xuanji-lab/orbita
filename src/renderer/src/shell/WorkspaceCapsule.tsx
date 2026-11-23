import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { StatusPie } from "./StatusPie";
import { StarFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { useAvatarBySize, useGalaxyDesign } from "../features/galaxy-designer/useGalaxyDesign.ts";
import type { HeaderStatus } from "../features/chat/agent-status.ts";
import { useT } from "../locale.ts";
import "./agent-row.css";

/**
 * 编排的页头（照 Claude 桌面版 Bots 的页头：头像 + 名字 + 状态胶囊）。New Task 页与对话页**始终**是这一个：
 * - 头像就是主智能体本身（这座星系的主星，与侧栏行同一份设计稿，静态），不是缩小的星系；名字是工作区名；
 * - 状态胶囊说真话：有等你的 → 「等你 · N」，点了直达那一件；有在跑的 → 「在跑 · N」；否则「空闲」。不出现任务标题；
 * - 右端「会话」菜单按天回看这个工作区的主对话（一个工作区一条长对话）：点一天滚到那天的第一句。
 *   只列已加载的那一段里的日子；更早的往上翻会加载（菜单尾说明）。
 */
export function WorkspaceCapsule(props: {
  workspaceId: string | null;
  name: string;
  status: HeaderStatus;
  /** 主对话的日子（新的在前）；还没有主对话为 null */
  days: { day: string; label: string; count: number; firstUserId: string }[] | null;
  /** 正看着的是不是主对话（不是的话菜单第一项是「回到主对话」） */
  viewingMain: boolean;
  /** 主对话还有更早的没加载 */
  hasEarlier: boolean;
  onOpenSession: (id: string) => void;
  onOpenMain: () => void;
  onOpenDay: (firstUserId: string) => void;
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
  const tm = t.orchestra.dayMenu;
  const items: MenuItem[] =
    props.days === null
      ? [{ id: "none", label: tm.none, disabled: true, onSelect: () => undefined }]
      : [
          ...(props.viewingMain ? [] : [{ id: "main", label: tm.openMain, icon: "message-square" as const, onSelect: props.onOpenMain }]),
          ...props.days.map(
            (day): MenuItem => ({
              id: `day:${day.day}`,
              label: day.label,
              hint: tm.count(day.count),
              onSelect: () => props.onOpenDay(day.firstUserId),
            }),
          ),
          ...(props.hasEarlier ? [{ id: "earlier", label: tm.earlier, disabled: true, onSelect: () => undefined }] : []),
        ];
  items.push({ id: "all-rule", label: "", rule: true }, { id: "all", label: t.agents.sessionsAll, icon: "bot", onSelect: props.onSeeAll });
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
        {jump !== null ? (
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
