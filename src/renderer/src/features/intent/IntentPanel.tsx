/**
 * 右栏「意图」面板（实验功能 intent-system）—— 一问一图。
 *
 * 上：SVG 图（纵向时间、六条岗位泳道、本问在底、全部汇入；详见 intent-graph.ts
 * 的文件头）。下：入选卡片列表，与图**并列**看（不是图的详情卡）。
 *
 * 联动（2026-10-13 用户裁决）：**不做任何悬浮提示**——节点 / 连线的浮层与下面的
 * 卡片打架，能定位到卡片就不需要它；连线也不做命中交互（edge 很难点到，算了）。
 * 保留两条：点图节点 → 卡片列表滚到对应卡并点亮；悬停卡片 → 点亮图节点。
 *
 * 数据：本会话的召回轮（session 的 intentRecalls）选一问 → GET /edges。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { INTENT_SLOTS, type IntentEdges } from "@shared/intent-edges";
import type { IntentRecallRecord } from "@shared/session";
import type { RecallCardState, IntentAskView } from "@shared/intent-recall";
import { buildIntentGraph, layoutIntentGraph } from "./intent-graph.ts";

export function IntentPanel(props: {
  sessionId: string | null;
  /** 本会话的终态召回卡（新 → 旧由调用方排好；用于 turn 选择） */
  turns: readonly IntentRecallRecord[];
  /** 运行中的召回（最新一问正在跑时：turn 选择器上挂「召回中」徽标） */
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
  const isLive = props.liveRun !== null && props.liveRun.turnId === turnId;

  // 取数的版本键：选中那一问的召回落定 / 表态写回 / 运行态变化时都要重取——
  // 只按 turnId 取的话，召回刚开始打开面板拿到的空数据会一直留着（边在 done 时才写）
  const turnRecord = props.turns.find((turn) => turn.turnId === turnId);
  const fetchKey = [
    turnRecord?.id ?? "",
    turnRecord?.confirm?.edgesWritten ?? "",
    isLive ? props.liveRun?.status ?? "" : "",
    isLive ? (props.pendingAsk?.length ?? 0) : "",
  ].join("|");
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
  }, [props.sessionId, turnId, fetchKey]);

  const graph = useMemo(() => (edges !== null ? buildIntentGraph(edges) : null), [edges]);
  const [selectedQa, setSelectedQa] = useState<string | null>(null);
  const cardListRef = useRef<HTMLDivElement | null>(null);

  // 摘要按档分开数：入选（high / promoted）与拿不准（mid）是两件事，不能混说「入选」
  const counts = useMemo(() => {
    if (graph === null) return null;
    let high = 0;
    let mid = 0;
    for (const node of graph.nodes) {
      for (const entry of node.entries) {
        if (entry.solid) high += 1;
        else mid += 1;
      }
    }
    return { high, mid };
  }, [graph]);

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
          {props.turns.map((turn, at) => (
            <option key={turn.turnId} value={turn.turnId}>
              {at === 0 ? t.intentPanel.latestTurn : t.intentPanel.earlierTurn(shortWhen(turn.startedAt))}
            </option>
          ))}
        </select>
      </div>

      {state === "loading" && graph === null && <p style={emptyStyle}>{t.intentPanel.loading}</p>}
      {state === "error" && graph === null && <p style={emptyStyle}>{t.intentPanel.errorFetch}</p>}
      {graph !== null && graph.nodes.length === 0 && (
        <p style={emptyStyle}>{t.intentPanel.emptyNoRecall}</p>
      )}
      {graph !== null && counts !== null && graph.nodes.length > 0 && (
        <>
          <p style={summaryStyle}>
            {t.intentPanel.summary(
              graph.nodes.length,
              counts.high,
              counts.mid,
              new Set(graph.nodes.map((node) => node.sessionId)).size,
            )}
            {graph.withdrawn > 0 ? t.intentPanel.deniedLine(graph.withdrawn) : ""}
          </p>
          {graph.dense && <p style={summaryStyle}>{t.intentPanel.denseNote}</p>}
          <IntentGraphSvg
            graph={graph}
            pendingQa={new Set((props.pendingAsk ?? []).map((ask) => ask.qaId))}
            selected={selectedQa}
            onSelect={(qaId) => {
              // 点哪个节点，卡片列表就滚到对应卡片并点亮
              setSelectedQa(qaId);
              const card = cardListRef.current?.querySelector<HTMLElement>(`[data-qa-id="${qaId}"]`);
              card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }}
          />
          <CardList
            graph={graph}
            selected={selectedQa}
            onHoverCard={setSelectedQa}
            onSelectCard={setSelectedQa}
            listRef={cardListRef}
          />
        </>
      )}
    </PanelBody>
  );
}

