import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SessionMeta } from "@shared/session";
import type { OrchestraView } from "@shared/settings";
import type { ArtifactSummary } from "@shared/revert";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { StatusPie } from "../../shell/StatusPie";
import { relativeTime } from "../../shell/relative-time.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { Segmented } from "../settings/SettingControls";
import { StarFigure } from "../galaxy-designer/StarFigure.tsx";
import { useAvatarBySize, useGalaxyDesign } from "../galaxy-designer/useGalaxyDesign.ts";
import { starExtentRatio, starOf } from "../galaxy-designer/design.ts";
import { LocaleContext, useT } from "../../locale.ts";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { headerStatusOf } from "./agent-status.ts";
import { HomeGalaxy } from "./HomeGalaxy.tsx";
import { starRadius } from "./galaxy.ts";
import { scopeGalaxy, scopeSummary, stateIndexOf } from "./galaxy-data.ts";
import { orchestraTree, type TreeNode } from "./orchestra-data.ts";
import { collabGraph, demoCollab, layoutCollab, type CollabEdge, type CollabGraph, type CollabNode } from "./collab-graph.ts";
import { useParentChannels } from "./useChannelMessages.ts";
import type { ChatSession } from "./useChatSession.ts";
import "./orchestra-panel.css";

/**
 * 右栏「编排」面板（编排形态才有入口）：同一份数据三种看法，选择记在设置里（settings.orchestraView）。
 * - 树状图：根 = 主智能体；下一层 = 派出去的活 + 这个工作区的会话；子会话再往下一层。窄右栏也读得清，是缺省。
 * - 星系图：与 New Task 页同一个星系组件（同一套锁定框 + 引线）。右栏窄：低于 GALAXY_MIN_WIDTH 不硬缩，提示切树或加宽。
 * - 协作图：有向、允许成环；只画真实的边（collab-graph.ts），演示图要点了才出且标明。
 *
 * 和「子会话」面板并列、不并入：子会话面板是**一条会话**的收件箱（要你回答的、交回的，能代父回信、终止），
 * 粒度是「这条会话的子会话」，只在打开有子会话的根会话时出现；编排面板是**一个工作区**的全景，粒度是「这个智能体手下的一切」，
 * 只读、点了去看。两者合一会让收件箱的动作（回信、终止）漂进全景、全景的量（四百条会话）压进收件箱。
 */

/** 星系图在右栏里的最小可用宽度（px）：再窄六圈轨道与引线挤成一团，不如换树状图 */
export const GALAXY_MIN_WIDTH = 360;
/** 「加宽面板」一下加到多宽 */
export const GALAXY_WIDEN_TO = 440;

export function OrchestraPanel(props: {
  session: ChatSession;
  workspaceId: string | null;
  workspaceName: string;
  main: SessionMeta | null;
  view: OrchestraView;
  onView: (view: OrchestraView) => void;
  onOpenSession: (id: string) => void;
  /** 面板此刻的渲染宽度（星系图判断够不够宽） */
  width: number;
  onWiden: (width: number) => void;
  onSeeAll: () => void;
}) {
  const t = useT();
  const to = t.orchestra;
  const states = stateIndexOf(props.session);
  const now = Date.now();
  const tree = orchestraTree({
    sessions: props.session.sessions,
    workspaceId: props.workspaceId,
    mainId: props.main?.id ?? null,
    stateOf: states.state,
    now,
  });
  const summary = scopeSummary(props.session.sessions, props.workspaceId, states.state);
  return (
    <RightPanelFrame
      contentKey={`orchestra-${props.workspaceId ?? "home"}`}
      header={
        <>
          <PanelTitle icon={FEATURE_ICON.orchestra} title={to.panelTitle} />
          <span className="orch-cap-ws" title={props.workspaceName}>
            {props.workspaceName}
          </span>
        </>
      }
      subheader={
        <div className="orch-views">
          <Segmented
            label={to.viewLabel}
            value={props.view}
            options={(["tree", "galaxy", "graph"] as const).map((value) => ({ value, label: to.views[value] }))}
            onChange={props.onView}
          />
        </div>
      }
    >
      {props.view === "tree" ? (
        <TreeView
          tree={tree}
          workspaceId={props.workspaceId}
          name={props.workspaceName}
          status={headerStatusOf(summary)}
          now={now}
          onOpen={props.onOpenSession}
          onSeeAll={props.onSeeAll}
        />
      ) : props.view === "galaxy" ? (
        <GalaxyView
          session={props.session}
          workspaceId={props.workspaceId}
          name={props.workspaceName}
          width={props.width}
          onWiden={() => props.onWiden(GALAXY_WIDEN_TO)}
        />
      ) : (
        <GraphView
          main={props.main}
          jobs={tree.jobs.map((node) => node.meta)}
          otherSessions={tree.sessions.length + tree.older}
          name={props.workspaceName}
          workspaceId={props.workspaceId}
          stateOf={states.state}
          onOpen={props.onOpenSession}
        />
      )}
    </RightPanelFrame>
  );
}

