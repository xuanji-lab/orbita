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
  /** 「打开会话」：主槽打开那条来源会话 */
  onOpenSession: (sessionId: string) => void;
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
          listRef={listRef}
        />
      </div>
    </RightPanelFrame>
  );
}

/* ---------------------------------------------------------------- 图 */

function IntentGraph(props: {
  /** 图区高度（px）；folded 时图占满面板 */
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
  const [size, setSize] = useState({ w: 380, h: 320 });
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const measure = (): void =>
      setSize((prev) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 布局种子（按视图各存一份）：新问长在旧图上，旧节点基本不动 */
  const seedRef = useRef(new Map<string, LayoutSeed>());
  const scene = useMemo<ClusterScene | null>(() => {
    if (!props.hasData) return null;
    const seed = seedRef.current.get(props.view);
    const built =
      props.view === "questions"
        ? (() => {
            const centres: EgoCentre[] = props.centreLeaves.map((turn) => ({
              key: turn.turnId,
              label: t.intentPanel.roundChip(turn.round, ""),
              past: turn.round !== props.latestRound,
              leaves: turn.leaves,
            }));
            if (centres.length === 0) return null;
            return buildEgoScene([...centres, ...props.extraCentres], props.colorMode, size.w, size.h, {
              seed,
            });
          })()
        : buildSlotScene(props.slotLeaves, props.colorMode, size.w, size.h, { seed });
    if (built !== null) seedRef.current.set(props.view, sceneSeed(built));
    return built;
  }, [props.view, props.colorMode, props.slotLeaves, props.centreLeaves, props.extraCentres, props.latestRound, props.hasData, size.w, size.h, t]);

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
      {props.hasData && scene === null && <p className="intent-summary">{t.intentPanel.errorFetch}</p>}
      {props.hasData && scene !== null && (
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
          <ClusterSvg
            scene={scene}
            selKey={props.selKey}
            activeRound={props.activeRound}
            onSelectLeaf={props.onSelectLeaf}
          />
        </>
      )}
    </div>
  );
}

/** SVG 绘制：枝 → 桥 → 簇心 → 叶 → 胞体。着色与轮号的语义见文件头。 */
function ClusterSvg(props: {
  scene: ClusterScene;
  selKey: string | null;
  activeRound: number | null;
  onSelectLeaf: (rowKey: string) => void;
}) {
  const bend = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const k = 0.12;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx - dy * k).toFixed(1)},${(my + dx * k).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  };
  const { nodes, links } = props.scene;
  const inRound = (leaf: ClusterLeaf): boolean =>
    props.activeRound === null || leaf.rounds.includes(props.activeRound);
  const denseLeaves = nodes.filter((node) => node.kind === "leaf").length > 40;
  return (
    <svg className="intent-cluster" width="100%" height="100%">
      <g>
        {links.map((link, at) => {
          if (link.bridge === true) return null;
          const dimByRound = link.b.kind === "leaf" && !inRound(link.b.leaf);
          return (
            <path
              key={`l${at}`}
              className={`ibr${link.dim || dimByRound ? " dim" : ""}`}
              d={bend(link.a, link.b)}
              strokeWidth={link.w ?? 1}
              strokeOpacity={link.op ?? 0.5}
              fill="none"
              style={
                link.b.kind === "leaf"
                  ? { stroke: `color-mix(in srgb, var(--color-nebula) ${link.b.percent}%, transparent)` }
                  : undefined
              }
            />
          );
        })}
      </g>
      <g>
        {links.map((link, at) =>
          link.bridge === true ? (
            <path key={`b${at}`} className="ibridge" d={bend(link.a, link.b)} fill="none" strokeWidth={1.2} />
          ) : null,
        )}
      </g>
      <g>
        {nodes.map((node) =>
          node.kind === "hub" ? (
            <g key={node.id}>
              <circle className="ihub" cx={node.x} cy={node.y} r={node.r} />
              {node.label !== "" && (
                <text className="ihub-label" x={node.x} y={node.y - node.r - 5} textAnchor="middle">
                  {node.label}
                </text>
              )}
            </g>
          ) : null,
        )}
      </g>
      <g>
        {nodes.map((node) => {
          if (node.kind !== "leaf") return null;
          const selected = props.selKey === node.rowKey;
          const cls = [
            "ileaf",
            node.leaf.solid ? "" : " mid",
            node.shared ? " shared" : "",
            inRound(node.leaf) ? "" : " dim",
            node.leaf.verdict === "yes" ? " yes" : "",
            selected ? " sel" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const neb = `color-mix(in srgb, var(--color-nebula) ${node.percent}%, transparent)`;
          // 轮号：只在大节点或选中时标（密集模式全靠颜色，不凑数）
          const showRound = selected || (!denseLeaves && node.r >= 3.2);
          return (
            <g key={node.id} className={cls} onClick={() => props.onSelectLeaf(node.rowKey)}>
              <circle className="ileaf-halo" cx={node.x} cy={node.y} r={node.r + 4} style={{ fill: neb }} />
              <circle
                className="ileaf-core"
                cx={node.x}
                cy={node.y}
                r={Math.max(node.r, 1)}
                style={selected ? undefined : { fill: node.leaf.solid ? neb : "var(--color-bg-panel)", stroke: neb }}
              />
              {showRound && (
                <text className="ileaf-round" x={node.x + node.r + 3} y={node.y - node.r + 1}>
                  {node.leaf.lastRound}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <g>
        {nodes.map((node) =>
          node.kind === "soma" ? (
            <g key={node.id} className={`isoma${node.past ? " past" : ""}`}>
              <circle className="imembrane" cx={node.x} cy={node.y} r={node.r + 6} />
              <circle className="isoma-core" cx={node.x} cy={node.y} r={node.r} />
              {node.label !== "" && (
                <text className="isoma-label" x={node.x} y={node.y + node.r + 15} textAnchor="middle">
                  {node.label}
                </text>
              )}
            </g>
          ) : null,
        )}
      </g>
    </svg>
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
  onOpenSession: (sessionId: string) => void;
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
  onOpenSession: (sessionId: string) => void;
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
              <p>
                <b>{t.intentPanel.youSaid}</b> {t.intentPanel.quote(leaf.q)}
              </p>
              {leaf.a !== "" && (
                <p>
                  <b>{t.intentPanel.answerThen}</b> {leaf.a}
                </p>
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
                <button type="button" className="intent-mini" onClick={() => props.onOpenSession(leaf.sessionId)}>
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
