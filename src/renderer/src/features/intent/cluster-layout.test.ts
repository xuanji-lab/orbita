/**
 * 簇布局与配色的纯函数测试：确定性（同数据同图）、分簇与桥、多问合并（轮号 /
 * rounds 汇总）、着色三档（轮次 / 相关度）、种子布局的稳定性（新节点长进来，
 * 旧节点位移有界）、中心封顶；以及用**真实数据**（55 片叶 / 26 会话 / 7 问）
 * 在面板尺寸（320–460 × 340）下的布局指标回归：贴边、直接挂岗位 hub 的叶、
 * 中心离墙、虚线桥占比、标签不重复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GROW_ALPHA,
  MAX_CENTRES,
  SLOT_CLUSTER_NAMES,
  boundaryMargin,
  buildEgoScene,
  buildSlotScene,
  centresOfTurns,
  leafRange,
  mergeTurnLeaves,
  nebulaPercentOf,
  orbitaCentreCandidates,
  parentLinks,
  parseOrbitaQaId,
  pathToRoot,
  sceneSeed,
  simulateToConvergence,
  spineLeaves,
  tick,
  unseededCount,
  type ClusterLeaf,
  type ClusterScene,
  type TurnLeaves,
} from "./cluster-layout.ts";
import { REAL_EDGE_ROWS } from "./cluster-layout.fixture.ts";

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

/** 再走一轮全体最多能挪多远（px）：收敛判定的度量。不改变节点状态。 */
function maxDrift(scene: ClusterScene): number {
  const before = scene.nodes.map((node) => ({ x: node.x, y: node.y }));
  tick(scene.nodes, scene.links, scene.w, scene.h, 0.02, 8);
  let worst = 0;
  scene.nodes.forEach((node, i) => {
    const was = before[i]!;
    worst = Math.max(worst, Math.hypot(node.x - was.x, node.y - was.y));
    node.x = was.x;
    node.y = was.y;
  });
  return worst;
}

test("确定性：同数据两次构建 + 收敛，坐标逐点相同", () => {
  const leaves = [
    leaf("q1", 1, 0.95),
    leaf("q2", 1, 0.8),
    leaf("q3", 3, 0.75, { sessionId: "s-q3", title: "会话 q3" }),
    leaf("q4", 3, 0.7, { sessionId: "s-q4", title: "会话 q4" }),
    leaf("q5", 5, 0.72, { sessionId: "s-q4", title: "会话 q4" }),
  ];
  const a = buildSlotScene(leaves, 400, 400);
  const b = buildSlotScene(leaves, 400, 400);
  simulateToConvergence(a);
  simulateToConvergence(b);
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.x.toFixed(3), n.y.toFixed(3)]),
    b.nodes.map((n) => [n.id, n.x.toFixed(3), n.y.toFixed(3)]),
  );
});

test("构建只产生结构，不跑模拟：build 之后坐标还是初始摆放（收敛由渲染器负责）", () => {
  const leaves = [leaf("q1", 1, 0.95), leaf("q2", 3, 0.8), leaf("q3", 5, 0.7)];
  const scene = buildSlotScene(leaves, 400, 400);
  assert.equal(scene.w, 400);
  assert.equal(scene.h, 400);
  // 初始摆放离收敛还远：满热度走一轮会动不少
  const before = scene.nodes.map((n) => ({ x: n.x, y: n.y }));
  tick(scene.nodes, scene.links, 400, 400, 1, 8);
  const moved = Math.max(...scene.nodes.map((n, i) => Math.hypot(n.x - before[i]!.x, n.y - before[i]!.y)));
  assert.ok(moved > 2, `build 不应已经收敛（走一轮最大位移 ${moved.toFixed(1)}px）`);
  const iters = simulateToConvergence(scene);
  assert.ok(iters > 100 && iters < 800, `收敛轮数 ${iters}`);
  assert.ok(maxDrift(scene) < 0.5, "收敛后每轮位移应 < 0.5px");
});

