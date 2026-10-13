/**
 * 簇布局与配色的纯函数测试：确定性（同数据同图）、分簇与桥、多问合并（轮号 /
 * rounds 汇总）、着色三档（轮次 / 相关度）、种子布局的稳定性（新节点长进来，
 * 旧节点位移有界）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_CLUSTER_NAMES,
  buildEgoScene,
  buildSlotScene,
  leafRange,
  mergeTurnLeaves,
  nebulaPercentOf,
  orbitaCentreCandidates,
  sceneSeed,
  type ClusterLeaf,
  type TurnLeaves,
} from "./cluster-layout.ts";

const DAY = 86_400_000;

function leaf(
  qaId: string,
  slot: number,
  score: number,
  extra: Partial<ClusterLeaf> = {},
): ClusterLeaf {
  return {
    qaId,
    slot,
    score,
    solid: score >= 0.9,
    verdict: null,
    edited: null,
    connection: `${qaId} 的理由`,
    asked: false,
    ts: 1 * DAY,
    sessionId: `s-${qaId.slice(0, 2)}`,
    title: `会话 ${qaId.slice(0, 2)}`,
    source: "orbita",
    q: `${qaId} 的原话`,
    a: `${qaId} 的回答`,
    lastRound: 1,
    rounds: [1],
    ...extra,
  };
}

test("确定性：同数据两次构建，坐标逐点相同", () => {
  const leaves = [
    leaf("q1", 1, 0.95),
    leaf("q2", 1, 0.8),
    leaf("q3", 3, 0.75, { sessionId: "s-q3", title: "会话 q3" }),
    leaf("q4", 3, 0.7, { sessionId: "s-q4", title: "会话 q4" }),
    leaf("q5", 5, 0.72, { sessionId: "s-q4", title: "会话 q4" }),
  ];
  const a = buildSlotScene(leaves, "time", 400, 400);
  const b = buildSlotScene(leaves, "time", 400, 400);
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.x.toFixed(3), n.y.toFixed(3)]),
    b.nodes.map((n) => [n.id, n.x.toFixed(3), n.y.toFixed(3)]),
  );
});

test("按岗位成簇：六个岗位簇心；≥2 条的 (岗位, 会话) 分叉子簇；跨岗 QA 拉桥", () => {
  const leaves = [
    leaf("q1", 1, 0.95),
    leaf("q2", 1, 0.8), // (岗1, s-q1... 注意 sessionId 不同) —— 各自单条，不分叉
    leaf("q3", 3, 0.75, { sessionId: "same", title: "同会话" }),
    leaf("q4", 3, 0.7, { sessionId: "same", title: "同会话" }), // (岗3, same) 两条 → 子簇
    leaf("q1", 5, 0.72, { sessionId: "s-q1", title: "会话 q1" }), // q1 跨岗 → 桥
  ];
  const scene = buildSlotScene(leaves, "time", 400, 400);
  const hubs = scene.nodes.filter((n) => n.kind === "hub");
  // 六个岗位簇心 + 一个子簇（岗3 的 same 会话）
  assert.equal(hubs.filter((h) => h.kind === "hub" && !h.sub).length, 6);
  assert.equal(hubs.filter((h) => h.kind === "hub" && h.sub).length, 1);
  // 子簇标来源会话名（≥2 条；<3 条不标 label，但结构在）
  // 桥恰好一根（q1 跨岗 1 与 5）
  assert.equal(scene.links.filter((l) => l.bridge === true).length, 1);
  // 两片 q1 叶子都带 shared
  const q1Leaves = scene.nodes.filter((n) => n.kind === "leaf" && n.leaf.qaId === "q1");
  assert.equal(q1Leaves.length, 2);
  assert.ok(q1Leaves.every((n) => n.kind === "leaf" && n.shared));
});

test("按提问成网络：多中心；被多问召回的 QA 一片叶子、两边各一根桥", () => {
  const centres = [
    {
      key: "t1",
      label: "第 1 问",
      past: true,
      leaves: [leaf("q1", 1, 0.9), leaf("q2", 2, 0.8, { sessionId: "s-q2", title: "会话 q2" })],
    },
    {
      key: "t2",
      label: "第 2 问",
      past: false,
      leaves: [
        leaf("q1", 1, 0.9, { lastRound: 2, rounds: [2] }),
        leaf("q3", 3, 0.75, { sessionId: "s-q3", title: "会话 q3", lastRound: 2, rounds: [2] }),
      ],
    },
  ];
  const scene = buildEgoScene(centres, "time", 400, 400);
  // 两个中心 soma；本问（past=false）固定
  const somas = scene.nodes.filter((n) => n.kind === "soma");
  assert.equal(somas.length, 2);
  assert.equal(somas.filter((s) => s.kind === "soma" && s.fixed).length, 1);
  // q1 只有一片叶子（合并），标 shared，两条桥（各连一个中心的簇）
  const q1 = scene.nodes.filter((n) => n.kind === "leaf" && n.leaf.qaId === "q1");
  assert.equal(q1.length, 1);
  assert.equal((q1[0] as { shared: boolean }).shared, true);
  const bridges = scene.links.filter((l) => l.bridge === true);
  assert.equal(bridges.length, 2);
  assert.ok(bridges.every((l) => l.a === q1[0] || l.b === q1[0]));
  // q1 的轮号汇总两问
  assert.deepEqual((q1[0] as { leaf: ClusterLeaf }).leaf.rounds, [1, 2]);
  assert.equal((q1[0] as { leaf: ClusterLeaf }).leaf.lastRound, 2);
});

test("合并：同一 (qaId, 岗) 跨问并成一个节点，展示取最近一问，rounds 汇总", () => {
  const turns: TurnLeaves[] = [
    { turnId: "t1", round: 1, leaves: [leaf("q1", 1, 0.8, { connection: "第一问的理由", verdict: "skip" })] },
    { turnId: "t2", round: 2, leaves: [leaf("q1", 1, 0.9, { connection: "第二问的理由", verdict: null })] },
  ];
  const merged = mergeTurnLeaves(turns, (l) => `${l.qaId}#${l.slot}`);
  assert.equal(merged.length, 1);
  const only = merged[0]!;
  assert.equal(only.connection, "第二问的理由"); // 最近一问的展示数据
  assert.equal(only.lastRound, 2);
  assert.deepEqual(only.rounds, [1, 2]);
  // 键不同的（不同岗位）不合
  const twoSlots = mergeTurnLeaves(
    [{ turnId: "t1", round: 1, leaves: [leaf("q1", 1, 0.8), leaf("q1", 2, 0.7)] }],
    (l) => `${l.qaId}#${l.slot}`,
  );
  assert.equal(twoSlots.length, 2);
});

test("着色：time 按轮次归一三档，score 按分数归一三档", () => {
  const range = { rMin: 1, rMax: 4, sMin: 0.7, sMax: 1.0 };
  assert.equal(nebulaPercentOf("time", { lastRound: 1, score: 0.9 }, range), 30);
  assert.equal(nebulaPercentOf("time", { lastRound: 2, score: 0.9 }, range), 62);
  assert.equal(nebulaPercentOf("time", { lastRound: 4, score: 0.9 }, range), 100);
  assert.equal(nebulaPercentOf("score", { lastRound: 1, score: 0.7 }, range), 30);
  assert.equal(nebulaPercentOf("score", { lastRound: 1, score: 0.85 }, range), 62);
  assert.equal(nebulaPercentOf("score", { lastRound: 1, score: 1.0 }, range), 100);
  // 单轮（rMin == rMax）不爆除法：中档
  assert.equal(nebulaPercentOf("time", { lastRound: 1, score: 0.9 }, { ...range, rMin: 1, rMax: 1 }), 62);
  // leafRange 从数据里取极差
  assert.deepEqual(
    leafRange([leaf("q1", 1, 0.7, { lastRound: 2, rounds: [2] }), leaf("q2", 1, 0.95, { lastRound: 5, rounds: [5] })]),
    { rMin: 2, rMax: 5, sMin: 0.7, sMax: 0.95 },
  );
});

test("种子布局的稳定性：新问加进来，旧节点的位移有界（图是长出来的）", () => {
  const base = [
    leaf("q1", 1, 0.95, { ts: 1 * DAY }),
    leaf("q2", 2, 0.9, { ts: 2 * DAY }),
    leaf("q3", 3, 0.85, { ts: 3 * DAY }),
    leaf("q4", 4, 0.8, { ts: 4 * DAY }),
    leaf("q5", 5, 0.75, { ts: 5 * DAY }),
    leaf("q6", 6, 0.7, { ts: 6 * DAY }),
  ];
  const before = buildSlotScene(base, "time", 400, 400);
  const seed = sceneSeed(before);
  // 新的一问长出 4 片新叶（其中一片是旧 QA 的新岗位）
  const grown = buildSlotScene(
    [
      ...base,
      leaf("q7", 2, 0.92, { ts: 7 * DAY }),
      leaf("q8", 2, 0.88, { ts: 8 * DAY }),
      leaf("q9", 6, 0.86, { ts: 9 * DAY }),
      leaf("q1", 4, 0.9, { ts: 10 * DAY }),
    ],
    "time",
    400,
    400,
    { seed },
  );
  let maxShift = 0;
  let total = 0;
  let count = 0;
  for (const oldNode of before.nodes) {
    const newNode = grown.nodes.find((n) => n.id === oldNode.id);
    if (newNode === undefined) continue;
    const shift = Math.hypot(newNode.x - oldNode.x, newNode.y - oldNode.y);
    maxShift = Math.max(maxShift, shift);
    total += shift;
    count += 1;
  }
  // 小幅松弛：旧节点整体基本不动（平均位移 < 25px）；个别节点允许挪一小段——
  // 例如某条 QA 在新一问里入选了第二个岗位，跨岗桥会把它往自己的另一片叶子
  // 拉近一点（400px 的图上封顶 80px）
  assert.ok(maxShift < 80, `旧节点最大位移 ${maxShift.toFixed(1)}px 应 < 80px`);
  assert.ok(total / count < 25, `旧节点平均位移 ${(total / count).toFixed(1)}px 应 < 25px`);
  // 新节点在场
  assert.ok(grown.nodes.some((n) => n.id === "leaf:q7#2"));
});

test("orbita 中心候选：解析 qaId 前缀、去重、封顶；畸形前缀忽略", () => {
  const leaves = [
    leaf("orbita:sA:t1", 1, 0.9),
    leaf("orbita:sA:t1", 2, 0.8),
    leaf("orbita:sB:t9", 3, 0.75),
    leaf("orbita:bad", 4, 0.7),
    leaf("claude:x:1", 5, 0.7),
  ];
  assert.deepEqual(orbitaCentreCandidates(leaves, 5), [
    { sessionId: "sA", turnId: "t1" },
    { sessionId: "sB", turnId: "t9" },
  ]);
  assert.deepEqual(orbitaCentreCandidates(leaves, 1), [{ sessionId: "sA", turnId: "t1" }]);
});

test("岗位簇名（图与列表的岗名真源）", () => {
  assert.deepEqual(SLOT_CLUSTER_NAMES.length, 6);
  assert.equal(SLOT_CLUSTER_NAMES[0], "同一件事");
  assert.equal(SLOT_CLUSTER_NAMES[5], "时序与修订");
});