// ── 树状图 ──────────────────────────────────────────────────────────────

function MainCard(props: { workspaceId: string | null; name: string; status: ReturnType<typeof headerStatusOf> }) {
  const t = useT();
  const bySize = useAvatarBySize();
  const { design } = useGalaxyDesign(props.workspaceId ?? "");
  const word = t.agents.status[props.status.status];
  return (
    <div className="orch-main">
      <span className="orch-main-avatar">
        <StarFigure bySize={bySize} design={design} size={28} label={t.agents.avatar(props.name)} />
      </span>
      <span className="orch-main-body">
        <span className="orch-main-l1">
          <strong className="orch-main-name">{props.name}</strong>
          <span className="orch-main-status" data-kind={props.status.status}>
            {props.status.status === "idle" ? (
              <span className="cap-status-dot" aria-hidden="true" />
            ) : (
              <StatusPie state={props.status.status === "waiting" ? "waiting" : "running"} />
            )}
            {props.status.count === null ? word : `${word} · ${props.status.count}`}
          </span>
        </span>
        <span className="orch-main-l2">
          {t.orchestra.mainRole} · {t.orchestra.mainRoleLine}
        </span>
      </span>
    </div>
  );
}

function TreeView(props: {
  tree: ReturnType<typeof orchestraTree>;
  workspaceId: string | null;
  name: string;
  status: ReturnType<typeof headerStatusOf>;
  now: number;
  onOpen: (id: string) => void;
  onSeeAll: () => void;
}) {
  const t = useT();
  const to = t.orchestra;
  const { tree } = props;
  return (
    <div className="ssp-list orch-tree" data-view="tree">
      <MainCard workspaceId={props.workspaceId} name={props.name} status={props.status} />
      <div className="orch-branch">
        <section className="ssp-group" aria-label={to.jobsGroup(tree.jobs.length)}>
          <header className="ssp-group-head">{to.jobsGroup(tree.jobs.length)}</header>
          {tree.main === null ? (
            <PanelEmpty icon="message-square" hint={to.noMainHint}>
              {to.noMain}
            </PanelEmpty>
          ) : tree.jobs.length === 0 ? (
            <PanelEmpty icon={FEATURE_ICON.subsessions}>{to.noJobs}</PanelEmpty>
          ) : (
            <div className="ssp-card">
              {tree.jobs.map((node) => (
                <TreeRow key={node.meta.id} node={node} now={props.now} onOpen={props.onOpen} />
              ))}
            </div>
          )}
          <p className="orch-note">{to.standIn}</p>
        </section>
        <section className="ssp-group" aria-label={to.sessionsGroup(tree.sessions.length)}>
          <header className="ssp-group-head">{to.sessionsGroup(tree.sessions.length)}</header>
          {tree.sessions.length > 0 && (
            <div className="ssp-card">
              {tree.sessions.map((node) => (
                <TreeRow key={node.meta.id} node={node} now={props.now} onOpen={props.onOpen} />
              ))}
            </div>
          )}
          {tree.older > 0 && (
            <PanelEmpty icon="archive" exit={{ label: t.agents.sessionsAll, onClick: props.onSeeAll }}>
              {to.older(tree.older)}
            </PanelEmpty>
          )}
        </section>
      </div>
    </div>
  );
}

function stateWord(t: ReturnType<typeof useT>, state: SessionRunState): string | null {
  if (state === "waiting") return t.agents.status.waiting;
  if (state === "running") return t.agents.status.running;
  return null;
}