test("按岗位成簇：六个岗位簇心；≥2 条的 (岗位, 会话) 分叉子簇；单条按首轮归枝；跨岗 QA 拉桥", () => {
  const leaves = [
    leaf("q1", 1, 0.95),
    leaf("q2", 1, 0.8),
    leaf("q3", 3, 0.75, { sessionId: "same", title: "同会话" }),
    leaf("q4", 3, 0.7, { sessionId: "same", title: "同会话" }), // (岗3, same) 两条 → 子簇（常规模式 ≥2 就标名）
    leaf("q1", 5, 0.72, { sessionId: "s-q1", title: "会话 q1" }), // q1 跨岗 → 桥
  ];
  const scene = buildSlotScene(leaves, 400, 400);
  const hubs = scene.nodes.filter((n): n is Extract<typeof n, { kind: "hub" }> => n.kind === "hub");
  assert.equal(hubs.filter((h) => !h.sub).length, 6);
  const subs = hubs.filter((h) => h.sub);
  // 岗3 的 same 会话一个子簇（标名）；岗1 两条单条来源（同一轮）归成一根不标名的枝；岗5 只有一条直接挂
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((h) => h.label).sort(), ["", "同会话"]);
  assert.equal(scene.links.filter((l) => l.bridge === true).length, 1);
  const q1Leaves = scene.nodes.filter((n) => n.kind === "leaf" && n.leaf.qaId === "q1");
  assert.equal(q1Leaves.length, 2);
  assert.ok(q1Leaves.every((n) => n.kind === "leaf" && n.shared));
  // 本问胞体钉在中心（可拖、松手弹回）
  const soma = scene.nodes.find((n) => n.kind === "soma");
  assert.deepEqual(soma?.pin, { x: 200, y: 200 });
});

test("按提问成网络：多中心；被多问召回的 QA 一片叶子、两边各一根实线（不是虚线桥）", () => {
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
  const scene = buildEgoScene(centres, 400, 400);
  const somas = scene.nodes.filter((n) => n.kind === "soma");
  assert.equal(somas.length, 2);
  // 本问（past=false）钉在中心；旧中心带强向心
  assert.equal(somas.filter((s) => s.pin !== undefined).length, 1);
  assert.ok(somas.every((s) => (s.grav ?? 1) > 1));
  const q1 = scene.nodes.filter((n) => n.kind === "leaf" && n.leaf.qaId === "q1");
  assert.equal(q1.length, 1);
  assert.equal((q1[0] as { shared: boolean }).shared, true);
  const egoLinks = scene.links.filter((l) => l.ego === true);
  assert.equal(egoLinks.length, 2);
  assert.ok(egoLinks.every((l) => l.a === q1[0] || l.b === q1[0]));
  assert.equal(scene.links.filter((l) => l.bridge === true).length, 0, "按提问视图没有虚线桥");
  assert.deepEqual((q1[0] as { leaf: ClusterLeaf }).leaf.rounds, [1, 2]);
  assert.equal((q1[0] as { leaf: ClusterLeaf }).leaf.lastRound, 2);
});

test("中心封顶：超过 MAX_CENTRES 问时，更早的几问并成一个「更早」中心，叶子不失联", () => {
  const turns: TurnLeaves[] = Array.from({ length: 8 }, (_, i) => ({
    turnId: `t${i + 1}`,
    round: i + 1,
    leaves: [leaf(`q${i + 1}`, 1, 0.8, { lastRound: i + 1, rounds: [i + 1] })],
  }));
  const centres = centresOfTurns(turns, 8, (r) => `第 ${r} 问`, (a, b) => `第 ${a}–${b} 问`);
  assert.equal(centres.length, MAX_CENTRES);
  assert.equal(centres[0]!.label, "第 1–3 问");
  assert.equal(centres[0]!.past, true);
  assert.equal(centres[0]!.leaves.length, 3);
  assert.equal(centres[centres.length - 1]!.label, "第 8 问");
  assert.equal(centres[centres.length - 1]!.past, false);
  // 不超上限时每问一个中心
  assert.equal(centresOfTurns(turns.slice(0, 6), 6, (r) => `${r}`, () => "").length, 6);
});

