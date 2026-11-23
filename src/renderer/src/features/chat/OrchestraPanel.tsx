import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SessionMeta } from "@shared/session";
import { sortChannelMessages, type ChannelKey, type ChannelMessage } from "@shared/channel";
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
import { agentInputsOf, agentMapOf, agentPlanetsOf, starExtentRatio, starOf } from "../galaxy-designer/design.ts";
import { LocaleContext, useT } from "../../locale.ts";
import { useProtoVariants } from "./proto-variants-store.ts";
import { nameOrderOf } from "./proto-variants.ts";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { headerStatusOf } from "./agent-status.ts";
import { HomeGalaxy } from "./HomeGalaxy.tsx";
import { starRadius } from "./galaxy.ts";
import { scopeGalaxy, scopeSummary, stateIndexOf } from "./galaxy-data.ts";
import { orchestraTree, type TreeNode } from "./orchestra-data.ts";
import { collabGraph, demoCollab, layoutCollab, type CollabEdge, type CollabGraph, type CollabNode } from "./collab-graph.ts";
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
  view: OrchestraView;
  onView: (view: OrchestraView) => void;
  onOpenSession: (id: string) => void;
  /** 面板此刻的渲染宽度（星系图判断够不够宽） */
  width: number;
  onWiden: (width: number) => void;
  onSeeAll: () => void;
  /**
   * 眼下在 New Task 页（还没打开会话）：页面本身就是这座星系，右栏不再画第二座（设计审查 R3）——
   * 视图里没有「星系图」，存着的是星系图也按树状图显示（设置里的选择不改，回到对话页仍是星系图）
   */
  onNewTaskPage: boolean;
  /** 主面板正开着的会话 id（树里标「你在这儿」，R7）；New Task 页为 null */
  currentId: string | null;
}) {
  const t = useT();
  const to = t.orchestra;
  const view: OrchestraView = props.onNewTaskPage && props.view === "galaxy" ? "tree" : props.view;
  const states = stateIndexOf(props.session);
  const now = Date.now();
  const tree = orchestraTree({ sessions: props.session.sessions, workspaceId: props.workspaceId, stateOf: states.state, now });
  const summary = scopeSummary(props.session.sessions, props.workspaceId, states);
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
            value={view}
            options={(props.onNewTaskPage ? (["tree", "graph"] as const) : (["tree", "galaxy", "graph"] as const)).map((value) => ({ value, label: to.views[value] }))}
            onChange={props.onView}
          />
        </div>
      }
    >
      {view === "tree" ? (
        <TreeView
          currentId={props.currentId}
          tree={tree}
          workspaceId={props.workspaceId}
          name={props.workspaceName}
          status={headerStatusOf(summary)}
          now={now}
          onOpen={props.onOpenSession}
          onSeeAll={props.onSeeAll}
        />
      ) : view === "galaxy" ? (
        <GalaxyView
          session={props.session}
          workspaceId={props.workspaceId}
          name={props.workspaceName}
          width={props.width}
          onWiden={() => props.onWiden(GALAXY_WIDEN_TO)}
        />
      ) : (
        <GraphView
          session={props.session}
          roots={[...tree.recent, ...tree.older].map((node) => node.meta)}
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

function MainCard(props: { workspaceId: string | null; name: string; status: ReturnType<typeof headerStatusOf>; sessions: number }) {
  const t = useT();
  const bySize = useAvatarBySize();
  const { design, origin } = useGalaxyDesign(props.workspaceId ?? "");
  const word = t.agents.status[props.status.status];
  // 名字顺序与页头同一条：工作区名为主、智能体名为副（候选 agentName=on 时反过来）
  const names = nameOrderOf(useProtoVariants().agentName, props.name, design.star?.name ?? "");
  const planets = agentPlanetsOf(design, origin).length;
  return (
    <div className="orch-main">
      <span className="orch-main-avatar">
        <StarFigure bySize={bySize} design={design} size={28} label={t.agents.avatar(props.name)} />
      </span>
      <span className="orch-main-body">
        <span className="orch-main-l1">
          <strong className="orch-main-name">{names.primary}</strong>
          {names.secondary !== null && <span className="orch-main-alias">{names.secondary}</span>}
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
          {/* 真信息，不是口号（R16：原来写「主智能体 · 接你的话、派活、收结果」） */}
          {t.agents.mainLine(planets, props.sessions)}
        </span>
      </span>
    </div>
  );
}

function TreeView(props: {
  currentId: string | null;
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
  // 正开着的会话在「更早」那一组里：那一组默认展开，让「你在这儿」看得见
  const [olderOpen, setOlderOpen] = useState(() => props.currentId !== null && tree.older.some((node) => holds(node, props.currentId)));
  const home = props.workspaceId === null;
  const body = (
    <>
      <section className="ssp-group" aria-label={to.sessionsGroup(tree.recent.length)}>
        <header className="ssp-group-head">{to.sessionsGroup(tree.recent.length)}</header>
        {tree.total === 0 ? (
          <PanelEmpty icon="message-square" hint={to.noSessionsHint}>
            {to.noSessions}
          </PanelEmpty>
        ) : tree.recent.length > 0 ? (
          <div className="ssp-card">
            {tree.recent.map((node) => (
              <TreeRow key={node.meta.id} node={node} now={props.now} onOpen={props.onOpen} currentId={props.currentId} />
            ))}
          </div>
        ) : null}
      </section>
      {tree.older.length > 0 &&
        (olderOpen ? (
          <section className="ssp-group" aria-label={to.olderGroup(tree.older.length)}>
            <header className="ssp-group-head">
              {to.olderGroup(tree.older.length)}
              <button type="button" className="ssp-group-fold row-trailing" aria-expanded={true} aria-label={to.olderFold} title={to.olderFold} onClick={() => setOlderOpen(false)}>
                <Icon name="chevron-up" size={14} strokeWidth={1.8} />
              </button>
            </header>
            <div className="ssp-card">
              {tree.older.map((node) => (
                <TreeRow key={node.meta.id} node={node} now={props.now} onOpen={props.onOpen} currentId={props.currentId} />
              ))}
            </div>
          </section>
        ) : (
          <button type="button" className="ssp-fold" aria-expanded={false} onClick={() => setOlderOpen(true)}>
            <Icon name="archive" size={14} strokeWidth={1.8} className="ssp-fold-glyph" />
            <span>{to.olderGroup(tree.older.length)}</span>
            <Icon name="chevron-right" size={14} strokeWidth={1.8} className="row-trailing" />
          </button>
        ))}
    </>
  );
  // 星际空间没有主智能体：没有根节点，会话直接是第一层
  if (home) {
    return (
      <div className="ssp-list orch-tree" data-view="tree" data-home="true">
        <p className="orch-note">{to.homeNote}</p>
        {body}
      </div>
    );
  }
  return (
    <div className="ssp-list orch-tree" data-view="tree">
      <MainCard workspaceId={props.workspaceId} name={props.name} status={props.status} sessions={tree.total} />
      <div className="orch-branch">{body}</div>
    </div>
  );
}

function stateWord(t: ReturnType<typeof useT>, state: SessionRunState): string | null {
  if (state === "waiting") return t.agents.status.waiting;
  if (state === "running") return t.agents.status.running;
  // 跑完 / 出错也写字，不只靠圆点的颜色（R6：状态优先用文字，颜色是第二信号）
  if (state === "done") return t.orchestra.rowDone;
  if (state === "failed") return t.orchestra.rowFailed;
  return null;
}

/** 这个节点或它下面某一层就是 id */
function holds(node: TreeNode, id: string | null): boolean {
  if (id === null) return false;
  return node.meta.id === id || node.children.some((child) => holds(child, id));
}

/** 树的一行：状态饼（没状态是一颗空心点）+ 名字 + 行尾时间；有子会话的行首多一个展开键，子会话缩进一层、左边一根发丝线 */
function TreeRow(props: { node: TreeNode; now: number; onOpen: (id: string) => void; depth?: number; currentId: string | null }) {
  const t = useT();
  const { node } = props;
  const current = props.currentId !== null && node.meta.id === props.currentId;
  // 正开着的会话在它下面：默认展开到它（R7）
  const [open, setOpen] = useState(node.activeBelow || node.children.some((child) => holds(child, props.currentId)));
  const title = node.meta.title.trim() === "" ? t.common.newTask : node.meta.title;
  const kids = node.children.length;
  const word = stateWord(t, node.state);
  return (
    <>
      <div className="ssp-row orch-row" data-state={node.state ?? undefined} data-depth={props.depth ?? 0} data-current={current || undefined}>
        <span className="orch-twisty-slot">
          {kids > 0 && (
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
        <button type="button" className="ssp-row-main" title={title} aria-current={current ? "page" : undefined} onClick={() => props.onOpen(node.meta.id)}>
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
            <TreeRow key={child.meta.id} node={child} now={props.now} onOpen={props.onOpen} depth={(props.depth ?? 0) + 1} currentId={props.currentId} />
          ))}
        </div>
      )}
    </>
  );
}

