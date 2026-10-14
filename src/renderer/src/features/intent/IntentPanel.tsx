/**
 * 右栏「意图」面板（实验功能 intent-system）—— 会话累积图（用户选定的 C 骨架）。
 *
 * **累积语义**（2026-10-14 00:11 用户裁决）：面板画的是整个会话的图——每一问的
 * /edges 合并，同一 (qaId, 岗位) 并成一个节点；新的一问只在旧图上长出新节点（布局
 * 用上一张图的坐标做种子、小幅松弛）。节点标**最近使用它的轮号**（门卫跳过的问
 * 不计数）；颜色（--color-nebula，用量格同款）默认 = 轮次新旧，可切相关度。
 *
 * 骨架（原型 intent-neuron.html 的骨架部分）：图钉在顶部，分隔条「条目 · N」拖动
 * 改高、双击复原、右端箭头把条目折到底部；条目行用收件箱行语言（顶发丝线、整行
 * hover、选中 option-active-bg；点开看 Q/A 与「对 / 不对 / 打开会话」）。轮选择器
 * 不再切图，而是**高亮某一轮**：该轮的节点与中心亮、其余暗；默认「全部」。
 *
 * 图体（原型 intent-clusters.html）：「按岗位」= 岗位成簇（簇内按来源会话分叉，
 * 同一 QA 跨岗拉桥）；「按提问」= 提问网络（每一问一个中心，最新一问最亮；被多个
 * 中心召回的条目长在中间）。确定性力导向（cluster-layout.ts）。
 *
 * 联动沿用已验收裁决：点图节点滚到条目行并选中、悬停行点亮节点、无悬浮提示。
 * 召回落定或表态后重拉；被回退的问不进轮次。每问的 /edges 在渲染层按 turn 缓存
 * （已完成的问不变，除非给了表态——表态只发生在最新一问，届时只失效那一条）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon.tsx";
import { Menu, type MenuItem } from "../../shell/Menu.tsx";
import { PanelTitle, RightPanelFrame } from "../../shell/RightPanel.tsx";
import { INTENT_SLOTS, type IntentEdges } from "@shared/intent-edges";
import type { IntentRecallRecord } from "@shared/session";
import type { IntentAskView, RecallCardState } from "@shared/intent-recall";
import type { IntentConfirmAnswer, IntentConfirmDecision } from "@shared/intent-confirm";
import {
  MAX_CENTRES,
  buildEgoScene,
  buildSlotScene,
  centresOfTurns,
  leafRange,
  mergeTurnLeaves,
  nebulaPercentOf,
  orbitaCentreCandidates,
  parseOrbitaQaId,
  type ClusterLeaf,
  type EgoCentre,
  type GraphColorMode,
  type TurnLeaves,
} from "./cluster-layout.ts";
import { GraphRenderer, nebulaFill, type SceneBuilder } from "./GraphRenderer.ts";
import { ZOOM_MAX, ZOOM_MIN } from "./graph-view.ts";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";

type IntentView = "slots" | "questions";

/** 一问（跑过召回的）在累积图里的位置。 */
interface RoundTurn {
  turnId: string;
  round: number;
  record: IntentRecallRecord;
}

/** 每问 /edges 的渲染层缓存（模块级：面板关了再开不重拉）。 */
const turnEdgesCache = new Map<string, IntentEdges>();
function cacheKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

