import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calloutBudget,
  calloutGeometry,
  calloutRank,
  lockFrame,
  lockFramePath,
  LOCK_GAP,
  placeCallouts,
  textWidth,
  type CalloutTarget,
  type PlaceInput,
} from "./callouts.ts";

const target = (id: string, x: number, y: number, over: Partial<CalloutTarget> = {}): CalloutTarget => ({
  id,
  x,
  y,
  r: 4,
  state: "running",
  text: `任务${id}`,
  rank: 1000,
  ...over,
});

function input(targets: CalloutTarget[], over: Partial<PlaceInput> = {}): PlaceInput {
  return {
    targets,
    bodies: targets.map((t) => ({ id: t.id, x: t.x, y: t.y, r: t.r })),
    star: null,
    width: 800,
    height: 500,
    glyphPx: 12,
    budget: 5,
    ...over,
  };
}

const overlap = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("锁定框", () => {
  test("框比星体大 LOCK_GAP，臂长夹在 3–9 px；四个角括号各一段折线", () => {
    assert.equal(lockFrame(4).half, 4 + LOCK_GAP);
    assert.equal(lockFrame(0.5).arm, Math.max(3, (0.5 + LOCK_GAP) * 2 * 0.3));
    assert.equal(lockFrame(60).arm, 9);
    assert.equal(lockFramePath(100, 100, 4).match(/M/g)?.length, 4);
  });
});

describe("引线几何", () => {
  test("右上：从框右上角升起，标签在折点右侧、写在水平线上方；左下：方向全反过来", () => {
    const t = target("a", 300, 200);
    const ne = calloutGeometry(t, "ne", 0, 12);
    assert.equal(ne.start.x, 300 + lockFrame(4).half);
    assert.ok(ne.elbow.y < ne.start.y && ne.elbow.x > ne.start.x);
    assert.equal(ne.box.x0, ne.elbow.x);
    assert.equal(ne.box.y1, ne.elbow.y, "标签框底边就是水平线");
    assert.equal(ne.anchor, "start");
    const sw = calloutGeometry(t, "sw", 1, 12);
    assert.ok(sw.elbow.y > sw.start.y && sw.elbow.x < sw.start.x);
    assert.equal(sw.box.x1, sw.elbow.x);
    assert.equal(sw.anchor, "end");
    assert.ok(Math.abs(sw.elbow.y - sw.start.y) > Math.abs(ne.elbow.y - ne.start.y), "长档升得更高");
  });

  test("字宽：中文按 1em，拉丁按约 0.58em", () => {
    assert.equal(textWidth("等你", 12), 24);
    assert.ok(Math.abs(textWidth("ab", 10) - 11.6) < 1e-9);
  });
});

describe("排布与防碰撞", () => {
  test("等你排在在跑之前；预算只有 2 根时只给最要紧的两颗", () => {
    const targets = [
      target("run1", 200, 250, { rank: calloutRank("running", 0) }),
      target("wait", 500, 250, { state: "waiting", rank: calloutRank("waiting", 3) }),
      target("run2", 650, 300, { rank: calloutRank("running", 1) }),
    ];
    const placed = placeCallouts(input(targets, { budget: 2 }));
    assert.deepEqual(placed.map((p) => p.id), ["wait", "run1"]);
  });

  test("标签框互不重叠、不出画布、不压任何天体与主星（挤在一起的七颗）", () => {
    const targets = Array.from({ length: 7 }, (_, i) => target(`p${i}`, 360 + (i % 3) * 30, 220 + Math.floor(i / 3) * 26, { rank: i }));
    const star = { x: 400, y: 260, r: 20 };
    const placed = placeCallouts(input(targets, { star }));
    assert.ok(placed.length >= 2);
    for (const a of placed) {
      assert.ok(a.box.x0 >= 4 && a.box.x1 <= 796 && a.box.y0 >= 4 && a.box.y1 <= 496);
      for (const b of placed) if (a !== b) assert.equal(overlap(a.box, b.box), false, `${a.id} 与 ${b.id} 重叠`);
      for (const body of targets) {
        const nx = Math.min(Math.max(body.x, a.box.x0), a.box.x1);
        const ny = Math.min(Math.max(body.y, a.box.y0), a.box.y1);
        assert.ok((body.x - nx) ** 2 + (body.y - ny) ** 2 >= lockFrame(body.r).half ** 2, `${a.id} 的标签压住 ${body.id}`);
      }
      const nx = Math.min(Math.max(star.x, a.box.x0), a.box.x1);
      const ny = Math.min(Math.max(star.y, a.box.y0), a.box.y1);
      assert.ok((star.x - nx) ** 2 + (star.y - ny) ** 2 >= (star.r + 2) ** 2);
    }
  });

  test("贴着右上角的行星：右上放不下就换到左下等别的方位，不出画布", () => {
    const placed = placeCallouts(input([target("edge", 790, 12)]));
    assert.equal(placed.length, 1);
    assert.equal(placed[0]?.dir, "sw");
  });

  test("哪个方位都放不下就跳过它（只留锁定框），不挤占后面的", () => {
    const placed = placeCallouts(input([target("big", 40, 40, { text: "一个非常非常非常非常非常非常非常长的名字", rank: 0 }), target("ok", 400, 250, { rank: 1 })], { width: 120, height: 120 }));
    assert.deepEqual(placed.map((p) => p.id), []);
    const wide = placeCallouts(input([target("big", 40, 40, { text: "一个非常非常非常非常非常非常非常长的名字", rank: 0 }), target("ok", 400, 250, { rank: 1 })]));
    assert.ok(wide.some((p) => p.id === "ok"));
  });

  test("滞回：上一帧的方位这一帧还放得下就沿用，即使默认次序里别的方位排在前面", () => {
    const t = target("a", 400, 250);
    const first = placeCallouts(input([t]));
    assert.equal(first[0]?.dir, "ne");
    const kept = placeCallouts(input([{ ...t, x: 402, y: 251 }], { previous: new Map([["a", { dir: "sw", lift: 1 }]]) }));
    assert.equal(kept[0]?.dir, "sw");
    assert.equal(kept[0]?.lift, 1);
  });

  test("随行星移动：同一颗换了位置，引线起点跟着换（每帧按当时的位置算）", () => {
    const a = placeCallouts(input([target("a", 300, 250)]))[0];
    const b = placeCallouts(input([target("a", 340, 230)]))[0];
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(b.start.x - a.start.x, 40);
    assert.equal(b.start.y - a.start.y, -20);
  });

  test("预算随画布宽度：窄的右栏 2 根、宽的页面 5 根", () => {
    assert.equal(calloutBudget(300), 2);
    assert.equal(calloutBudget(400), 3);
    assert.equal(calloutBudget(700), 4);
    assert.equal(calloutBudget(1200), 5);
  });
});
