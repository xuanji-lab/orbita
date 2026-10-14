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
  buildEgoScene,
  buildSlotScene,
  mergeTurnLeaves,
  orbitaCentreCandidates,
  sceneSeed,
  type ClusterLeaf,
  type ClusterScene,
  type EgoCentre,
  type GraphColorMode,
  type LayoutSeed,
  type TurnLeaves,
} from "./cluster-layout.ts";
import { GraphRenderer } from "./GraphRenderer.ts";
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
  /** 「打开会话」：在辅助对话里打开那条来源会话；返回 false = 会话已不存在 */
  onOpenSession: (sessionId: string) => boolean;
}) {
  const t = useT();
  const [missingSession, setMissingSession] = useState<string | null>(null);
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectRow = useCallback((key: string, scroll: boolean) => {
    setSelKey(key);
    if (!scroll) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

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
  useEffect(() => {
    if (view !== "questions" || props.sessionId === null || turnLeaves.length === 0) {
      setExtraCentres([]);
      return () => undefined;
    }
    let cancelled = false;
    // 中心预算：会话的问优先，剩下的给 orbita 候选，至多 6 个中心
    const budget = Math.max(0, 6 - centreLeaves.length);
    const candidates = orbitaCentreCandidates(centreLeaves[centreLeaves.length - 1]!.leaves, budget);
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
      setExtraCentres(
        arrived
          .filter((item): item is { candidate: { sessionId: string; turnId: string }; edges: IntentEdges } => item !== null)
          .map(({ candidate, edges }) => ({
            key: `${candidate.sessionId}:${candidate.turnId}`,
            label: "",
            past: true,
            leaves: egoLeavesOf(slotLeavesOf(edges, 0)),
          })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [view, props.sessionId, centreLeaves, turnLeaves]);

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
      contentKey={`${rounds.length}:${view}`}
    >
      <div className="intent-panel-body">
        <IntentGraph
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
          onSelectLeaf={(key) => selectRow(key, true)}
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
          pendingAsk={props.pendingAsk}
          onHover={setSelKey}
          onSelect={selectRow}
          onQuickVerdict={quickVerdict}
          onOpenSession={props.onOpenSession}
          missingSession={missingSession}
          onOpenMissing={() => setMissingSession("missing")}
          onMissingCleared={() => setMissingSession(null)}
          listRef={listRef}
        />
      </div>
    </RightPanelFrame>
  );
}

/* ---------------------------------------------------------------- 图 */

/**
 * 图：React 只负责容器、浮层（开关 / 摘要 / 图例）与数据→场景的装配；
 * 落定动画、拖拽、上色、高亮全部由 GraphRenderer 指令式驱动（每帧不进 React）。
 * 触发纪律（2026-10-14 用户裁决）：
 * - 数据（问 / 边）变了 → 重建结构，逐帧动画跑到**收敛**，然后静止；
 * - 颜色模式 / 选中 / 高亮轮变了 → 只上色 / 换 class，坐标绝不动；
 * - 尺寸变了 → 已收敛的坐标等比缩放（拖分隔条不重排）；宽度剧变才整体重建。
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
  onSelectLeaf: (rowKey: string) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  /** 数据签：只有它变了才重建场景（颜色 / 高亮 / 尺寸都不进这个 key） */
  const dataKey = [
    props.view,
    ...props.slotLeaves.map((leaf) => `${leaf.qaId}#${leaf.slot}:${leaf.lastRound}`),
    ...props.centreLeaves.map((turn) => `${turn.turnId}=${turn.leaves.length}`),
    ...props.extraCentres.map((centre) => centre.key),
    props.latestRound,
  ].join("|");
  const sceneRef = useRef<ClusterScene | null>(null);
  const seedRef = useRef(new Map<string, LayoutSeed>());
  const sizeRef = useRef<{ w: number; h: number } | null>(null);
  const [resizeNonce, setResizeNonce] = useState(0);

  /** 数据 → 场景（本组件里唯一的构建路径；两个 effect 共用） */
  const rebuild = (animate: boolean): void => {
    const host = hostRef.current;
    const renderer = rendererRef.current;
    if (host === null || renderer === null || !props.hasData) return;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    const seed = seedRef.current.get(props.view);
    const scene =
      props.view === "questions"
        ? (() => {
            const centres: EgoCentre[] = props.centreLeaves.map((turn) => ({
              key: turn.turnId,
              label: t.intentPanel.roundChip(turn.round, ""),
              past: turn.round !== props.latestRound,
              leaves: turn.leaves,
            }));
            if (centres.length === 0) return null;
            return buildEgoScene([...centres, ...props.extraCentres], w, h, { seed });
          })()
        : buildSlotScene(props.slotLeaves, w, h, { seed });
    if (scene === null) return;
    seedRef.current.set(props.view, sceneSeed(scene));
    sceneRef.current = scene;
    sizeRef.current = { w, h };
    renderer.setScene(scene, w, h, { animate });
    renderer.paint(props.colorMode);
    renderer.setHighlight(props.selKey, props.activeRound, props.activeTurnId);
  };

  // 渲染器生命周期
  useEffect(() => {
    if (svgRef.current === null) return;
    const renderer = new GraphRenderer(svgRef.current, props.onSelectLeaf);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
    // onSelectLeaf 引用稳定（面板的 useCallback）
  }, [props.onSelectLeaf]);

  // 数据 → 场景：重建结构 + 逐帧落定（初次加载与每一轮新增都算「东西去哪了」）
  useEffect(() => {
    rebuild(true);
    // dataKey 是数据签；colorMode / selKey / activeRound / 尺寸走各自的 effect
    // eslint 无关：rebuild 每次渲染都是新的，但只有 dataKey 变才需要重建
  }, [dataKey]);

  // 尺寸：等比缩放（不重排）；宽度剧变（>120px）才整体重建
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measure = (): void => {
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const last = sizeRef.current;
      if (renderer === null || scene === null) return;
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      if (last !== null && last.w === w && last.h === h) return;
      if (last !== null && Math.abs(w - last.w) > 120) {
        // 宽度剧变：整体重建（跑到收敛；不动画，避免大挪移的眩晕）
        setResizeNonce((n) => n + 1);
        return;
      }
      renderer.rescale(last?.w ?? w, last?.h ?? h, w, h);
      sizeRef.current = { w, h };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (resizeNonce === 0) return;
    rebuild(false);
    // eslint 无关：resizeNonce 是唯一依赖
  }, [resizeNonce]);

  // 颜色模式：只上色
  useEffect(() => {
    rendererRef.current?.paint(props.colorMode);
  }, [props.colorMode, dataKey, resizeNonce]);

  // 选中 / 高亮轮：只换 class
  useEffect(() => {
    rendererRef.current?.setHighlight(props.selKey, props.activeRound, props.activeTurnId);
  }, [props.selKey, props.activeRound, props.activeTurnId, dataKey, resizeNonce]);

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
      {props.loading && <p className="intent-summary">{t.intentPanel.loading}</p>}
      {!props.loading && !props.hasData && <p className="intent-summary">{t.intentPanel.emptyNoRecall}</p>}
      {props.hasData && (
        <>
          <p className="intent-summary">{summary}</p>
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
          <svg ref={svgRef} className="intent-cluster" width="100%" height="100%" />
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
  pendingAsk: { requestId: string; ask: IntentAskView[] } | null;
  onHover: (key: string) => void;
  onSelect: (key: string, scroll: boolean) => void;
  onQuickVerdict: (qaId: string, verdict: "yes" | "no") => void;
  onOpenSession: (sessionId: string) => boolean;
  /** 「会话已不存在」的一行说明（打开失败时挂在列表顶部，点行清除） */
  missingSession: string | null;
  onOpenMissing: () => void;
  onMissingCleared: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
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
      {props.missingSession !== null && (
        <p className="intent-missing" onClick={props.onMissingCleared}>
          {t.intentPanel.missingSession}
        </p>
      )}
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
                  pendingAsk={props.pendingAsk}
                  onHover={props.onHover}
                  onSelect={props.onSelect}
                  onQuickVerdict={props.onQuickVerdict}
                  onOpenSession={props.onOpenSession}
                  onOpenMissing={props.onOpenMissing}
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
  pendingAsk: { requestId: string; ask: IntentAskView[] } | null;
  onHover: (key: string) => void;
  onSelect: (key: string, scroll: boolean) => void;
  onQuickVerdict: (qaId: string, verdict: "yes" | "no") => void;
  onOpenSession: (sessionId: string) => boolean;
  onOpenMissing: () => void;
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
      onClick={() => props.onSelect(props.row.key, false)}
    >
      <span className={`intent-row-mk ${kind}`}>
        <Icon name={kind === "yes" ? "circle-check" : kind === "high" ? "circle-dot" : "circle-dashed"} size={14} />
      </span>
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
                <button
                  type="button"
                  className="intent-mini"
                  onClick={() => {
                    if (!props.onOpenSession(leaf.sessionId)) props.onOpenMissing();
                  }}
                >
                  <Icon name="external-link" size={12} /> {t.intentPanel.openSession}
                </button>
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
