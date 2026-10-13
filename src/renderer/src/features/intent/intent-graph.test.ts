/**
 * 右栏意图图的纯计算：buildIntentGraph（撤下跳过 / 主节点取最高分 / 同岗链 /
 * 同会话虚线不重复 / links 只画两端都在的）与 layout（密集模式按时间比例）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildIntentGraph, layoutIntentGraph } from "./intent-graph.ts";
import type { IntentEdges } from "@shared/intent-edges";

const DAY = 86_400_000;

function edge(
  qaId: string,
  slot: number,
  score: number,
  band: "high" | "mid",
  qa: { ts: number; sessionId: string; title: string },
  extra: Partial<Parameters<typeof buildIntentGraph>[0]["edges"][number]> = {},
): Parameters<typeof buildIntentGraph>[0]["edges"][number] {
  return {
    qaId,
    slot,
    score,
    band,
    connection: `${qaId}#${slot} 的理由`,
    prediction: "",
    evidence: "",
    assistant: "",
    dupCount: 1,
    asked: false,
    statement: null,
    verdict: null,
    edited: null,
    promoted: false,
    qa: { ts: qa.ts, sessionId: qa.sessionId, title: qa.title, source: "orbita", q: `${qaId} 的原话`, a: `${qaId} 的回答` },
    ...extra,
  };
}

function graphOf(edges: readonly unknown[], links: readonly unknown[] = []): ReturnType<typeof buildIntentGraph> {
  return buildIntentGraph({
    sessionId: "s",
    turnId: "t",
    runId: "r",
    thresholds: { pass: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7], high: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9] },
    edges: edges as Parameters<typeof buildIntentGraph>[0]["edges"],
    links: links as Parameters<typeof buildIntentGraph>[0]["links"],
  });
}

test("主节点取最高分的岗位；同岗按时间连成链、最后一个连到本问", () => {
  const q1 = { ts: 1 * DAY, sessionId: "s-a", title: "早" };
  const q2 = { ts: 2 * DAY, sessionId: "s-b", title: "晚" };
  const g = graphOf([
    edge("q1", 3, 0.5, "high", q1),
    edge("q1", 1, 0.9, "high", q1), // 最高分在岗 1 → 主节点在岗 1，岗 3 是突触点
    edge("q2", 1, 0.8, "high", q2),
  ]);
  assert.equal(g.nodes.length, 2);
  const n1 = g.nodes.find((n) => n.qaId === "q1");
  assert.equal(n1?.primary, 1);
  assert.equal(n1?.entries.length, 2);
  // 岗 1 的链：q1 → q2 →（本问，b = null）
  const slot1 = g.connections.filter((c) => c.kind === "slot" && c.slot === 1);
  assert.deepEqual(
    slot1.map((c) => [c.a.qaId, c.b?.qaId ?? null]),
    [["q1", "q2"], ["q2", null]],
  );
  // 岗 3 只有 q1：直接连本问
  const slot3 = g.connections.filter((c) => c.kind === "slot" && c.slot === 3);
  assert.deepEqual(slot3.map((c) => [c.a.qaId, c.b?.qaId ?? null]), [["q1", null]]);
});

test("verdict=no 撤下：节点少一条入选（全撤则整个节点消失），链跳过它重连", () => {
  const q1 = { ts: 1 * DAY, sessionId: "s-a", title: "早" };
  const q2 = { ts: 2 * DAY, sessionId: "s-b", title: "中" };
  const q3 = { ts: 3 * DAY, sessionId: "s-c", title: "晚" };
  const g = graphOf([
    edge("q1", 2, 0.8, "high", q1),
    edge("q2", 2, 0.75, "high", q2, { verdict: "no", asked: true }),
    edge("q3", 2, 0.7, "high", q3),
  ]);
  assert.equal(g.withdrawn, 1);
  assert.equal(g.nodes.length, 2); // q2 只有一条且被撤 → 整个节点不画
  const slot2 = g.connections.filter((c) => c.kind === "slot" && c.slot === 2);
  assert.deepEqual(
    slot2.map((c) => [c.a.qaId, c.b?.qaId ?? null]),
    [["q1", "q3"], ["q3", null]], // 链跳过被撤的 q2 重连
  );
});

test("mid 档不实心；promoted / yes / 改字算实心；被问未答计 pending", () => {
  const qa = { ts: 1 * DAY, sessionId: "s-a", title: "问" };
  // 同一条 QA 在五个岗位上各有一条 mid 档入选
  const g = graphOf([
    edge("same", 1, 0.5, "mid", qa),
    edge("same", 2, 0.5, "mid", qa, { promoted: true }),
    edge("same", 3, 0.5, "mid", qa, { verdict: "yes", asked: true }),
    edge("same", 4, 0.5, "mid", qa, { asked: true, verdict: null }),
    edge("same", 5, 0.5, "mid", qa, { verdict: "skip", asked: true }),
  ]);
  assert.equal(g.nodes.length, 1);
  const bySlot = (slot: number) => g.nodes[0]?.entries.find((entry) => entry.slot === slot);
  assert.equal(bySlot(1)?.solid, false);
  assert.equal(bySlot(2)?.solid, true);
  assert.equal(bySlot(3)?.solid, true);
  assert.equal(bySlot(4)?.solid, false);
  assert.equal(bySlot(5)?.solid, false);
  assert.equal(g.pending, 1); // 只有 d 是被问未答
});

test("同会话虚线：时间相邻成串；已被同岗链连过的对不重复", () => {
  const q1 = { ts: 1 * DAY, sessionId: "same", title: "一" };
  const q2 = { ts: 2 * DAY, sessionId: "same", title: "二" };
  const g = graphOf([edge("q1", 1, 0.8, "high", q1), edge("q2", 5, 0.7, "high", q2)]);
  const session = g.connections.filter((c) => c.kind === "session");
  assert.deepEqual(session.map((c) => [c.a.qaId, c.b?.qaId]), [["q1", "q2"]]);
  // 同岗同会话：slot 链已连，session 虚线不再画
  const g2 = graphOf([edge("q1", 1, 0.8, "high", q1), edge("q2", 1, 0.7, "high", { ...q2, sessionId: "same" })]);
  assert.equal(g2.connections.filter((c) => c.kind === "session").length, 0);
});

test("links 只画两端都在图上的；悬停文本用户改字优先", () => {
  const q1 = { ts: 1 * DAY, sessionId: "s-a", title: "一" };
  const q2 = { ts: 2 * DAY, sessionId: "s-b", title: "二" };
  const links = [
    { fromQaId: "q1", toQaId: "q2", slot: 1, connection: "原始理由", edited: null, verdict: null, turnId: "t0", ts: 1.5 * DAY },
    { fromQaId: "q1", toQaId: "gone", slot: 2, connection: "悬空", edited: null, verdict: null, turnId: "t0", ts: 1.5 * DAY },
    { fromQaId: "q2", toQaId: "q1", slot: 3, connection: "原始", edited: "用户改的说法", verdict: "yes", turnId: "t1", ts: 1.5 * DAY },
  ];
  const g = graphOf([edge("q1", 1, 0.8, "high", q1), edge("q2", 4, 0.7, "high", q2)], links);
  const drawn = g.connections.filter((c) => c.kind === "link");
  assert.equal(drawn.length, 2); // 悬空的 gone 不画
  assert.ok(drawn.every((c) => c.text !== null && c.text !== "悬空"));
  assert.equal(drawn.find((c) => c.text === "用户改的说法") !== undefined, true);
});

test("超过 40 条 QA 进密集模式；布局按真实时间比例", () => {
  const edges = Array.from({ length: 45 }, (_, i) =>
    edge(`q${i}`, 1 + (i % 6), 0.5 + (i % 5) / 10, "high", { ts: i * DAY, sessionId: `s${i % 7}`, title: `问 ${i}` }),
  );
  const g = graphOf(edges);
  assert.equal(g.dense, true);
  const layout = layoutIntentGraph(400, g.nodes, true);
  // 时间比例：最晚的节点纵坐标大于最早的（同间隔 → 均匀分布），且 soma 在其下
  const first = layout.yOf(g.nodes[0]!);
  const last = layout.yOf(g.nodes[g.nodes.length - 1]!);
  assert.ok(last > first);
  assert.ok(layout.somaY > last);
  // 稀疏模式行距固定
  const sparse = layoutIntentGraph(400, g.nodes.slice(0, 3), false);
  assert.ok(sparse.yOf(g.nodes[1]!) - sparse.yOf(g.nodes[0]!) === 50);
});