test("合并：同一 (qaId, 岗) 跨问并成一个节点，展示取最近一问，rounds 汇总", () => {
  const turns: TurnLeaves[] = [
    { turnId: "t1", round: 1, leaves: [leaf("q1", 1, 0.8, { connection: "第一问的理由", verdict: "skip" })] },
    { turnId: "t2", round: 2, leaves: [leaf("q1", 1, 0.9, { connection: "第二问的理由", verdict: null })] },
  ];
  const merged = mergeTurnLeaves(turns, (l) => `${l.qaId}#${l.slot}`);
  assert.equal(merged.length, 1);
  const only = merged[0]!;
  assert.equal(only.connection, "第二问的理由");
  assert.equal(only.lastRound, 2);
  assert.deepEqual(only.rounds, [1, 2]);
  const twoSlots = mergeTurnLeaves(
    [{ turnId: "t1", round: 1, leaves: [leaf("q1", 1, 0.8), leaf("q1", 2, 0.7)] }],
    (l) => `${l.qaId}#${l.slot}`,
  );
  assert.equal(twoSlots.length, 2);
});

test("着色：时间与相关度按权重相加，连续浓度 20–100", () => {
  const range = { rMin: 1, rMax: 4, sMin: 0.7, sMax: 1.0 };
  // w = 0：只看时间
  assert.equal(nebulaPercentOf(0, { lastRound: 1, score: 0.9 }, range), 20);
  assert.equal(nebulaPercentOf(0, { lastRound: 4, score: 0.7 }, range), 100);
  // w = 1：只看相关度
  assert.equal(nebulaPercentOf(1, { lastRound: 4, score: 0.7 }, range), 20);
  assert.equal(nebulaPercentOf(1, { lastRound: 1, score: 1.0 }, range), 100);
  // w = 0.5：两套分数各占一半——又早又弱最淡、又新又强最满、一新一弱居中
  assert.equal(nebulaPercentOf(0.5, { lastRound: 1, score: 0.7 }, range), 20);
  assert.equal(nebulaPercentOf(0.5, { lastRound: 4, score: 1.0 }, range), 100);
  assert.equal(nebulaPercentOf(0.5, { lastRound: 4, score: 0.7 }, range), 60);
  // 越界权重夹到 [0, 1]；退化区间取中
  assert.equal(nebulaPercentOf(2, { lastRound: 1, score: 1.0 }, range), 100);
  assert.equal(nebulaPercentOf(0, { lastRound: 1, score: 0.9 }, { ...range, rMin: 1, rMax: 1 }), 60);
  assert.deepEqual(
    leafRange([leaf("q1", 1, 0.7, { lastRound: 2, rounds: [2] }), leaf("q2", 1, 0.95, { lastRound: 5, rounds: [5] })]),
    { rMin: 2, rMax: 5, sMin: 0.7, sMax: 0.95 },
  );
});

