/**
 * 右栏「意图」面板（实验功能 intent-system）—— 一问一图。
 *
 * 上：SVG 图（纵向时间、六条岗位泳道、本问在底、全部汇入；详见 intent-graph.ts
 * 的文件头）。下：入选卡片列表，与图**并列看**（不是图的详情卡）。两向联动：
 * 点图节点 → 卡片列表滚到对应卡并点亮；悬停卡片 → 点亮图节点。
 *
 * 数据：本会话的召回轮（session 的 intentRecalls）选一问 → GET /edges；
 * 进行中的召回先用 review 事件画（草稿图），done 后以 /edges 为准。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { INTENT_SLOTS, type IntentEdges } from "@shared/intent-edges";
import type { IntentRecallRecord } from "@shared/session";
import type { RecallCardState } from "@shared/intent-recall";
import type { IntentAskView } from "@shared/intent-recall";
import {
  apartLabelUnit,
  buildIntentGraph,
  layoutIntentGraph,
  type GraphNode,
} from "./intent-graph.ts";

/** 悬停提示的内容（节点 / 连线两种）。 */
type HoverTip =
  | { kind: "node"; node: GraphNode }
  | { kind: "edge"; title: string; body: string };

export function IntentPanel(props: {
  sessionId: string | null;
  /** 本会话的终态召回卡（新 → 旧由调用方排好；用于 turn 选择） */
  turns: readonly IntentRecallRecord[];
  /** 运行中的召回（最新一问正在跑时用它先画） */
  liveRun: RecallCardState | null;
  /** 挂起的回答前确认（被问到的边在图上高亮为「等你确认」） */
  pendingAsk: IntentAskView[] | null;
}) {
  const t = useT();
  // 选中的 turnId：null = 跟最新（有 liveRun 用 liveRun 的 turn，否则 turns[0]）
  const [pickedTurn, setPickedTurn] = useState<string | null>(null);
  const turnId =
    pickedTurn !== null && props.turns.some((turn) => turn.turnId === pickedTurn)
      ? pickedTurn
      : (props.liveRun?.turnId ?? props.turns[0]?.turnId ?? null);
  const record = props.turns.find((turn) => turn.turnId === turnId) ?? null;
  const isLive = props.liveRun !== null && props.liveRun.turnId === turnId;

  const [edges, setEdges] = useState<IntentEdges | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    if (props.sessionId === null || turnId === null) {
      setEdges(null);
      setState("ready");
      return () => undefined;
    }
    setState("loading");
    void api.intent
      .edges(props.sessionId, turnId)
      .then((result) => {
        if (cancelled) return;
        setEdges(result);
        setState(result === null ? "error" : "ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId, turnId]);

  const graph = useMemo(() => (edges !== null ? buildIntentGraph(edges) : null), [edges]);
  const [selectedQa, setSelectedQa] = useState<string | null>(null);
  const [hover, setHover] = useState<{ tip: HoverTip; x: number; y: number } | null>(null);
  const cardListRef = useRef<HTMLDivElement | null>(null);

  const summary =
    graph !== null && graph.nodes.length > 0
      ? t.intentPanel.summary(
          graph.nodes.length,
          graph.nodes.reduce((sum, node) => sum + node.entries.length, 0),
          new Set(graph.nodes.map((node) => node.sessionId)).size,
        ) + (graph.withdrawn > 0 ? t.intentPanel.deniedLine(graph.withdrawn) : "")
      : null;

  if (props.turns.length === 0 && props.liveRun === null) {
    return (
      <PanelBody>
        <p style={emptyStyle}>{t.intentPanel.emptyNoTurns}</p>
      </PanelBody>
    );
  }

  return (
    <PanelBody>
      {/* turn 选择：本问（或运行中）在前，更早的按时间倒序列出 */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <span style={kickerStyle}>{t.intentPanel.subtitle}</span>
        {isLive && <span style={liveBadgeStyle}>{t.intentPanel.liveBadge}</span>}
        <span style={{ flex: 1 }} />
        <select
          value={turnId ?? ""}
          onChange={(event) => setPickedTurn(event.target.value)}
          style={selectStyle}
          aria-label={t.intentPanel.subtitle}
        >
          {props.liveRun !== null && props.liveRun.turnId !== record?.turnId && (
            <option value={props.liveRun.turnId}>{t.intentPanel.latestTurn}</option>
          )}
          {props.turns.map((turn, at) => (
            <option key={turn.turnId} value={turn.turnId}>
              {at === 0 && turn.turnId === (props.liveRun?.turnId ?? turn.turnId)
                ? t.intentPanel.latestTurn
                : t.intentPanel.earlierTurn(shortWhen(turn.startedAt))}
            </option>
          ))}
        </select>
      </div>

      {state === "loading" && graph === null && <p style={emptyStyle}>{t.intentPanel.loading}</p>}
      {state === "error" && graph === null && <p style={emptyStyle}>{t.intentPanel.errorFetch}</p>}
      {graph !== null && graph.nodes.length === 0 && (
        <p style={emptyStyle}>{t.intentPanel.emptyNoRecall}</p>
      )}
      {summary !== null && <p style={summaryStyle}>{summary}</p>}

      {graph !== null && graph.nodes.length > 0 && (
        <>
          {graph.dense && <p style={summaryStyle}>{t.intentPanel.denseNote}</p>}
          <IntentGraphSvg
            graph={graph}
            live={isLive}
            pendingQa={new Set((props.pendingAsk ?? []).map((ask) => ask.qaId))}
            selected={selectedQa}
            onSelect={(qaId) => {
              setSelectedQa(qaId);
              // 点哪个节点，卡片列表就滚到对应卡片
              const card = cardListRef.current?.querySelector<HTMLElement>(`[data-qa-id="${qaId}"]`);
              card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }}
            onHover={setHover}
          />
          <CardList
            graph={graph}
            selected={selectedQa}
            onHoverCard={(qaId) => setSelectedQa(qaId === selectedQa ? selectedQa : qaId)}
            onSelectCard={setSelectedQa}
            listRef={cardListRef}
          />
        </>
      )}
      {hover !== null && (
        <div style={tipStyle} role="tooltip">
          {hover.tip.kind === "node" ? (
            <>
              <TipHead>{t.intentPanel.nodeMeta(shortWhen(hover.tip.node.ts), hover.tip.node.source, hover.tip.node.title)}</TipHead>
              <TipHead>{t.intentPanel.nodeSlots(hover.tip.node.entries.map((entry) => `${INTENT_SLOTS[entry.slot - 1]?.name ?? entry.slot} ${entry.score.toFixed(2)}`).join(" · "))}</TipHead>
              <TipBody>{t.intentPanel.nodeQuote(hover.tip.node.q)}</TipBody>
            </>
          ) : (
            <>
              <TipHead>{hover.tip.title}</TipHead>
              <TipBody>{hover.tip.body}</TipBody>
            </>
          )}
        </div>
      )}
    </PanelBody>
  );
}

/* ---------------------------------------------------------------- 图（SVG） */

function IntentGraphSvg(props: {
  graph: ReturnType<typeof buildIntentGraph>;
  live: boolean;
  pendingQa: ReadonlySet<string>;
  selected: string | null;
  onSelect: (qaId: string) => void;
  onHover: (hover: { tip: HoverTip; x: number; y: number } | null) => void;
}) {
  const t = useT();
  const hostRef = useRef<SVGSVGElement | null>(null);
  const { graph } = props;
  const layout = useMemo(() => layoutIntentGraph(hostRef.current?.clientWidth ?? 440, graph.nodes, graph.dense), [graph]);
  // 宽度测量：首帧后重排一次（ResizeObserver 太重，面板宽度基本不变）
  const [widthTick, setWidthTick] = useState(0);
  useEffect(() => {
    if (hostRef.current === null) return;
    const measure = (): void => setWidthTick((tick) => (layout.width === hostRef.current?.clientWidth ? tick : tick + 1));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [layout.width]);
  void widthTick;

  const nodePos = (node: GraphNode): { x: number; y: number } => ({
    x: layout.laneX(node.primary),
    y: layout.yOf(node),
  });
  const edgePath = (conn: ReturnType<typeof buildIntentGraph>["connections"][number]): string => {
    const p = conn.kind === "link" ? nodePos(conn.a) : { x: layout.laneX(conn.slot ?? 1), y: nodePos(conn.a).y };
    const q =
      conn.b !== null
        ? conn.kind === "slot"
          ? { x: layout.laneX(conn.slot ?? 1), y: layout.yOf(conn.b) }
          : nodePos(conn.b)
        : { x: layout.somaX, y: layout.somaY };
    if (conn.kind !== "slot") {
      const bend = (q.x >= p.x ? 1 : -1) * 22;
      return `M${p.x},${p.y} C${p.x + bend},${p.y + 16} ${q.x + bend},${q.y - 16} ${q.x},${q.y}`;
    }
    const dy = (q.y - p.y) / 2;
    return `M${p.x},${p.y} C${p.x},${p.y + dy} ${q.x},${q.y - dy} ${q.x},${q.y}`;
  };

  // 密集模式：拿不准（非实心）不连线，只画尘点；稀疏模式全连
  const connections = graph.dense
    ? graph.connections.filter((conn) => conn.kind !== "slot" || conn.a.entries.find((e) => e.slot === conn.slot)?.solid)
    : graph.connections;

  return (
    <svg
      ref={hostRef}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{ width: "100%", height: layout.height, display: "block" }}
      onMouseLeave={() => props.onHover(null)}
    >
      {/* 六条岗位泳道 */}
      {INTENT_SLOTS.map((slot) => (
        <g key={slot.id}>
          <line
            x1={layout.laneX(slot.id)}
            x2={layout.laneX(slot.id)}
            y1={layout.top + 6}
            y2={layout.somaY - 40}
            className="intent-lane"
          />
          <text x={layout.laneX(slot.id)} y={layout.top - 10} textAnchor="middle" className="intent-lane-head">
            {slot.name}
          </text>
        </g>
      ))}
      {/* 左侧刻度：稀疏每条一行日期；密集只标月份 */}
      {!layout.dense
        ? graph.nodes.map((node) => (
            <text key={node.qaId} x={10} y={layout.yOf(node) + 3} className="intent-gutter">
              {shortWhen(node.ts).slice(0, 5)}
            </text>
          ))
        : graph.nodes.map((node, at) => {
            const month = new Date(node.ts).getMonth() + 1;
            const prev = graph.nodes[at - 1];
            if (prev !== undefined && new Date(prev.ts).getMonth() + 1 === month) return null;
            return (
              <text key={node.qaId} x={8} y={layout.yOf(node) + 4} className="intent-gutter">
                {month}
              </text>
            );
          })}
      {/* 连线 */}
      <g>
        {connections.map((conn, at) => {
          const w =
            conn.kind === "slot"
              ? (layout.dense ? 0.4 : 0.8) + (layout.dense ? 1.6 : 3.0) * (conn.score ?? 0) * (conn.score ?? 0)
              : conn.kind === "session"
                ? layout.dense
                  ? 0.6
                  : 1.1
                : 1.4;
          return (
            <path
              key={at}
              d={edgePath(conn)}
              className={`intent-edge ${conn.kind}`}
              strokeWidth={w}
              onMouseEnter={(event) => {
                if (layout.dense) return;
                const host = hostRef.current?.getBoundingClientRect();
                const rect = (event.target as SVGPathElement).getBoundingClientRect();
                props.onHover({
                  tip: { kind: "edge", title: edgeTitle(conn, t), body: edgeBody(conn, t) },
                  x: (rect.left - (host?.left ?? 0)) + 8,
                  y: (rect.top - (host?.top ?? 0)) + 4,
                });
              }}
              onMouseLeave={() => props.onHover(null)}
            />
          );
        })}
      </g>
      {/* 节点 */}
      <g>
        {graph.nodes.map((node) => {
          const p = nodePos(node);
          const max = Math.max(...node.entries.map((entry) => entry.score));
          const r = layout.dense ? 1.2 + 3.2 * max : 3.5 + 4.5 * max;
          const hasYes = node.entries.some((entry) => entry.verdict === "yes" || (entry.verdict !== null && entry.edited !== null));
          const hasPending = props.pendingQa.has(node.qaId);
          const solid = node.entries.some((entry) => entry.solid);
          const cls = [
            "intent-node",
            hasPending ? "ask" : "",
            hasYes ? "yes" : "",
            props.selected === node.qaId ? "sel" : "",
            solid ? "" : "hollow",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <g
              key={node.qaId}
              transform={`translate(${p.x},${p.y})`}
              className={cls}
              onClick={() => props.onSelect(node.qaId)}
              onMouseEnter={(event) => {
                const host = hostRef.current?.getBoundingClientRect();
                const rect = (event.currentTarget as SVGGElement).getBoundingClientRect();
                props.onHover({
                  tip: { kind: "node", node },
                  x: rect.left - (host?.left ?? 0) + 10,
                  y: rect.top - (host?.top ?? 0) + 4,
                });
              }}
              onMouseLeave={() => props.onHover(null)}
            >
              {!layout.dense && <circle r={r + 6} className="intent-halo" />}
              {/* 其它岗位的突触点 + 连回主节点的细线 */}
              {node.entries.map((entry) =>
                entry.slot === node.primary ? null : (
                  <g key={entry.slot}>
                    {!layout.dense && (
                      <line
                        x1={Math.sign(layout.laneX(entry.slot) - p.x) * r}
                        y1={0}
                        x2={layout.laneX(entry.slot) - p.x}
                        y2={0}
                        className="intent-dendrite"
                      />
                    )}
                    <circle
                      cx={layout.laneX(entry.slot) - p.x}
                      cy={0}
                      r={(layout.dense ? 0.8 : 2) + (layout.dense ? 1.6 : 2.6) * entry.score}
                      className={`intent-syn${props.pendingQa.has(node.qaId) ? " ask" : ""}`}
                    />
                  </g>
                ),
              )}
              {hasYes && !layout.dense && <circle r={r + 3} className="intent-ring" />}
              <circle r={r} className="intent-core" />
              {node.entries.some((entry) => entry.verdict !== null && entry.edited !== null) && !layout.dense && (
                <text x={r + 4} y={-r - 1} className="intent-edit-mark">
                  改
                </text>
              )}
            </g>
          );
        })}
      </g>
      {/* 本问 */}
      <g transform={`translate(${layout.somaX},${layout.somaY})`} className="intent-soma">
        <circle r={17} className="intent-ring" />
        <circle r={10} className="intent-core" />
        <text y={34} textAnchor="middle" className="intent-lane-head">
          {t.intentPanel.latestTurn}
        </text>
      </g>
    </svg>
  );
}

/** 连线悬停的标题（同为某岗 / 同会话 / 历史联系）。 */
function edgeTitle(
  conn: ReturnType<typeof buildIntentGraph>["connections"][number],
  t: ReturnType<typeof useT>,
): string {
  if (conn.kind === "link" && conn.b !== null) {
    const apart = apartLabelUnit(conn.a.ts, conn.b.ts);
    const when = shortWhen(conn.linkTs ?? conn.a.ts);
    return `${t.intentPanel.edgeLink(when)} · ${
      apart.days !== null ? t.intentPanel.daysApart(apart.days) : t.intentPanel.hoursApart(apart.hours ?? 1)
    }`;
  }
  if (conn.kind === "session" && conn.b !== null) {
    return t.intentPanel.edgeSession(
      conn.a.title,
      INTENT_SLOTS[conn.a.primary - 1]?.name ?? String(conn.a.primary),
      INTENT_SLOTS[conn.b.primary - 1]?.name ?? String(conn.b.primary),
    );
  }
  const slotName = INTENT_SLOTS[(conn.slot ?? 1) - 1]?.name ?? "";
  if (conn.b === null) {
    return t.intentPanel.edgeToQuestion(slotName, (conn.score ?? 0).toFixed(2));
  }
  const apart = apartLabelUnit(conn.a.ts, conn.b.ts);
  return t.intentPanel.edgeBetween(
    slotName,
    (conn.score ?? 0).toFixed(2),
    apart.days !== null ? t.intentPanel.daysApart(apart.days) : t.intentPanel.hoursApart(apart.hours ?? 1),
  );
}

/** 连线悬停的正文：连本问 = 该端的 connection（改字优先）；两 QA 之间 = 两端各自的 connection。 */
function edgeBody(
  conn: ReturnType<typeof buildIntentGraph>["connections"][number],
  t: ReturnType<typeof useT>,
): string {
  const connOf = (node: GraphNode, slot: number | null): string => {
    if (slot === null) return "";
    const entry = node.entries.find((item) => item.slot === slot);
    return entry?.edited ?? entry?.connection ?? "";
  };
  if (conn.kind === "link") return conn.text ?? "";
  if (conn.kind === "session") return "";
  if (conn.b === null) return connOf(conn.a, conn.slot);
  return [
    `${shortWhen(conn.a.ts).slice(0, 5)} ${connOf(conn.a, conn.slot)}`,
    `${shortWhen(conn.b.ts).slice(0, 5)} ${connOf(conn.b, conn.slot)}`,
  ].join("\n");
}

/* ---------------------------------------------------------------- 卡片列表 */

function CardList(props: {
  graph: ReturnType<typeof buildIntentGraph>;
  selected: string | null;
  onHoverCard: (qaId: string) => void;
  onSelectCard: (qaId: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      <span style={kickerStyle}>{t.intentPanel.cardsTitle}</span>
      <div ref={props.listRef} className="scroll" style={{ display: "grid", gap: "var(--space-2)", maxHeight: 420, overflowY: "auto" }}>
        {props.graph.nodes.map((node) => {
          const pending = node.entries.some((entry) => entry.verdict === null && entry.asked);
          return (
            <div
              key={node.qaId}
              data-qa-id={node.qaId}
              onMouseEnter={() => props.onHoverCard(node.qaId)}
              onClick={() => props.onSelectCard(node.qaId)}
              className={`intent-card${props.selected === node.qaId ? " sel" : ""}`}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)", minWidth: 0 }}>
                <span style={cardTitleStyle}>{node.title}</span>
                <span style={{ flex: 1 }} />
                <span style={cardMetaStyle}>
                  {shortWhen(node.ts)} · {node.source}
                </span>
              </div>
              {node.entries.map((entry) => {
                const state =
                  entry.verdict === "yes"
                    ? t.intentPanel.cardVerdictAsked
                    : entry.verdict === "no"
                      ? t.intentPanel.cardVerdictDenied
                      : entry.verdict === "skip"
                        ? t.intentPanel.cardVerdictSkipped
                        : entry.asked
                          ? t.intentPanel.cardVerdictPending
                          : t.intentPanel.cardVerdictUnasked;
                const edited = entry.verdict !== null && entry.edited !== null;
                return (
                  <div key={entry.slot} style={{ display: "grid", gap: 2, paddingBlock: "var(--space-1)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <span style={slotNameStyle}>{INTENT_SLOTS[entry.slot - 1]?.name}</span>
                      <span className="intent-score-track" aria-hidden="true">
                        <i style={{ width: `${Math.round(entry.score * 100)}%` }} />
                      </span>
                      <span style={cardMetaStyle}>{entry.score.toFixed(2)}</span>
                      <span style={slotStateStyle}>{state}</span>
                    </div>
                    <p style={connStyle}>{edited ? entry.edited : entry.connection}</p>
                    {edited && <p style={{ ...connStyle, color: "var(--color-text-tertiary)" }}>{entry.connection}</p>}
                  </div>
                );
              })}
              <p style={qaStyle}>
                <span style={kickerStyle}>{t.intentPanel.cardYou}</span> {t.intentPanel.nodeQuote(clip(node.q, 160))}
              </p>
              {node.a !== "" && (
                <p style={qaStyle}>
                  <span style={kickerStyle}>{t.intentPanel.cardAnswer}</span> {clip(node.a, 160)}
                </p>
              )}
              {pending && <span style={liveBadgeStyle}>{t.intentPanel.cardVerdictPending}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 小件 */

function PanelBody(props: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        display: "grid",
        gap: "var(--space-3)",
        alignContent: "start",
        padding: "var(--space-4)",
      }}
      className="scroll"
    >
      {props.children}
    </div>
  );
}

function TipHead(props: { children: React.ReactNode }) {
  return <div className="intent-tip-head">{props.children}</div>;
}
function TipBody(props: { children: React.ReactNode }) {
  return <div className="intent-tip-body">{props.children}</div>;
}

/** epoch ms → 本地「MM-DD HH:mm」。 */
function shortWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-tertiary)",
};
const summaryStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-caption)",
  lineHeight: "var(--line-height-caption)",
  color: "var(--color-text-secondary)",
};
const kickerStyle: React.CSSProperties = {
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-tertiary)",
  textTransform: "none",
};
const liveBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "1px 8px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--color-border-subtle)",
  color: "var(--color-text-secondary)",
  fontSize: "var(--font-size-micro)",
  width: "fit-content",
};
const selectStyle: React.CSSProperties = {
  maxWidth: 160,
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-secondary)",
  background: "var(--color-bg-muted)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "2px 6px",
};
const cardTitleStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--font-size-caption)",
  fontWeight: "var(--weight-bold)",
  color: "var(--color-text-primary)",
};
const cardMetaStyle: React.CSSProperties = {
  flex: "0 0 auto",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-tertiary)",
};
const slotNameStyle: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-secondary)",
};
const slotStateStyle: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-tertiary)",
};
const connStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-micro)",
  lineHeight: "var(--line-height-caption)",
  color: "var(--color-text-secondary)",
};
const qaStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-micro)",
  lineHeight: "var(--line-height-caption)",
  color: "var(--color-text-tertiary)",
};
const tipStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  display: "grid",
  gap: 4,
  maxWidth: 300,
  padding: "var(--space-2)",
  borderRadius: "var(--radius-md)",
  background: "var(--glass-bg)",
  boxShadow: "var(--shadow-composer)",
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-secondary)",
  pointerEvents: "none",
};
