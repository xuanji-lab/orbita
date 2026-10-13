/**
 * GET /edges 契约的严格解析（parseIntentEdges）—— 以它为界：畸形 = 不可用
 * （返回 null），半张图不画。links 是 QA 之间的历史理由边（契约 7 定稿，无 hop）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_SLOTS, parseIntentEdges } from "./intent-edges.ts";

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