test("种子布局：全部有种子 → unseededCount 为 0（切回视图不加热）；新问从 GROW_ALPHA 长出，旧节点位移有界", () => {
  const base = [
    leaf("q1", 1, 0.95, { ts: 1 * DAY }),
    leaf("q2", 2, 0.9, { ts: 2 * DAY }),
    leaf("q3", 3, 0.85, { ts: 3 * DAY }),
    leaf("q4", 4, 0.8, { ts: 4 * DAY }),
    leaf("q5", 5, 0.75, { ts: 5 * DAY }),
    leaf("q6", 6, 0.7, { ts: 6 * DAY }),
  ];
  const before = buildSlotScene(base, 400, 400);
  simulateToConvergence(before);
  const seed = sceneSeed(before);
  const same = buildSlotScene(base, 400, 400, { seed });
  assert.equal(unseededCount(same, seed), 0);
  assert.ok(maxDrift(same) < 0.5, "全部有种子时直接就是收敛态");
  const grown = buildSlotScene(
    [
      ...base,
      leaf("q7", 2, 0.92, { ts: 7 * DAY }),
      leaf("q8", 2, 0.88, { ts: 8 * DAY }),
      leaf("q9", 6, 0.86, { ts: 9 * DAY }),
      leaf("q1", 4, 0.9, { ts: 10 * DAY }),
    ],
    400,
    400,
    { seed },
  );
  assert.ok(unseededCount(grown, seed) > 0);
  simulateToConvergence(grown, { alpha: GROW_ALPHA });
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
  assert.ok(maxShift < 80, `旧节点最大位移 ${maxShift.toFixed(1)}px 应 < 80px`);
  assert.ok(total / count < 25, `旧节点平均位移 ${(total / count).toFixed(1)}px 应 < 25px`);
  assert.ok(grown.nodes.some((n) => n.id === "leaf:q7#2"));
});

test("orbita 中心候选 / qaId 解析：前缀、去重、封顶；畸形忽略", () => {
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
  assert.deepEqual(orbitaCentreCandidates(leaves, 0), [], "预算 0 一个都不给（以前会多给一个 → 7 个中心）");
  assert.deepEqual(parseOrbitaQaId("orbita:sA:t1"), { sessionId: "sA", turnId: "t1" });
  assert.equal(parseOrbitaQaId("orbita:bad"), null);
  assert.equal(parseOrbitaQaId("claude:x:1"), null);
});

test("岗位簇名（图与列表的岗名真源）", () => {
  assert.deepEqual(SLOT_CLUSTER_NAMES.length, 6);
  assert.equal(SLOT_CLUSTER_NAMES[0], "同一件事");
  assert.equal(SLOT_CLUSTER_NAMES[5], "时序与修订");
});

/* ---------------------------------------------------------------- 真实数据的布局指标 */

const realTurns: TurnLeaves[] = (() => {
  const byRound = new Map<number, ClusterLeaf[]>();
  for (const [round, qaId, slot, score, sessionId, ts] of REAL_EDGE_ROWS) {
    const list = byRound.get(round) ?? [];
    list.push(leaf(qaId, slot, score, { sessionId, title: `会话 ${sessionId}`, ts: ts * 1000, lastRound: round, rounds: [round] }));
    byRound.set(round, list);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, leaves]) => ({ turnId: `t${round}`, round, leaves }));
})();

function egoLeavesOf(leaves: readonly ClusterLeaf[]): ClusterLeaf[] {
  const byQa = new Map<string, ClusterLeaf>();
  for (const item of leaves) {
    const found = byQa.get(item.qaId);
    if (found === undefined || item.score > found.score) byQa.set(item.qaId, item);
  }
  return [...byQa.values()];
}

function layoutMetrics(scene: ClusterScene): {
  edgePct: number;
  directPct: number;
  minSomaWall: number;
  dashedPct: number;
  dupLabels: string[];
} {
  const { w: W, h: H } = scene;
  const atEdge = scene.nodes.filter((n) => n.x < 12 || n.x > W - 12 || n.y < 12 || n.y > H - 12);
  const leafLinks = scene.links.filter((l) => l.b.kind === "leaf" && l.bridge !== true && l.ego !== true);
  const direct = leafLinks.filter((l) => l.a.kind === "hub" && !l.a.sub);
  const somas = scene.nodes.filter((n) => n.kind === "soma");
  const labels = scene.nodes.flatMap((n) => (n.kind !== "leaf" && n.label !== "" ? [n.label] : []));
  return {
    edgePct: atEdge.length / scene.nodes.length,
    directPct: leafLinks.length === 0 ? 0 : direct.length / leafLinks.length,
    minSomaWall: Math.min(...somas.map((s) => Math.min(s.x, W - s.x, s.y, H - s.y))),
    dashedPct: scene.links.filter((l) => l.bridge === true).length / scene.links.length,
    dupLabels: labels.filter((l, i) => labels.indexOf(l) !== i),
  };
}