// ── 星系图 ──────────────────────────────────────────────────────────────

function GalaxyView(props: { session: ChatSession; workspaceId: string | null; name: string; width: number; onWiden: () => void }) {
  const t = useT();
  const to = t.orchestra;
  const { design, origin } = useGalaxyDesign(props.workspaceId ?? "");
  const agents = useMemo(() => agentPlanetsOf(design, origin), [design, origin]);
  const agentMap = useMemo(() => agentMapOf(agents), [agents]);
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
    designedPlanet: null,
    ...(props.workspaceId === null ? {} : { agents: agentInputsOf(agents) }),
  });
  return (
    <div className="orch-galaxy" data-view="galaxy">
      <HomeGalaxy
        spec={data.spec}
        label={to.galaxyFigure(props.name)}
        starDesign={design}
        agents={agentMap}
        fill
        emptyHint={t.agents.emptyHint}
        workspaceId={props.workspaceId}
        starName={props.name}
      />
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

/**
 * 多个父会话下的通道账本（协作图的 session ↔ 子会话边）：逐条读、先到先画；通道有新消息（事件）就补进去。
 * 键 = 子会话 id（一个子会话只有一个父）。
 */
function useChannelsOf(pairs: readonly ChannelKey[]): ReadonlyMap<string, readonly ChannelMessage[]> {
  const key = pairs.map((pair) => `${pair.parentId}>${pair.childId}`).join(",");
  const [channels, setChannels] = useState<ReadonlyMap<string, readonly ChannelMessage[]>>(new Map());
  useEffect(() => {
    if (key === "") {
      setChannels(new Map());
      return;
    }
    let cancelled = false;
    const wanted = key.split(",").map((part) => {
      const [parentId = "", childId = ""] = part.split(">");
      return { parentId, childId };
    });
    const parents = new Set(wanted.map((pair) => pair.parentId));
    for (const pair of wanted) {
      api.channel
        .load(pair)
        .then((list) => {
          if (!cancelled) setChannels((prev) => new Map(prev).set(pair.childId, sortChannelMessages(list)));
        })
        .catch((cause: unknown) => console.error("[orchestra] 通道读取失败", pair, cause));
    }
    const off = api.channel.onEvent((event) => {
      if (event.type !== "message" || !parents.has(event.parentId)) return;
      setChannels((prev) => {
        const current = prev.get(event.childId) ?? [];
        if (current.some((m) => m.id === event.message.id)) return prev;
        return new Map(prev).set(event.childId, sortChannelMessages([...current, event.message]));
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);
  return channels;
}

function GraphView(props: {
  session: ChatSession;
  /** 这个工作区的根会话（全部） */
  roots: readonly SessionMeta[];
  name: string;
  workspaceId: string | null;
  stateOf: (meta: SessionMeta) => SessionRunState;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const to = t.orchestra;
  const lang = useContext(LocaleContext);
  const [demo, setDemo] = useState(false);
  const now = Date.now();
  // 星际空间没有主智能体：没有根节点
  const root = props.workspaceId === null ? null : { id: `agent:${props.workspaceId}`, name: props.name, role: to.mainRoleLine };
  const base = collabGraph({
    root,
    sessions: props.roots,
    all: props.session.sessions,
    stateOf: props.stateOf,
    now,
    channels: new Map(),
    artifacts: {},
  });
  const pairs = base.nodes.filter((node) => node.kind === "child" && node.parent !== null).map((node) => ({ parentId: node.parent ?? "", childId: node.id }));
  const channels = useChannelsOf(pairs);
  const artifacts = useArtifactSummaries(props.session.sessions.filter((meta) => base.nodes.some((node) => node.id === meta.id)));
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useBoxWidth(ref);
  const graph: CollabGraph = demo
    ? demoCollab(root, lang === "zh")
    : collabGraph({ root, sessions: props.roots, all: props.session.sessions, stateOf: props.stateOf, now, channels, artifacts });
  const sessionCount = graph.nodes.filter((node) => node.kind === "session").length;
  return (
    <div className="orch-graph-wrap" data-view="graph" data-demo={graph.demo || undefined}>
      <div className="orch-graph-notes">
        {graph.demo ? <p className="orch-note orch-note-demo">{to.graph.demoNote}</p> : <p className="orch-note">{to.graph.peerPending}</p>}
        <button type="button" className="notice-exit orch-demo-toggle" onClick={() => setDemo(!demo)} aria-pressed={demo}>
          {demo ? to.graph.demoOff : to.graph.demo}
        </button>
      </div>
      {!graph.demo && sessionCount === 0 ? (
        <PanelEmpty icon="message-square" hint={to.noSessionsHint}>
          {to.noSessions}
        </PanelEmpty>
      ) : (
        <div ref={ref} className="orch-graph-host">
          {width !== null && width > 0 && (
            <CollabCanvas graph={graph} width={width} workspaceId={props.workspaceId} name={props.name} onOpen={graph.demo ? null : props.onOpen} />
          )}
        </div>
      )}
      {!graph.demo && graph.hidden > 0 && <p className="orch-note">{to.graph.hidden(graph.hidden)}</p>}
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

function edgeText(t: ReturnType<typeof useT>, edge: CollabEdge, toMain: boolean): { lead: string; body: string } {
  const g = t.orchestra.graph;
  const files = edge.files === null ? null : g.files(edge.files.files, edge.files.exts.join(" "));
  if (edge.kind === "task") return { lead: g.sent, body: edge.text ?? g.noBrief };
  if (edge.kind === "report") {
    if (edge.pending) return { lead: g.returned, body: g.notBack };
    // session → 主智能体：没有「结果」这回事，只说产出（文件账）；子会话 → session：结果第一行 + 产出
    if (toMain && files !== null) return { lead: g.output, body: files };
    const result = edge.text ?? g.noReport;
    return { lead: g.returned, body: files === null ? result : `${result} · ${files}` };
  }
  // 活与活之间（演示）：道窄，线上只写交接物，文件数在悬停里
  return { lead: "", body: edge.text ?? (files ?? "") };
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
  const mainNode = props.graph.nodes.find((node) => node.kind === "main");
  const mainBox = mainNode === undefined ? undefined : layout.cards.get(mainNode.id);
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
      {mainNode !== undefined && mainBox !== undefined && (
        <div className="orch-node orch-node-main" style={boxStyle(mainBox)}>
          <MainCardInGraph node={mainNode} workspaceId={props.workspaceId} name={props.name} />
        </div>
      )}
      {props.graph.nodes.filter((node) => node.kind !== "main").map((node) => {
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
        const text = edgeText(t, edge, edge.to === mainNode?.id);
        return (
          <span
            key={`label-${edge.id}`}
            className="orch-edge-label"
            data-kind={edge.kind}
            data-pending={edge.pending || undefined}
            data-hot={isHot(edge) || undefined}
            style={boxStyle(geo.label)}
            title={[text.lead, text.body, edge.kind === "peer" && edge.files !== null ? t.orchestra.graph.files(edge.files.files, edge.files.exts.join(" ")) : ""].filter((x) => x !== "").join(" · ")}
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
