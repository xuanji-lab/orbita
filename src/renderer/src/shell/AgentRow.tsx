import { useState } from "react";
import type { Workspace } from "@shared/workspace";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { StatusPie } from "./StatusPie";
import { sessionAgeLabel } from "./relative-time.ts";
import { DustFigure, StarFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { useGalaxyDesign } from "../features/galaxy-designer/useGalaxyDesign.ts";
import { useProtoVariants } from "../features/chat/proto-variants-store.ts";
import { rowLabelOf } from "../features/chat/proto-variants.ts";
import { agentLineOf, type AgentLine } from "../features/chat/agent-status.ts";
import type { ScopeSummary } from "../features/chat/galaxy-data.ts";
import { ActivityAvatar, SessionCaret, SubAgentFaces } from "./AgentActivity.tsx";
import { realSubAgentFaces, type RowActivity } from "./sidebar-activity.ts";
import { useSubAgentFixtures } from "./sidebar-activity-store.ts";
import { useT } from "../locale.ts";
import "./agent-row.css";

/**
 * 编排侧栏里的一行 = 一个工作区的主智能体（照 Claude 桌面版 Bots 的一行）：
 * 左头像（这座星系的主星，静态，不自转）、名字、右上角「多久没动了」，第二行说此刻的状态，有活要你动手时右端一枚小圆点。
 * 点行 = 打开这个工作区自己的 New Task 页。悬停才出现的动作键（设计星系 / 查看文件 / 移除）叠在右上角，
 * 不占位，静止的时间让位淡出（设计系统 *Trailing edges*）；双击名字改名，与单智能体的工作区行同一个手势。
 *
 * 头像用面板里设计过的那一份（useGalaxyDesign），没设计过就是默认主星——所有未设计的工作区长一个样，
 * 靠名字区分：没有真实的差异来源就不编一个（不随机上色）。
 */
export function AgentRow(props: {
  /** null = 「主目录」（不属于任何工作区的会话）：没有路径，不能改名 / 移除 / 看文件 */
  workspace: Workspace | null;
  summary: ScopeSummary;
  /** 「谁在干活」（编排形态下 Sidebar 才算；缺席 = 不画日冕 / 插入符 / 子智能体） */
  activity?: RowActivity;
  /** 这一行就是眼下打开的那座星系（页面或其中一条会话） */
  active: boolean;
  /** 星系设计面板正开着这个工作区 */
  designing: boolean;
  now: number;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onBrowse: () => void;
  onDesign: () => void;
}) {
  const t = useT();
  const { workspace, summary } = props;
  const name = workspace === null ? t.agents.home : workspace.name;
  const { design } = useGalaxyDesign(workspace?.id ?? "");
  // 主标签仍是工作区名；候选 agentName=on 时写「智能体名 · 工作区名」（window.orbitaProto，默认关）
  const variants = useProtoVariants();
  const label = workspace === null ? name : rowLabelOf(variants.agentName, name, design.star?.name ?? "");
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const line = agentLineOf(summary);
  // 「谁在干活」：主智能体日冕、会话插入符、子智能体小头像都来自真数据（子智能体 = 有归属的子会话，attributionOf）；
  // 演示数据（?fixture=sub-agents）照旧能叠在后面，只用来拍满载
  const fixtures = useSubAgentFixtures();
  const activity = props.activity;
  const real =
    workspace === null || activity === undefined
      ? { faces: [], leftoverRunning: 0, leftoverWaiting: 0 }
      : realSubAgentFaces(activity.subAgents, (design.planets ?? []).map((planet) => planet.id));
  const agents = workspace === null || activity === undefined ? [] : [...real.faces, ...(fixtures[workspace.name] ?? [])];
  const avatarLabel = workspace === null ? t.agents.homeAvatar : t.agents.avatar(name);
  const figure =
    workspace === null ? (
      <DustFigure size={28} label={avatarLabel} />
    ) : (
      // 固定直径（设计审查 R10：按质量缩放的 3px 差别读不出「谁更重」，只剩左缘参差）
      <StarFigure bySize={false} design={design} size={26} label={avatarLabel} />
    );
  const commit = (): void => {
    if (editing !== null) props.onRename(editing);
    setEditing(null);
  };
  return (
    <div
      className="agent-row"
      data-active={props.active || undefined}
      data-waiting={line.status === "waiting" || undefined}
      data-designing={props.designing || undefined}
      data-armed={armed || undefined}
      data-activity={activity === undefined ? undefined : "on"}
      onMouseLeave={() => setArmed(false)}
    >
      <button
        type="button"
        className="agent-row-main"
        aria-current={props.active ? "page" : undefined}
        title={t.agents.rowOpenTip(name)}
        onClick={props.onOpen}
      >
        {activity === undefined ? <span className="agent-avatar">{figure}</span> : <ActivityAvatar activity={activity} figure={figure} />}
        <span className="agent-body">
          <span className="agent-line">
            {editing === null ? (
              <strong
                className="agent-name"
                title={workspace === null ? undefined : t.sidebar.workspacePathTip(workspace.path)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (workspace !== null) setEditing(workspace.name);
                }}
              >
                {label}
              </strong>
            ) : (
              <input
                className="agent-name-input"
                autoFocus
                value={editing}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setEditing(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit();
                  if (event.key === "Escape") setEditing(null);
                }}
              />
            )}
            {summary.lastActive !== null && (
              <span className="agent-time row-trailing">{sessionAgeLabel(summary.lastActive, props.now, t)}</span>
            )}
          </span>
          <span className="agent-line agent-status">
            <SubAgentFaces design={design} agents={agents} size={14} />
            <StatusLine line={line} home={workspace === null} />
            {activity !== undefined && <SessionCaret count={activity.sessionsRunning + real.leftoverRunning} />}
            {props.summary.attention > 0 && (
              <span className="agent-dot row-trailing" data-kind={props.summary.waiting > 0 ? "waiting" : "unread"} role="img" aria-label={props.summary.waiting > 0 ? t.agents.status.waiting : t.agents.unread} />
            )}
          </span>
        </span>
      </button>
      {workspace !== null && <span className="agent-acts">
        <IconButton
          label={props.designing ? t.galaxyDesigner.diyOpen : t.galaxyDesigner.diy}
          title={props.designing ? t.galaxyDesigner.diyOpen : t.galaxyDesigner.diy}
          size={20}
          active={props.designing}
          className="agent-act-diy"
          onClick={props.onDesign}
          style={{ borderRadius: "var(--radius-xs)", color: props.designing ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}
        >
          <Icon name="paintbrush" size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          label={t.focus.browseFiles}
          title={t.focus.browseFiles}
          size={20}
          onClick={props.onBrowse}
          style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-tertiary)" }}
        >
          <Icon name="list-tree" size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          label={armed ? t.sidebar.removeArmed : t.sidebar.remove}
          title={armed ? t.sidebar.removeArmedTip : t.sidebar.removeTip}
          size={20}
          onClick={() => (armed ? props.onRemove() : setArmed(true))}
          style={{ borderRadius: "var(--radius-xs)", color: armed ? "var(--color-danger)" : "var(--color-text-tertiary)" }}
        >
          <Icon name="trash-2" size={14} strokeWidth={1.8} />
        </IconButton>
      </span>}
    </div>
  );
}

/** 第二行：先说状态词（等你 / 在跑带件数与状态饼，空闲只一个词）；空闲时再补一个更浅的「最近：标题」 */
function StatusLine(props: { line: AgentLine; home: boolean }) {
  const t = useT();
  const { line } = props;
  const word = t.agents.status[line.status];
  // 星际空间空闲时第二行只说它是什么（不属于任何工作区），不说「空闲 · 最近：…」；等你 / 在跑时照样先说状态
  if (props.home && line.status === "idle") return <span className="agent-status-word">{t.agents.homeLine}</span>;
  return (
    <>
      {line.status === "running" && <StatusPie state="running" />}
      {line.status === "waiting" && <StatusPie state="waiting" />}
      {line.status === "failed" && <StatusPie state="failed" />}
      <span className="agent-status-word">{line.count === null ? word : `${word} · ${line.count}`}</span>
      {line.recent !== null && <span className="agent-status-recent">{`${t.agents.recent}：${line.recent}`}</span>}
    </>
  );
}