export function IntentPanel(props: {
  sessionId: string | null;
  /** 本会话的终态召回卡（新 → 旧） */
  turns: readonly IntentRecallRecord[];
  /** 运行中的召回：轮选择器挂「召回中」徽标；运行中的问还不是一轮 */
  liveRun: RecallCardState | null;
  /** 挂起的回答前确认：行内「对 / 不对」接它（整卡一次提交） */
  pendingAsk: { requestId: string; ask: IntentAskView[] } | null;
  /** 折叠后仍在转录里的 user item id 集：被回退的问不进轮次 */
  liveTurnIds: ReadonlySet<string>;
  /** 本机存在的会话 id 集：渲染时就判断「打开会话」能不能点（不存在的禁用并就地说明） */
  openableSessionIds: ReadonlySet<string>;
  /** 「打开会话」：在辅助对话里打开那条来源会话（主槽不动）；turnId 是那一问（能定位更好） */
  onOpenSession: (sessionId: string, turnId: string | null) => void;
}) {
  const t = useT();
  const liveTurns = useMemo(
    () => props.turns.filter((turn) => props.liveTurnIds.has(turn.turnId)),
    [props.turns, props.liveTurnIds],
  );
  /** 轮次：跑过召回的问（门卫跳过不算），按时间升序编号 1..N */
  const rounds = useMemo<RoundTurn[]>(
    () =>
      liveTurns
        .filter((turn) => turn.status === "done" && turn.skipped !== "gate")
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((turn, index) => ({ turnId: turn.turnId, round: index + 1, record: turn })),
    [liveTurns],
  );
  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1]! : null;
  const isLive = props.liveRun !== null;

  const [pickedRound, setPickedRound] = useState<number | null>(null);
  const [view, setView] = useState<IntentView>("slots");
  const [colorMode, setColorMode] = useState<GraphColorMode>("time");
  const [graphH, setGraphH] = useState(DEFAULT_GRAPH_H);
  const [folded, setFolded] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  /** 悬停的条目行：只点亮图上的节点；展开内容只跟点击走（用户 2026-10-14：「我要自己掌控」） */
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectRow = useCallback((key: string, scroll: boolean) => {
    setSelKey(key);
    if (!scroll) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  /** 点条目行：再点一次收起（展开由用户掌控，悬停不展开） */
  const toggleRow = useCallback((key: string) => setSelKey((cur) => (cur === key ? null : key)), []);
  /** 点图上的叶子：选中并滚到那一行 */
  const selectLeaf = useCallback((key: string) => selectRow(key, true), [selectRow]);

  /* ---------------- 拉每一问的 /edges（缓存；新落定的问增量拉） ---------------- */
  const settleKey = rounds.map((round) => round.turnId).join("|");
  const [refreshTick, setRefreshTick] = useState(0);
  const [edgesByTurn, setEdgesByTurn] = useState<ReadonlyMap<string, IntentEdges>>(new Map());
  const [fetched, setFetched] = useState(false);
  useEffect(() => {
    setFetched(false);
    const sessionId = props.sessionId;
    if (sessionId === null) return;
    let cancelled = false;
    void Promise.all(
      rounds.map(async (round) => {
        const key = cacheKey(sessionId, round.turnId);
        const cached = turnEdgesCache.get(key);
        if (cached !== undefined) return { turnId: round.turnId, edges: cached };
        const fetched = await api.intent
          .edges(sessionId, round.turnId)
          .catch(() => null);
        if (fetched !== null) turnEdgesCache.set(key, fetched);
        return fetched === null ? null : { turnId: round.turnId, edges: fetched };
      }),
    ).then((arrived) => {
      if (cancelled) return;
      const next = new Map<string, IntentEdges>();
      for (const item of arrived) if (item !== null) next.set(item.turnId, item.edges);
      setEdgesByTurn(next);
      setFetched(true);
    });
    return () => {
      cancelled = true;
    };
    // settleKey：新问落定增量拉；refreshTick：表态后重拉
  }, [props.sessionId, settleKey, refreshTick]);

  /** 行内「对 / 不对」：接挂起的回答前确认——整卡一次提交，其余条默认不表态。 */
  const quickVerdict = useCallback(
    (qaId: string, verdict: "yes" | "no") => {
      const pending = props.pendingAsk;
      const sessionId = props.sessionId;
      if (pending === null || sessionId === null) return;
      const answers: IntentConfirmAnswer[] = pending.ask.map((item) => ({
        askId: item.askId,
        verdict: item.qaId === qaId ? verdict : "skip",
      }));
      const decision: IntentConfirmDecision = { action: "confirm", answers, note: "" };
      void api.agent
        .answerIntentConfirm(pending.requestId, decision)
        .catch(() => undefined)
        .finally(() => {
          // 表态改的是最新一问的边：只失效那一条缓存，稍后重拉
          const current = rounds[rounds.length - 1];
          if (current !== undefined) {
            turnEdgesCache.delete(cacheKey(sessionId, current.turnId));
          }
          window.setTimeout(() => setRefreshTick((tick) => tick + 1), 700);
        });
    },
    [props.pendingAsk, props.sessionId, rounds],
  );

  /* ---------------- 累积数据 ---------------- */
  const turnLeaves = useMemo<TurnLeaves[]>(() => {
    const out: TurnLeaves[] = [];
    for (const round of rounds) {
      const edges = edgesByTurn.get(round.turnId);
      if (edges === undefined) continue;
      out.push({ turnId: round.turnId, round: round.round, leaves: slotLeavesOf(edges, round.round) });
    }
    return out;
  }, [rounds, edgesByTurn]);

  const slotLeaves = useMemo(
    () => mergeTurnLeaves(turnLeaves, (leaf) => `${leaf.qaId}#${leaf.slot}`),
    [turnLeaves],
  );

  /* ---------------- 中心（按提问）：本会话的每一问 + orbita 自召回的旧提问 ---------------- */
  const [extraCentres, setExtraCentres] = useState<EgoCentre[]>([]);
  const centreLeaves = useMemo<TurnLeaves[]>(
    () =>
      turnLeaves.map((turn) => ({
        ...turn,
        leaves: turn.leaves.length === 0 ? [] : egoLeavesOf(turn.leaves),
      })),
    [turnLeaves],
  );
  // 不看 view：离开「按提问」不清空、回来不重拉——以前每次切视图都 [] ↔ [c] 翻一次，
  // 数据签跟着变两次，回到「按提问」时旧中心的节点被当作新节点重新加热（真机 113px 位移）
  useEffect(() => {
    if (props.sessionId === null || turnLeaves.length === 0) {
      // 已是空就不 set：无谓的重渲染曾让渲染器被换掉（2026-10-14 诊断 §0）
      setExtraCentres((prev) => (prev.length === 0 ? prev : []));
      return () => undefined;
    }
    let cancelled = false;
    // 中心预算：会话的问优先，剩下的给 orbita 候选，总数不超过 MAX_CENTRES
    const budget = Math.max(0, MAX_CENTRES - centreLeaves.length);
    const candidates = orbitaCentreCandidates(centreLeaves[centreLeaves.length - 1]!.leaves, budget);
    if (candidates.length === 0) {
      setExtraCentres((prev) => (prev.length === 0 ? prev : []));
      return () => undefined;
    }
    void Promise.all(
      candidates.map(async (candidate) => {
        const key = cacheKey(candidate.sessionId, candidate.turnId);
        const cached = turnEdgesCache.get(key);
        if (cached !== undefined) return { candidate, edges: cached };
        const fetched = await api.intent.edges(candidate.sessionId, candidate.turnId).catch(() => null);
        if (fetched !== null) turnEdgesCache.set(key, fetched);
        return fetched === null ? null : { candidate, edges: fetched };
      }),
    ).then((arrived) => {
      if (cancelled) return;
      const next = arrived
        .filter((item): item is { candidate: { sessionId: string; turnId: string }; edges: IntentEdges } => item !== null)
        .map(({ candidate, edges }) => ({
          key: `${candidate.sessionId}:${candidate.turnId}`,
          label: "",
          past: true,
          leaves: egoLeavesOf(slotLeavesOf(edges, 0)),
        }));
      // 同一批 key 不换引用（数据签不变，图不重建）
      setExtraCentres((prev) =>
        prev.length === next.length && prev.every((centre, i) => centre.key === next[i]!.key) ? prev : next,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId, centreLeaves, turnLeaves]);

  /* ---------------- 条目（随视图分组；最近用的轮在前） ---------------- */
  const rows = useMemo(() => {
    const leaves =
      view === "slots" ? slotLeaves : mergeTurnLeaves(centreLeaves, (leaf) => leaf.qaId);
    return leaves
      .map((leaf) => ({
        key: view === "slots" ? `${leaf.qaId}#${leaf.slot}` : leaf.qaId,
        leaf,
        solid: leaf.solid,
      }))
      .sort((a, b) => b.leaf.lastRound - a.leaf.lastRound || b.leaf.score - a.leaf.score);
  }, [view, slotLeaves, centreLeaves]);

  if (rounds.length === 0 && props.liveRun === null) {
    return (
      <RightPanelFrame header={<PanelTitle icon="waypoints" title={t.intentPanel.title} />} contentKey="empty">
        <p style={emptyStyle}>{t.intentPanel.emptyNoTurns}</p>
      </RightPanelFrame>
    );
  }

  const roundItems: MenuItem[] = [
    {
      id: "all",
      label: t.intentPanel.allRounds(rounds.length),
      checked: pickedRound === null,
      onSelect: () => setPickedRound(null),
    },
    ...[...rounds]
      .reverse()
      .map((round) => ({
        id: String(round.round),
        label: t.intentPanel.roundChip(round.round, shortWhen(round.record.startedAt)),
        checked: pickedRound === round.round,
        onSelect: () => setPickedRound(round.round),
      })),
  ];
  const activeRound =
    pickedRound !== null && pickedRound <= rounds.length ? pickedRound : null;

  const high = rows.filter((row) => row.solid).length;

  return (
    <RightPanelFrame
      header={
        <>
          <PanelTitle icon="waypoints" title={t.intentPanel.title} />
          <Menu
            items={roundItems}
            placement="below"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                className={`intent-turn-chip no-drag${open ? " open" : ""}`}
                onClick={toggle}
              >
                {isLive ? <span className="intent-live-dot" /> : null}
                {activeRound === null
                  ? t.intentPanel.allRounds(rounds.length)
                  : t.intentPanel.roundChip(activeRound, shortWhen(rounds[activeRound - 1]?.record.startedAt ?? 0))}
                <Icon name="chevron-down" size={12} />
              </button>
            )}
          />
        </>
      }
      // 固定：换 key 会重挂整个图区，各视图的坐标缓存随之丢失（视图 / 轮数都不进 key）
      contentKey="graph"
    >
      <div className="intent-panel-body">
        <IntentGraph
          key={props.sessionId ?? "none"}
          height={graphH}
          folded={folded}
          view={view}
          onView={setView}
          colorMode={colorMode}
          onColorMode={setColorMode}
          slotLeaves={slotLeaves}
          centreLeaves={centreLeaves}
          extraCentres={extraCentres}
          latestRound={latestRound?.round ?? 0}
          activeRound={activeRound}
          activeTurnId={activeRound === null ? null : (rounds[activeRound - 1]?.turnId ?? null)}
          readTotal={latestRound?.record.qaTotal ?? null}
          rowsTotal={rows.length}
          highCount={high}
          loading={!fetched && rounds.length > 0}
          hasData={turnLeaves.some((turn) => turn.leaves.length > 0)}
          selKey={selKey}
          hoverKey={hoverKey}
          onSelectLeaf={selectLeaf}
        />
        <IntentSplitBar
          count={rows.length}
          high={high}
          view={view}
          folded={folded}
          onDrag={(h) => {
            setGraphH(h);
            setFolded(false);
          }}
          onToggleFold={() => setFolded((f) => !f)}
        />
        <IntentRows
          rows={rows}
          view={view}
          hidden={folded}
          selKey={selKey}
          colorMode={colorMode}
          pendingAsk={props.pendingAsk}
          onHover={setHoverKey}
          onSelect={toggleRow}
          onQuickVerdict={quickVerdict}
          openableSessionIds={props.openableSessionIds}
          onOpenSession={props.onOpenSession}
          listRef={listRef}
        />
      </div>
    </RightPanelFrame>
  );
}

/* ---------------------------------------------------------------- 图 */

/**
 * 图：React 只负责容器、浮层（开关 / 摘要 / 图例）与「数据 → 场景」的装配闭包；
 * DOM、落定动画、拖拽、上色、高亮、各视图坐标缓存全在 GraphRenderer（每帧不进 React）。
 *
 * 生命周期纪律（2026-10-14 诊断 §0 的根因就在这里）：
 * - 渲染器**只创建一次**，绑 svg 元素；svg **常驻**（没数据时只叠空态文案），
 *   否则 ref 时序又会绕回「每次渲染换一个实例、旧 DOM 留在 svg 里」。
 * - 回调经 ref 取最新值，不进任何 effect 的依赖。
 * - 三条 effect：数据签变了 → setData；样式变了 → setStyle；尺寸变了 → resize。
 */
function IntentGraph(props: {
  height: number;
  folded: boolean;
  view: IntentView;
  onView: (view: IntentView) => void;
  colorMode: GraphColorMode;
  onColorMode: (mode: GraphColorMode) => void;
  slotLeaves: readonly ClusterLeaf[];
  centreLeaves: readonly TurnLeaves[];
  extraCentres: readonly EgoCentre[];
  latestRound: number;
  activeRound: number | null;
  /** 高亮轮对应的 turnId（中心点亮用）；null = 全部 */
  activeTurnId: string | null;
  readTotal: number | null;
  rowsTotal: number;
  highCount: number;
  loading: boolean;
  hasData: boolean;
  selKey: string | null;
  hoverKey: string | null;
  onSelectLeaf: (rowKey: string) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const onSelectLeafRef = useRef(props.onSelectLeaf);
  onSelectLeafRef.current = props.onSelectLeaf;
  /** 当前倍率（按钮禁用态用；渲染器变换时回调） */
  const [zoom, setZoom] = useState(1);
  /** 数据签：只有它变了才重建场景（颜色 / 高亮 / 尺寸都不进这个 key） */
  const dataKey = [
    props.view,
    props.hasData ? "data" : "none",
    ...props.slotLeaves.map((leaf) => `${leaf.qaId}#${leaf.slot}:${leaf.lastRound}`),
    ...(props.view === "questions"
      ? [
          ...props.centreLeaves.map((turn) => `${turn.turnId}=${turn.leaves.length}`),
          ...props.extraCentres.map((centre) => centre.key),
        ]
      : []),
    props.latestRound,
  ].join("|");
  /** 数据 → 场景的装配闭包；渲染器给布局空间尺寸与种子 */
  const buildRef = useRef<SceneBuilder | null>(null);
  buildRef.current = !props.hasData
    ? null
    : props.view === "questions"
      ? (W, H, seed) => {
          const centres = centresOfTurns(
            props.centreLeaves,
            props.latestRound,
            (round) => t.intentPanel.roundChip(round, ""),
            (from, to) => t.intentPanel.earlierRounds(from, to),
          );
          if (centres.length === 0) return null;
          return buildEgoScene([...centres, ...props.extraCentres], W, H, { seed });
        }
      : (W, H, seed) => buildSlotScene(props.slotLeaves, W, H, { seed });

  // 渲染器生命周期：绑 svg，只建一次；StrictMode 双跑下 dispose 清空 svg、再建一个干净的
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const renderer = new GraphRenderer(svg, (key) => onSelectLeafRef.current(key));
    rendererRef.current = renderer;
    renderer.subscribeView((view) => setZoom(view.z));
    const host = hostRef.current;
    if (host !== null) renderer.resize(host.clientWidth, host.clientHeight);
    return () => {
      renderer.subscribeView(null);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // 数据 → 场景（整体替换；加热程度由渲染器按种子覆盖率定）
  useEffect(() => {
    rendererRef.current?.setData(props.view, buildRef.current);
    // dataKey 是数据签；buildRef 每次渲染都是最新闭包，但只有数据签变了才需要重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  // 样式：只上色 / 换 class（坐标绝不动）
  useEffect(() => {
    rendererRef.current?.setStyle({
      colorMode: props.colorMode,
      selKey: props.selKey,
      hoverKey: props.hoverKey,
      activeRound: props.activeRound,
      activeTurnId: props.activeTurnId,
    });
  }, [props.colorMode, props.selKey, props.hoverKey, props.activeRound, props.activeTurnId, dataKey]);

  // 尺寸：等比缩放并居中（不重排）
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measure = (): void => {
      rendererRef.current?.resize(host.clientWidth, host.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const summary = t.intentPanel.summary(
    props.readTotal ?? t.intentPanel.readUnknown,
    props.highCount,
    props.rowsTotal - props.highCount,
  );

  return (
    <div
      className="intent-graph-area"
      ref={hostRef}
      style={
        props.folded
          ? { flex: "1 1 auto", height: "auto", minHeight: 0 }
          : { flex: "0 0 auto", height: `${props.height}px` }
      }
    >
      <svg ref={svgRef} className="intent-cluster" width="100%" height="100%" />
      <div className="intent-graph-top">
        <button
          type="button"
          className={`intent-gtoggle${props.view === "slots" ? " on" : ""}`}
          onClick={() => props.onView("slots")}
        >
          {t.intentPanel.viewSlots}
        </button>
        <button
          type="button"
          className={`intent-gtoggle${props.view === "questions" ? " on" : ""}`}
          onClick={() => props.onView("questions")}
        >
          {t.intentPanel.viewQuestions}
        </button>
      </div>
      {props.hasData && (
        // 缩放组（右上）：放大 / 缩小 / 适配。滚轮、捏合、拖空白、双击空白在 svg 上
        <div className="intent-zoom">
          <button
            type="button"
            className="intent-zoom-btn"
            title={t.intentPanel.zoomIn}
            aria-label={t.intentPanel.zoomIn}
            disabled={zoom >= ZOOM_MAX - 1e-6}
            onClick={() => rendererRef.current?.zoomBy(1.25)}
          >
            <Icon name="zoom-in" size={13} />
          </button>
          <button
            type="button"
            className="intent-zoom-btn"
            title={t.intentPanel.zoomOut}
            aria-label={t.intentPanel.zoomOut}
            disabled={zoom <= ZOOM_MIN + 1e-6}
            onClick={() => rendererRef.current?.zoomBy(0.8)}
          >
            <Icon name="zoom-out" size={13} />
          </button>
          <button
            type="button"
            className="intent-zoom-btn"
            title={t.intentPanel.zoomFit}
            aria-label={t.intentPanel.zoomFit}
            onClick={() => rendererRef.current?.fit()}
          >
            <Icon name="maximize" size={13} />
          </button>
        </div>
      )}
      {props.loading && <p className="intent-summary">{t.intentPanel.loading}</p>}
      {!props.loading && !props.hasData && <p className="intent-summary">{t.intentPanel.emptyNoRecall}</p>}
      {props.hasData && (
        <>
          <p className="intent-summary">{summary}</p>
          {/* 图例（用户 2026-10-14：「只看颜色分不出早晚，需要图例」）：色带两端随着色模式换字；
              再给实心 / 空心 / 主干三个记号 */}
          <div className="intent-key" aria-hidden="true">
            <span className="intent-key-ramp">
              <span>{props.colorMode === "time" ? t.intentPanel.legendEarly : t.intentPanel.legendLow}</span>
              <i className="intent-key-bar" />
              <span>{props.colorMode === "time" ? t.intentPanel.legendLate : t.intentPanel.legendHigh}</span>
            </span>
            <span className="intent-key-items">
              <span><i className="intent-key-dot solid" />{t.intentPanel.legendSolid}</span>
              <span><i className="intent-key-dot" />{t.intentPanel.legendMid}</span>
              <span><i className="intent-key-line" />{t.intentPanel.legendSpine}</span>
            </span>
          </div>
          <div className="intent-legend">
            <button
              type="button"
              className={`intent-gtoggle sm${props.colorMode === "time" ? " on" : ""}`}
              onClick={() => props.onColorMode("time")}
            >
              {t.intentPanel.colorTime}
            </button>
            <button
              type="button"
              className={`intent-gtoggle sm${props.colorMode === "score" ? " on" : ""}`}
              onClick={() => props.onColorMode("score")}
            >
              {t.intentPanel.colorScore}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 分隔条（拖高 / 折叠） */

function IntentSplitBar(props: {
  count: number;
  high: number;
  view: IntentView;
  folded: boolean;
  onDrag: (h: number) => void;
  onToggleFold: () => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("button") !== null) return;
    const body = hostRef.current?.parentElement;
    if (body === null || body === undefined) return;
    const y0 = event.clientY;
    const h0 = body.querySelector<HTMLElement>(".intent-graph-area")?.clientHeight ?? 0;
    const max = body.clientHeight - 48 - 32;
    const move = (ev: PointerEvent): void => {
      props.onDrag(Math.max(0, Math.min(max, h0 + ev.clientY - y0)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      const h = Math.max(0, Math.min(max, h0 + ev.clientY - y0));
      props.onDrag(h < 60 ? 0 : h);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  return (
    <div
      ref={hostRef}
      className={`intent-split${props.folded ? " folded" : ""}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => props.onDrag(DEFAULT_GRAPH_H)}
      title={t.intentPanel.splitHint}
    >
      <span className="lbl">{t.intentPanel.entriesLabel}</span>
      <span className="det">
        {props.count} · {t.intentPanel.selectedCount(props.high)} ·{" "}
        {props.view === "slots" ? t.intentPanel.viewSlots : t.intentPanel.viewQuestions}
      </span>
      <span className="grip">
        <Icon name="grip-vertical" size={13} />
      </span>
      <button
        type="button"
        className="intent-split-fold"
        onClick={props.onToggleFold}
        title={props.folded ? t.intentPanel.unfoldList : t.intentPanel.foldList}
      >
        <Icon name={props.folded ? "chevron-up" : "chevron-down"} size={13} />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- 条目行 */

interface IntentRow {
  key: string;
  leaf: ClusterLeaf;
  solid: boolean;
}

function IntentRows(props: {
  rows: readonly IntentRow[];
  view: IntentView;
  /** 折叠态：条目收到底部（图占满面板） */
  hidden: boolean;
  selKey: string | null;
  colorMode: GraphColorMode;
  pendingAsk: { requestId: string; ask: IntentAskView[] } | null;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  onQuickVerdict: (qaId: string, verdict: "yes" | "no") => void;
  openableSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string, turnId: string | null) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // 行首圆点与图上的节点同一套着色：同一份归一范围（全部条目）、同一着色模式
  const range = useMemo(() => leafRange(props.rows.map((row) => row.leaf)), [props.rows]);
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: IntentRow[] }>();
    for (const row of props.rows) {
      const key = props.view === "slots" ? String(row.leaf.slot) : row.leaf.sessionId;
      const label = props.view === "slots" ? (INTENT_SLOTS[row.leaf.slot - 1]?.name ?? "") : row.leaf.title;
      const group = map.get(key) ?? { label, rows: [] };
      group.rows.push(row);
      map.set(key, group);
    }
    return [...map.values()];
  }, [props.rows, props.view]);

  return (
    <div
      className="intent-rows scroll"
      ref={props.listRef}
      style={props.hidden ? { display: "none" } : undefined}
    >
      {groups.map((group) => {
        const open = !collapsed.has(group.label);
        return (
          <div key={group.label}>
            <div className="panel-group-head">
              <button
                type="button"
                className="panel-group-toggle"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.label)) next.delete(group.label);
                    else next.add(group.label);
                    return next;
                  })
                }
              >
                <Icon name="chevron-right" size={12} className="panel-group-chev" />
                <span className="panel-group-label">{group.label}</span>
                <span className="panel-group-detail">
                  {group.rows.length}
                  {group.rows.some((row) => row.solid)
                    ? ` · ${t.intentPanel.selectedCount(group.rows.filter((r) => r.solid).length)}`
                    : ""}
                </span>
              </button>
            </div>
            {open &&
              group.rows.map((row) => (
                <IntentRowView
                  key={row.key}
                  row={row}
                  sel={props.selKey === row.key}
                  dotPercent={nebulaPercentOf(props.colorMode, row.leaf, range)}
                  pendingAsk={props.pendingAsk}
                  onHover={props.onHover}
                  onSelect={props.onSelect}
                  onQuickVerdict={props.onQuickVerdict}
                  openable={props.openableSessionIds.has(row.leaf.sessionId)}
                  onOpenSession={props.onOpenSession}
                />
              ))}
          </div>
        );
      })}
      <div style={{ height: 14 }} />
    </div>
  );
}

function IntentRowView(props: {
  row: IntentRow;
  sel: boolean;
  /** 圆点的 nebula 浓度（与图上节点同一个值） */
  dotPercent: number;
  pendingAsk: { requestId: string; ask: IntentAskView[] } | null;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  onQuickVerdict: (qaId: string, verdict: "yes" | "no") => void;
  /** 来源会话在本机存在（渲染时就判定，不让用户点了才知道） */
  openable: boolean;
  onOpenSession: (sessionId: string, turnId: string | null) => void;
}) {
  const t = useT();
  const { leaf } = props.row;
  const kind = leaf.verdict === "yes" ? "yes" : props.row.solid ? "high" : "mid";
  const askItem =
    props.pendingAsk === null ? undefined : props.pendingAsk.ask.find((item) => item.qaId === leaf.qaId);
  return (
    <div
      data-row-key={props.row.key}
      className={`intent-row${props.sel ? " sel" : ""}`}
      onMouseEnter={() => props.onHover(props.row.key)}
      onMouseLeave={() => props.onHover(null)}
      onClick={(event) => {
        // 展开后的正文与按钮区不触发收起：在里面选字、点按钮都不该把行折回去
        if (event.target instanceof Element && event.target.closest(".intent-row-more, .intent-row-acts") !== null) return;
        props.onSelect(props.row.key);
      }}
      aria-expanded={props.sel}
    >
      {/* 行首圆点 = 图上那个节点的样子：实心（入选）/ 空心（拿不准）/ 绿圈（你点过对），
          颜色同一套 nebula 浓度（时间 / 相关度）。用户 2026-10-14：两边的圆要统一 */}
      <svg className={`intent-row-dot ${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r="4.5"
          fill={props.row.solid ? nebulaFill(props.dotPercent) : "var(--color-bg-panel)"}
          stroke={kind === "yes" ? "var(--color-success)" : nebulaFill(props.dotPercent)}
          strokeWidth={kind === "yes" ? 1.8 : 1.2}
        />
      </svg>
      <div className="intent-row-body">
        <div className="intent-row-l1">
          <span className="intent-row-title">{leaf.title}</span>
          <span className="intent-row-when">{t.intentPanel.roundShort(leaf.lastRound)} · {shortWhen(leaf.ts)}</span>
        </div>
        <div className="intent-row-meta">
          {INTENT_SLOTS[leaf.slot - 1]?.name} · {leaf.score.toFixed(2)} · {leaf.source}
          {leaf.verdict === "yes" ? ` · ${t.intentPanel.cardVerdictAsked}` : ""}
          {leaf.verdict === "no" ? ` · ${t.intentPanel.cardVerdictDenied}` : ""}
        </div>
        <p className="intent-row-conn">{leaf.edited ?? leaf.connection}</p>
        {props.sel && (
          <>
            <div className="intent-row-more">
              <div className="intent-row-md">
                <p className="intent-row-md-label">{t.intentPanel.youSaid}</p>
                <MarkdownBlock text={leaf.q} />
              </div>
              {leaf.a !== "" && (
                <div className="intent-row-md">
                  <p className="intent-row-md-label">{t.intentPanel.answerThen}</p>
                  <MarkdownBlock text={leaf.a} />
                </div>
              )}
            </div>
            <div className="intent-row-acts">
              {askItem !== undefined && (
                <>
                  <button type="button" className="intent-mini" onClick={() => props.onQuickVerdict(leaf.qaId, "yes")}>
                    <Icon name="check" size={12} /> {t.intentPanel.rowYes}
                  </button>
                  <button type="button" className="intent-mini" onClick={() => props.onQuickVerdict(leaf.qaId, "no")}>
                    <Icon name="x" size={12} /> {t.intentPanel.rowNo}
                  </button>
                </>
              )}
              <span style={{ flex: 1 }} />
              {leaf.source === "orbita" && (
                <>
                  {!props.openable && (
                    <span className="intent-row-note">{t.intentPanel.sessionNotLocal}</span>
                  )}
                  <button
                    type="button"
                    className="intent-mini"
                    disabled={!props.openable}
                    onClick={() => props.onOpenSession(leaf.sessionId, parseOrbitaQaId(leaf.qaId)?.turnId ?? null)}
                  >
                    <Icon name="external-link" size={12} /> {t.intentPanel.openSession}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 数据推导 */

/** /edges → 按岗位视图的叶子：每条 (QA, 岗) 一片（verdict=no 不画），标上轮号。 */
function slotLeavesOf(edges: IntentEdges, round: number): ClusterLeaf[] {
  const out: ClusterLeaf[] = [];
  for (const edge of edges.edges) {
    if (edge.verdict === "no") continue;
    out.push({
      qaId: edge.qaId,
      slot: edge.slot,
      score: edge.score,
      solid: edge.band === "high" || edge.promoted || edge.verdict === "yes",
      verdict: edge.verdict,
      edited: edge.edited,
      connection: edge.connection,
      asked: edge.asked,
      ts: edge.qa.ts,
      sessionId: edge.qa.sessionId,
      title: edge.qa.title,
      source: edge.qa.source,
      q: edge.qa.q,
      a: edge.qa.a,
      lastRound: round,
      rounds: [round],
    });
  }
  return out.sort((a, b) => a.ts - b.ts || (a.qaId < b.qaId ? -1 : 1));
}

/** 一问的 (QA, 岗) 叶子 → 按提问视图的叶子：每 QA 一片（主岗 = 最高分岗）。 */
function egoLeavesOf(leaves: readonly ClusterLeaf[]): ClusterLeaf[] {
  const byQa = new Map<string, ClusterLeaf>();
  for (const leaf of leaves) {
    const found = byQa.get(leaf.qaId);
    if (found === undefined || leaf.score > found.score) byQa.set(leaf.qaId, leaf);
  }
  return [...byQa.values()].sort((a, b) => a.ts - b.ts || (a.qaId < b.qaId ? -1 : 1));
}

function shortWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const DEFAULT_GRAPH_H = 340;

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "var(--space-4)",
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-tertiary)",
};