/* ---------------------------------------------------------------- 图（SVG） */

function IntentGraphSvg(props: {
  graph: ReturnType<typeof buildIntentGraph>;
  pendingQa: ReadonlySet<string>;
  selected: string | null;
  onSelect: (qaId: string) => void;
}) {
  const t = useT();
  const hostRef = useRef<SVGSVGElement | null>(null);
  const { graph } = props;
  const layout = useMemo(() => layoutIntentGraph(hostRef.current?.clientWidth ?? 440, graph.nodes, graph.dense), [graph]);
  // 宽度测量：首帧后重排一次（面板宽度基本不变，不开 ResizeObserver）
  const [, setWidthTick] = useState(0);
  useEffect(() => {
    const measure = (): void =>
      setWidthTick((tick) => (layout.width === hostRef.current?.clientWidth ? tick : tick + 1));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [layout.width]);

  const nodePos = (node: ReturnType<typeof buildIntentGraph>["nodes"][number]): { x: number; y: number } => ({
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
      {/* 连线（纯展示：不做悬停 / 点击，无命中区——2026-10-13 用户裁决） */}
      <g pointerEvents="none">
        {connections.map((conn, at) => {
          const w =
            conn.kind === "slot"
              ? (layout.dense ? 0.4 : 0.8) + (layout.dense ? 1.6 : 3.0) * (conn.score ?? 0) * (conn.score ?? 0)
              : conn.kind === "session"
                ? layout.dense
                  ? 0.6
                  : 1.1
                : 1.4;
          return <path key={at} d={edgePath(conn)} className={`intent-edge ${conn.kind}`} strokeWidth={w} />;
        })}
      </g>
      {/* 节点：点 = 滚到对应卡片；无悬停提示 */}
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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}>
      <span style={kickerStyle}>{t.intentPanel.cardsTitle}</span>
      <div ref={props.listRef} className="scroll intent-card-list">
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
              <div className="intent-card-head">
                <span className="intent-card-title">{node.title}</span>
                <span style={{ flex: 1 }} />
                <span className="intent-card-meta">
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
                    <div className="intent-card-slotrow">
                      <span className="intent-card-slotname">{INTENT_SLOTS[entry.slot - 1]?.name}</span>
                      <span className="intent-score-track" aria-hidden="true">
                        <i style={{ width: `${Math.round(entry.score * 100)}%` }} />
                      </span>
                      <span className="intent-card-meta">{entry.score.toFixed(2)}</span>
                      <span className="intent-card-slotstate">{state}</span>
                    </div>
                    <p className="intent-card-conn clamp-3">{edited ? entry.edited : entry.connection}</p>
                    {edited && (
                      <p className="intent-card-conn clamp-2 intent-card-conn-original">{entry.connection}</p>
                    )}
                  </div>
                );
              })}
              <p className="intent-card-qa clamp-3">
                <span style={kickerStyle}>{t.intentPanel.cardYou}</span> {t.intentPanel.nodeQuote(node.q)}
              </p>
              {node.a !== "" && (
                <p className="intent-card-qa clamp-3">
                  <span style={kickerStyle}>{t.intentPanel.cardAnswer}</span> {t.intentPanel.nodeQuote(node.a)}
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

/** epoch ms → 本地「MM-DD HH:mm」。 */
function shortWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