/** 树的一行：状态饼（没状态是一颗空心点）+ 名字 + 行尾时间；有子会话的行首多一个展开键，子会话缩进一层、左边一根发丝线 */
function TreeRow(props: { node: TreeNode; now: number; onOpen: (id: string) => void; depth?: number }) {
  const t = useT();
  const { node } = props;
  const [open, setOpen] = useState(node.activeBelow);
  const title = node.meta.title.trim() === "" ? t.common.newTask : node.meta.title;
  const kids = node.children.length + node.hiddenChildren;
  const word = stateWord(t, node.state);
  return (
    <>
      <div className="ssp-row orch-row" data-state={node.state ?? undefined} data-depth={props.depth ?? 0}>
        <span className="orch-twisty-slot">
          {kids > 0 && (props.depth ?? 0) === 0 && (
            <button
              type="button"
              className="orch-twisty"
              aria-expanded={open}
              aria-label={t.orchestra.moreChildren(kids)}
              onClick={() => setOpen(!open)}
            >
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
            </button>
          )}
        </span>
        <button type="button" className="ssp-row-main" title={title} onClick={() => props.onOpen(node.meta.id)}>
          <span className="ssp-bot">
            {node.state === null ? <span className="orch-idle-dot" aria-hidden="true" /> : <StatusPie state={node.state} />}
          </span>
          <span className="ssp-body">
            <span className="ssp-l1">
              <span className="ssp-title">{title}</span>
              {word !== null && <span className="orch-row-word">{word}</span>}
              <span className="ssp-time row-trailing">{relativeTime(node.meta.updatedAt, t)}</span>
            </span>
          </span>
        </button>
      </div>
      {open && kids > 0 && (
        <div className="orch-kids">
          {node.children.map((child) => (
            <TreeRow key={child.meta.id} node={child} now={props.now} onOpen={props.onOpen} depth={1} />
          ))}
          {node.hiddenChildren > 0 && (props.depth ?? 0) === 0 && <p className="orch-more">{t.orchestra.moreChildren(node.hiddenChildren)}</p>}
        </div>
      )}
    </>
  );
}

// ── 星系图 ──────────────────────────────────────────────────────────────

function GalaxyView(props: { session: ChatSession; workspaceId: string | null; name: string; width: number; onWiden: () => void }) {
  const t = useT();
  const to = t.orchestra;
  const { design, edited } = useGalaxyDesign(props.workspaceId ?? "");
  if (props.width < GALAXY_MIN_WIDTH) {
    return (
      <div className="orch-pad">
        <PanelEmpty icon="orbit" hint={to.galaxyNarrowHint(GALAXY_MIN_WIDTH)} exit={{ label: to.widen, onClick: props.onWiden }}>
          {to.galaxyNarrow}
        </PanelEmpty>
      </div>
    );
  }
  const states = stateIndexOf(props.session);
  const star = starOf(design);
  const data = scopeGalaxy({
    sessions: props.session.sessions,
    workspaceId: props.workspaceId,
    stateOf: states.state,
    ownStateOf: states.own,
    now: Date.now(),
    starMass: star.mass,
    starExtent: starRadius(star.mass) * starExtentRatio(design),
    designedPlanet: edited && design.planet !== null ? { mass: design.planet.mass, composition: design.planet.composition } : null,
  });
  return (
    <div className="orch-galaxy" data-view="galaxy">
      <HomeGalaxy spec={data.spec} label={to.galaxyFigure(props.name)} starDesign={design} fill emptyHint={t.agents.emptyHint} />
    </div>
  );
}

// ── 协作图 ──────────────────────────────────────────────────────────────

