/**
 * GET /edges 契约的严格解析（parseIntentEdges）—— 以它为界：畸形 = 不可用
 * （返回 null），半张图不画。links 是 QA 之间的历史理由边（契约 7 定稿，无 hop）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_SLOTS, findAskEdge, intentSlotNumber, parseIntentEdges, type IntentEdges } from "./intent-edges.ts";

const EDGE = {
  qaId: "q1",
  slot: 3,
  score: 0.82,
  band: "high",
  connection: "同构机制：同一个传输层问题。",
  prediction: "你会关心断流怎么判。",
  evidence: "「fetch 的 reader 静默结束」",
  assistant: "换 node:http。",
  dupCount: 2,
  asked: false,
  statement: null,
  verdict: null,
  edited: null,
  promoted: false,
  qa: { ts: 1759500000000, sessionId: "s-a", title: "召回流换 node:http", source: "orbita", q: "断流怎么办", a: "换 node:http" },
};

const LINK = {
  fromQaId: "q1",
  toQaId: "q2",
  slot: 1,
  connection: "就是这件事的两半。",
  edited: null,
  verdict: "yes",
  turnId: "t-earlier",
  ts: 1759400000000,
};

test("合法响应全收：edges / links / thresholds / runId", () => {
  const parsed = parseIntentEdges({
    ok: true,
    sessionId: "s",
    turnId: "t",
    runId: "r9",
    thresholds: { pass: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7], high: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9] },
    edges: [EDGE],
    links: [LINK],
  });
  assert.notEqual(parsed, null);
  if (parsed === null) return;
  assert.equal(parsed.runId, "r9");
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.edges[0]?.qa.title, "召回流换 node:http");
  assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0]?.turnId, "t-earlier");
});

test("runId 可以是 null（该 turn 没有召回记录 → edges 空）", () => {
  const parsed = parseIntentEdges({
    ok: true,
    sessionId: "s",
    turnId: "t",
    runId: null,
    thresholds: { pass: [], high: [] },
    edges: [],
    links: [],
  });
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.edges, []);
});

test("畸形整体拒收：ok 非 true / 缺 sessionId / 缺数组 / 坏 thresholds", () => {
  const good = { ok: true, sessionId: "s", turnId: "t", runId: null, thresholds: { pass: [], high: [] }, edges: [], links: [] };
  assert.equal(parseIntentEdges({ ...good, ok: false }), null);
  assert.equal(parseIntentEdges({ ...good, sessionId: 5 }), null);
  assert.equal(parseIntentEdges({ ...good, edges: "no" }), null);
  assert.equal(parseIntentEdges({ ...good, links: undefined }), null);
  assert.equal(parseIntentEdges({ ...good, thresholds: { pass: [0.7], high: "x" } }), null);
  assert.equal(parseIntentEdges(null), null);
  assert.equal(parseIntentEdges("no"), null);
});

test("单条 edge 畸形也整体拒收（数不对的图比没有图更误导）", () => {
  const good = { ok: true, sessionId: "s", turnId: "t", runId: null, thresholds: { pass: [], high: [] }, links: [] };
  assert.equal(parseIntentEdges({ ...good, edges: [{ ...EDGE, slot: 9 }] }), null);
  assert.equal(parseIntentEdges({ ...good, edges: [{ ...EDGE, score: "0.8" }] }), null);
  assert.equal(parseIntentEdges({ ...good, edges: [{ ...EDGE, band: "low" }] }), null);
  assert.equal(parseIntentEdges({ ...good, edges: [{ ...EDGE, qa: { ts: 1, sessionId: "s", title: "t", source: "o", q: "q" } }] }), null);
  assert.equal(parseIntentEdges({ ...good, links: [{ ...LINK, verdict: "no" }] }), null);
});

test("verdict 的合法值：yes / no / skip / null；edited / statement 可 null", () => {
  const good = { ok: true, sessionId: "s", turnId: "t", runId: null, thresholds: { pass: [], high: [] }, links: [] };
  for (const verdict of ["yes", "no", "skip", null]) {
    const parsed = parseIntentEdges({ ...good, edges: [{ ...EDGE, verdict, asked: true, statement: "陈述", edited: null }] });
    assert.equal(parsed?.edges[0]?.verdict ?? null, verdict);
  }
});

test("六个岗位的 id 与名字（图与卡片的岗名真源）", () => {
  assert.deepEqual(
    INTENT_SLOTS.map((slot) => slot.id),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(INTENT_SLOTS[0]?.name, "同一件事");
  assert.equal(INTENT_SLOTS[5]?.name, "时序与修订");
});

test("摘句窗口（契约 2026-10-14 增补）：qWindow/aWindow 可选——缺席与畸形都退回旧行为", () => {
  const good = { ok: true, sessionId: "s", turnId: "t", runId: null, thresholds: { pass: [], high: [] }, links: [] };
  // 旧服务端：没有这两个字段 → undefined
  const old = parseIntentEdges({ ...good, edges: [{ ...EDGE }] });
  assert.equal(old?.edges[0]?.qa.qWindow, undefined);
  assert.equal(old?.edges[0]?.qa.aWindow, undefined);
  // 新服务端：五字段齐全才带
  const win = { start: 600, total: 4000, cutBefore: true, cutAfter: false, located: true, fallback: false };
  const withWindow = parseIntentEdges({ ...good, edges: [{ ...EDGE, qa: { ...EDGE.qa, qWindow: win } }] });
  assert.deepEqual(withWindow?.edges[0]?.qa.qWindow, win);
  assert.equal(withWindow?.edges[0]?.qa.aWindow, undefined);
  // 畸形（缺字段 / 类型不对）按缺席处理，不连累整条边
  const malformed = parseIntentEdges({ ...good, edges: [{ ...EDGE, qa: { ...EDGE.qa, qWindow: { start: "x" } } }] });
  assert.equal(malformed?.edges[0]?.qa.qWindow, undefined);
  assert.notEqual(malformed, null);
});

/** 一张合法的小图：两条边同 qaId 不同岗，供 join 测试用。 */
const GRAPH: IntentEdges = {
  sessionId: "s",
  turnId: "t",
  runId: "r",
  thresholds: { pass: [0.7], high: [0.9] },
  edges: [
    { ...EDGE, qaId: "q1", slot: 2, band: "mid", asked: true, statement: "陈述", score: 0.75 },
    { ...EDGE, qaId: "q1", slot: 3, band: "high", asked: false, score: 0.95 },
    { ...EDGE, qaId: "q2", slot: 2, band: "mid", asked: false, score: 0.71 },
  ],
  links: [],
};

test("intentSlotNumber：岗名 → 岗号；认不出为 null", () => {
  assert.equal(intentSlotNumber("同一目的"), 2);
  assert.equal(intentSlotNumber("时序与修订"), 6);
  assert.equal(intentSlotNumber("不存在"), null);
});

test("findAskEdge：按 qaId + 岗名 join；找不到为 null（卡片只显示 ask 自带的）", () => {
  const hit = findAskEdge(GRAPH, { qaId: "q1", slot: "同一目的" });
  assert.equal(hit?.score, 0.75);
  assert.equal(hit?.statement, "陈述");
  // 岗名对不上号 / qaId 不在图里 → null，不崩
  assert.equal(findAskEdge(GRAPH, { qaId: "q1", slot: "别的叫法" }), null);
  assert.equal(findAskEdge(GRAPH, { qaId: "q9", slot: "同一目的" }), null);
  // 同 qaId 多岗不串：岗 3 那条是另一条
  assert.equal(findAskEdge(GRAPH, { qaId: "q1", slot: "同构机制" })?.score, 0.95);
});