for (const W of [320, 380, 460]) {
  const H = 340;
  test(`真实数据 · 按岗位 ${W}×${H}：贴边 <10%、直接挂岗位 hub 的叶 <30%、中心离墙 >24px、标签不重复、收敛静止`, () => {
    const leaves = mergeTurnLeaves(realTurns, (l) => `${l.qaId}#${l.slot}`);
    assert.equal(leaves.length, 55);
    const scene = buildSlotScene(leaves, W, H);
    assert.equal(scene.dense, true);
    simulateToConvergence(scene);
    const m = layoutMetrics(scene);
    assert.ok(m.edgePct < 0.1, `贴边 ${(m.edgePct * 100).toFixed(1)}%`);
    assert.ok(m.directPct < 0.3, `直接挂岗位 hub ${(m.directPct * 100).toFixed(1)}%`);
    assert.ok(m.minSomaWall > 24, `中心离墙 ${m.minSomaWall.toFixed(1)}px`);
    assert.deepEqual(m.dupLabels, []);
    assert.ok(maxDrift(scene) < 0.5, "收敛后静止");
    // 跨岗桥是结构性的（30 条 QA 里 25 条在两个岗位都入选）：数量 = 多岗 QA 数
    const multiSlot = new Set(leaves.map((l) => l.qaId)).size;
    assert.equal(scene.links.filter((l) => l.bridge === true).length, leaves.length - multiSlot);
    assert.ok(boundaryMargin(W, H) >= 20);
  });

  test(`真实数据 · 按提问 ${W}×${H}：≤6 中心、中心离墙 >24px、贴边 <10%、虚线桥 <20%（实为 0）、标签不重复`, () => {
    const centreLeaves = realTurns.map((turn) => ({ ...turn, leaves: egoLeavesOf(turn.leaves) }));
    const centres = centresOfTurns(centreLeaves, 7, (r) => `第 ${r} 问`, (a, b) => `第 ${a}–${b} 问`);
    assert.equal(centres.length, MAX_CENTRES);
    const scene = buildEgoScene(centres, W, H);
    simulateToConvergence(scene);
    const m = layoutMetrics(scene);
    assert.ok(m.minSomaWall > 24, `中心离墙 ${m.minSomaWall.toFixed(1)}px`);
    assert.ok(m.edgePct < 0.1, `贴边 ${(m.edgePct * 100).toFixed(1)}%`);
    assert.ok(m.dashedPct < 0.2, `虚线 ${(m.dashedPct * 100).toFixed(1)}%`);
    assert.deepEqual(m.dupLabels, []);
    // 孤立中心也在画面里：每个中心离画面中心不超过半对角线的 3/4
    for (const soma of scene.nodes.filter((n) => n.kind === "soma")) {
      const d = Math.hypot(soma.x - W / 2, soma.y - H / 2);
      assert.ok(d < (Math.hypot(W, H) / 2) * 0.75, `${soma.label} 离中心 ${d.toFixed(0)}px`);
    }
    assert.ok(maxDrift(scene) < 0.5, "收敛后静止");
  });
}