/** 一批会话的产物摘要（文件账里的文件数与扩展名）；键变了（活的增减、某件活又动过）才重读 */
function useArtifactSummaries(jobs: readonly SessionMeta[]): Readonly<Record<string, ArtifactSummary>> {
  const key = jobs.map((meta) => `${meta.id}@${meta.updatedAt}`).join(",");
  const [summaries, setSummaries] = useState<Readonly<Record<string, ArtifactSummary>>>({});
  useEffect(() => {
    if (key === "") {
      setSummaries({});
      return;
    }
    let cancelled = false;
    const ids = key.split(",").map((part) => part.split("@")[0] ?? "");
    api.session
      .artifactSummary(ids)
      .then((next) => {
        if (!cancelled) setSummaries(next);
      })
      .catch((cause: unknown) => console.error("[orchestra] 产物摘要读取失败", cause));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return summaries;
}

function useBoxWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function GraphView(props: {
  main: SessionMeta | null;
  jobs: readonly SessionMeta[];
  otherSessions: number;
  name: string;
  workspaceId: string | null;
  stateOf: (meta: SessionMeta) => SessionRunState;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const to = t.orchestra;
  const lang = useContext(LocaleContext);
  const [demo, setDemo] = useState(false);
  const channels = useParentChannels(props.main?.id ?? null, props.jobs.map((meta) => meta.id));
  const artifacts = useArtifactSummaries(props.jobs);
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useBoxWidth(ref);
  const graph: CollabGraph | null = useMemo(() => {
    if (props.main === null) return null;
    if (demo) return demoCollab(props.main.id, props.name, to.mainRoleLine, lang === "zh");
    return collabGraph({
      main: props.main,
      mainName: props.name,
      mainRole: to.mainRoleLine,
      jobs: props.jobs,
      stateOf: props.stateOf,
      channels,
      artifacts,
    });
  }, [props.main, props.name, props.jobs, props.stateOf, channels, artifacts, demo, lang, to.mainRoleLine]);
  if (props.main === null || graph === null) {
    return (
      <div className="orch-pad">
        <PanelEmpty icon="message-square" hint={to.noMainHint}>
          {to.noMain}
        </PanelEmpty>
      </div>
    );
  }
  return (
    <div className="orch-graph-wrap" data-view="graph" data-demo={graph.demo || undefined}>
      <div className="orch-graph-notes">
        {graph.demo ? <p className="orch-note orch-note-demo">{to.graph.demoNote}</p> : <p className="orch-note">{to.graph.peerPending}</p>}
        <button type="button" className="notice-exit orch-demo-toggle" onClick={() => setDemo(!demo)} aria-pressed={demo}>
          {demo ? to.graph.demoOff : to.graph.demo}
        </button>
      </div>
      <div ref={ref} className="orch-graph-host">
        {width !== null && width > 0 && (
          <CollabCanvas graph={graph} width={width} workspaceId={props.workspaceId} name={props.name} onOpen={graph.demo ? null : props.onOpen} />
        )}
      </div>
      {!graph.demo && graph.nodes.length === 1 && <PanelEmpty icon={FEATURE_ICON.subsessions}>{to.noJobs}</PanelEmpty>}
      {!graph.demo && graph.hidden > 0 && <p className="orch-more">{to.moreChildren(graph.hidden)}</p>}
      {!graph.demo && props.otherSessions > 0 && <p className="orch-note">{to.graph.notDispatched(props.otherSessions)}</p>}
    </div>
  );
}

function arrowHead(x: number, y: number, dir: "down" | "left" | "right" | "up"): string {
  const s = 4;
  const f = (n: number): string => n.toFixed(1);
  if (dir === "down") return `M${f(x - s)} ${f(y - s * 1.4)}L${f(x)} ${f(y)}L${f(x + s)} ${f(y - s * 1.4)}Z`;
  if (dir === "up") return `M${f(x - s)} ${f(y + s * 1.4)}L${f(x)} ${f(y)}L${f(x + s)} ${f(y + s * 1.4)}Z`;
  if (dir === "left") return `M${f(x + s * 1.4)} ${f(y - s)}L${f(x)} ${f(y)}L${f(x + s * 1.4)} ${f(y + s)}Z`;
  return `M${f(x - s * 1.4)} ${f(y - s)}L${f(x)} ${f(y)}L${f(x - s * 1.4)} ${f(y + s)}Z`;
}

function edgeText(t: ReturnType<typeof useT>, edge: CollabEdge): { lead: string; body: string } {
  const g = t.orchestra.graph;
  const files = edge.files === null ? null : g.files(edge.files.files, edge.files.exts.join(" "));
  if (edge.kind === "task") return { lead: g.sent, body: edge.text ?? g.noBrief };
  if (edge.kind === "report") {
    const result = edge.pending ? g.notBack : (edge.text ?? g.noReport);
    return { lead: g.returned, body: files === null || edge.pending ? result : `${result} · ${files}` };
  }
  return { lead: "", body: files === null ? (edge.text ?? "") : `${edge.text ?? ""} · ${files}` };
}

/**
 * 协作图的画面：线与箭头在一张 SVG 里，卡与边上的字是绝对定位的 HTML（省略号、字体都走设计系统）。
 * 坐标全部来自 layoutCollab（确定的）；悬停一张卡只给它的边加亮（data-hot），不动任何位置。
 */
function CollabCanvas(props: {
  graph: CollabGraph;
  width: number;
  workspaceId: string | null;
  name: string;
  onOpen: ((id: string) => void) | null;
}) {
  const t = useT();
  const [hot, setHot] = useState<string | null>(null);
  const layout = useMemo(() => layoutCollab(props.graph, props.width), [props.graph, props.width]);
  const mainNode = props.graph.nodes[0];
  const isHot = (edge: CollabEdge): boolean => hot !== null && (edge.from === hot || edge.to === hot);
  return (
    <div className="orch-graph" style={{ height: layout.height }} data-hot={hot ?? undefined}>
      <svg className="orch-graph-lines" width={layout.width} height={layout.height} aria-hidden="true">
        {props.graph.edges.map((edge) => {
          const geo = layout.edges.get(edge.id);
          if (geo === undefined) return null;
          return (
            <g key={edge.id} className="orch-edge" data-kind={edge.kind} data-pending={edge.pending || undefined} data-hot={isHot(edge) || undefined}>
              <path className="orch-edge-line" d={geo.d} />
              <path className="orch-edge-arrow" d={arrowHead(geo.arrow.x, geo.arrow.y, geo.arrow.dir)} />
            </g>
          );
        })}
      </svg>
      {mainNode !== undefined && (
        <div className="orch-node orch-node-main" style={boxStyle(layout.main)}>
          <MainCardInGraph node={mainNode} workspaceId={props.workspaceId} name={props.name} />
        </div>
      )}
      {props.graph.nodes.slice(1).map((node) => {
        const box = layout.cards.get(node.id);
        if (box === undefined) return null;
        return (
          <JobCard
            key={node.id}
            node={node}
            style={boxStyle(box)}
            onOpen={props.onOpen}
            onHover={(on) => setHot(on ? node.id : null)}
            dim={hot !== null && hot !== node.id}
          />
        );
      })}
      {props.graph.edges.map((edge) => {
        const geo = layout.edges.get(edge.id);
        if (geo === undefined) return null;
        const text = edgeText(t, edge);
        return (
          <span
            key={`label-${edge.id}`}
            className="orch-edge-label"
            data-kind={edge.kind}
            data-pending={edge.pending || undefined}
            data-hot={isHot(edge) || undefined}
            style={boxStyle(geo.label)}
            title={`${text.lead} ${text.body}`.trim()}
          >
            {text.lead !== "" && <span className="orch-edge-lead">{text.lead}</span>}
            <span className="orch-edge-body">{text.body}</span>
          </span>
        );
      })}
    </div>
  );
}

function boxStyle(box: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return { left: box.x, top: box.y, width: box.w, height: box.h };
}

function MainCardInGraph(props: { node: CollabNode; workspaceId: string | null; name: string }) {
  const t = useT();
  const bySize = useAvatarBySize();
  const { design } = useGalaxyDesign(props.workspaceId ?? "");
  return (
    <div className="orch-main orch-main-graph">
      <span className="orch-main-avatar">
        <StarFigure bySize={bySize} design={design} size={28} label={t.agents.avatar(props.name)} />
      </span>
      <span className="orch-main-body">
        <span className="orch-main-l1">
          <strong className="orch-main-name">{props.name}</strong>
          <span className="orch-role-tag">{t.orchestra.mainRole}</span>
        </span>
        <span className="orch-main-l2">{props.node.role}</span>
      </span>
    </div>
  );
}

function JobCard(props: {
  node: CollabNode;
  style: React.CSSProperties;
  onOpen: ((id: string) => void) | null;
  onHover: (on: boolean) => void;
  dim: boolean;
}) {
  const t = useT();
  const g = t.orchestra.graph;
  const { node } = props;
  const word = stateWord(t, node.state);
  const body = (
    <>
      <span className="orch-job-l1">
        <span className="ssp-bot">{node.state === null ? <span className="orch-idle-dot" aria-hidden="true" /> : <StatusPie state={node.state} />}</span>
        <span className="orch-job-role">{node.role === "" ? t.common.newTask : node.role}</span>
      </span>
      <span className="orch-job-l2">
        {node.roleSource === "profile" ? g.roleFromProfile : g.roleFromTitle}
        {word !== null && ` · ${word}`}
      </span>
    </>
  );
  const common = {
    className: "orch-node orch-node-job",
    style: props.style,
    "data-state": node.state ?? undefined,
    "data-dim": props.dim || undefined,
    onMouseEnter: () => props.onHover(true),
    onMouseLeave: () => props.onHover(false),
    onFocus: () => props.onHover(true),
    onBlur: () => props.onHover(false),
  };
  const onOpen = props.onOpen;
  return onOpen === null ? (
    <div {...common}>{body}</div>
  ) : (
    <button type="button" {...common} title={node.title} onClick={() => onOpen(node.id)}>
      {body}
    </button>
  );
}