test("真实数据 · 5 问 → 7 问长出：旧节点平均位移小（图是长出来的，不是重排）", () => {
  // 第 7 问只召回了一条已在图上的 QA，所以从 5 问起长（第 6 问带来 11 条）
  const six = buildSlotScene(mergeTurnLeaves(realTurns.slice(0, 5), (l) => `${l.qaId}#${l.slot}`), 380, 340);
  simulateToConvergence(six);
  const seed = sceneSeed(six);
  const seven = buildSlotScene(mergeTurnLeaves(realTurns, (l) => `${l.qaId}#${l.slot}`), 380, 340, { seed });
  assert.ok(unseededCount(seven, seed) > 0);
  simulateToConvergence(seven, { alpha: GROW_ALPHA });
  let total = 0;
  let count = 0;
  for (const node of seven.nodes) {
    const was = seed.get(node.id);
    if (was === undefined) continue;
    total += Math.hypot(node.x - was.x, node.y - was.y);
    count += 1;
  }
  // 两轮带来 21 个新节点（+34%），旧节点平均只挪 ~10px（340px 画布的 3%）
  assert.ok(total / count < 12, `旧节点平均位移 ${(total / count).toFixed(1)}px 应 < 12px`);
});

test("主干：相关度最高的几片叶各自沿树走回本问胞体，路径不经过跨岗桥，止于胞体", () => {
  const leaves = [
    leaf("q1", 1, 0.95),
    leaf("q2", 1, 0.8),
    leaf("q3", 3, 0.75, { sessionId: "same", title: "同会话" }),
    leaf("q4", 3, 0.7, { sessionId: "same", title: "同会话" }),
    leaf("q1", 5, 0.72, { sessionId: "s-q1", title: "会话 q1" }),
    leaf("q9", 2, 0.99, { verdict: "no" }),
  ];
  const scene = buildSlotScene(leaves, 400, 400);
  const parent = parentLinks(scene);
  const spine = spineLeaves(scene, parent, 2);
  assert.deepEqual(spine.map((n) => n.rowKey), ["q1#1", "q2#1"], "按分数取前几，被否认的不进");
  const soma = scene.nodes.find((n) => n.kind === "soma");
  for (const node of scene.nodes.filter((n) => n.kind === "leaf")) {
    const path = pathToRoot(node, parent);
    assert.ok(path.length >= 2, `${node.id} 至少两跳（叶 → 岗位 → 胞体）`);
    assert.ok(path.every((l) => l.bridge !== true), "主干不走跨岗桥");
    const last = path[path.length - 1]!;
    assert.ok(last.a === soma || last.b === soma, "最后一跳到本问胞体");
  }
  // 子簇里的叶多一跳：叶 → 子簇 → 岗位 → 胞体
  const q3 = scene.nodes.find((n) => n.kind === "leaf" && n.leaf.qaId === "q3")!;
  assert.equal(pathToRoot(q3, parent).length, 3);
});

test("主干（按提问）：只连到旧中心的叶，路径止于那个旧中心；连到本问的走到本问", () => {
  const centres = [
    { key: "t1", label: "第 1 问", past: true, leaves: [leaf("q2", 2, 0.8, { sessionId: "s-q2", title: "会话 q2" })] },
    { key: "t2", label: "第 2 问", past: false, leaves: [leaf("q3", 3, 0.75, { sessionId: "s-q3", title: "会话 q3", lastRound: 2, rounds: [2] })] },
  ];
  const scene = buildEgoScene(centres, 400, 400);
  const parent = parentLinks(scene);
  const end = (qaId: string) => {
    const node = scene.nodes.find((n) => n.kind === "leaf" && n.leaf.qaId === qaId)!;
    const path = pathToRoot(node, parent);
    const last = path[path.length - 1]!;
    const tip = [last.a, last.b].find((n) => n.kind === "soma");
    return tip !== undefined && tip.kind === "soma" ? tip.past : null;
  };
  assert.equal(end("q3"), false, "本问的叶走到本问胞体");
  assert.equal(end("q2"), true, "只属旧问的叶止于旧中心");
  // q2（0.8）比 q3（0.75）更相关，但它连不到本问——主干只取连得到本问的
  assert.deepEqual(spineLeaves(scene, parent).map((n) => n.leaf.qaId), ["q3"]);
});
