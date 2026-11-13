import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assignStepIds, dice, diffPlans } from "./plan-diff.ts";
import type { PlanItem } from "./plan.ts";

const plan = (...texts: string[]): PlanItem[] => texts.map((text) => ({ text, status: "pending" }));
const withStatus = (items: PlanItem[], ...statuses: PlanItem["status"][]): PlanItem[] =>
  items.map((item, i) => ({ ...item, status: statuses[i] ?? item.status }));

describe("diffPlans：waiting 与「先做这一步」的跳步", () => {
  const four = plan("装好 skill", "每日一篇", "DDPM 立场表", "旧计划检验");

  test("用户让先做第 3 步：它提到前面，说成「提到…前面」；被让位的那步不被算成被挪", () => {
    const a = withStatus(four, "done", "in_progress", "pending", "pending");
    const b: PlanItem[] = [
      { text: "装好 skill", status: "done" },
      { text: "DDPM 立场表", status: "in_progress" },
      { text: "每日一篇", status: "waiting", waitingFor: "等你改权限" },
      { text: "旧计划检验", status: "pending" },
    ];
    const diff = diffPlans(a, b);
    assert.deepEqual(diff.changes, [{ kind: "moved", text: "DDPM 立场表", before: "每日一篇", earlier: true }]);
    assert.deepEqual(diff.waits, [{ text: "每日一篇", waitingFor: "等你改权限" }]);
    assert.equal(diff.fresh, false);
  });

  test("同样的对调，被挪的是哪一步看谁在做：在做的优先算被挪（不是反过来）", () => {
    const a = plan("甲", "乙", "丙");
    const b: PlanItem[] = [
      { text: "甲", status: "pending" },
      { text: "丙", status: "pending" },
      { text: "乙", status: "in_progress" },
    ];
    // 乙在做：乙是被挪的（往后），而不是丙被挪
    assert.deepEqual(diffPlans(a, b).changes, [{ kind: "moved", text: "乙", before: null, earlier: false }]);
    const c: PlanItem[] = [
      { text: "甲", status: "pending" },
      { text: "丙", status: "in_progress" },
      { text: "乙", status: "pending" },
    ];
    assert.deepEqual(diffPlans(a, c).changes, [{ kind: "moved", text: "丙", before: "乙", earlier: true }]);
  });

  test("waits：只记「新变成 waiting」的步；已经是 waiting、新加的 waiting 步、waitingFor 改了都不记；不进 changes", () => {
    const a: PlanItem[] = [
      { text: "甲", status: "in_progress" },
      { text: "乙", status: "waiting", waitingFor: "等你" },
    ];
    const toWaiting = diffPlans(a, [
      { text: "甲", status: "waiting", waitingFor: "等外部构建" },
      { text: "乙", status: "waiting", waitingFor: "等你确认" },
    ]);
    assert.deepEqual(toWaiting.waits, [{ text: "甲", waitingFor: "等外部构建" }]);
    assert.deepEqual(toWaiting.changes, []);
    const added = diffPlans(a, [...a, { text: "丙", status: "waiting" }]);
    assert.deepEqual(added.waits, []);
    assert.deepEqual(added.changes, [{ kind: "added", text: "丙" }]);
    // waiting 没写 waitingFor：waitingFor 为 null
    assert.deepEqual(diffPlans(plan("x", "y"), [{ text: "x", status: "waiting" }, { text: "y", status: "pending" }]).waits, [
      { text: "x", waitingFor: null },
    ]);
  });

  test("没有旧计划 / 新计划：没有 waits", () => {
    assert.deepEqual(diffPlans(null, [{ text: "a", status: "waiting" }]).waits, []);
    assert.deepEqual(diffPlans(plan("a"), [{ text: "完全不同的另一件事", status: "waiting" }]).waits, []);
  });

  test("只是把一步在 pending / waiting 之间切换：不产生改动（只打勾口径不变）", () => {
    const diff = diffPlans(withStatus(four, "done", "pending", "in_progress", "pending"), withStatus(four, "done", "waiting", "in_progress", "pending"));
    assert.deepEqual(diff.changes, []);
  });
});

describe("diffPlans：只打勾不算改动", () => {
  test("文字不变、status 变 = 没有任何改动，配对一一对应", () => {
    const a = plan("看代码", "写函数", "补测试");
    const b = withStatus(a, "done", "in_progress", "pending");
    const diff = diffPlans(a, b);
    assert.deepEqual(diff.changes, []);
    assert.deepEqual(diff.pairs, [0, 1, 2]);
    assert.equal(diff.fresh, false);
  });

  test("没有旧计划：不是改动（第一次写下）", () => {
    const diff = diffPlans(null, plan("a", "b"));
    assert.deepEqual(diff.changes, []);
    assert.equal(diff.fresh, false);
  });
});

describe("diffPlans：加 / 去 / 改说法 / 调顺序", () => {
  test("中间加了一步，后面的步不因重新编号而被误判", () => {
    const diff = diffPlans(plan("看代码", "写函数", "补测试"), plan("看代码", "写函数", "修时区比较", "补测试"));
    assert.deepEqual(diff.changes, [{ kind: "added", text: "修时区比较" }]);
    assert.deepEqual(diff.pairs, [0, 1, null, 2]);
  });

  test("去掉一步：记原位置，排在 changes 最后", () => {
    const diff = diffPlans(plan("看代码", "写函数", "写 README"), plan("看代码", "写 README"));
    assert.deepEqual(diff.changes, [{ kind: "removed", text: "写函数" }]);
    assert.deepEqual(diff.removed, [{ text: "写函数", afterNext: 0 }]);
  });

  test("去掉的是第一步：afterNext = -1", () => {
    const diff = diffPlans(plan("甲", "乙丙", "丁戊"), plan("乙丙", "丁戊"));
    assert.deepEqual(diff.removed, [{ text: "甲", afterNext: -1 }]);
  });

  test("改说法：相似度够就算同一步，带出处", () => {
    const diff = diffPlans(plan("看 todo.js 和现有测试", "加排序函数"), plan("看 todo.js 和已有测试", "加排序函数"));
    assert.deepEqual(diff.changes, [{ kind: "reworded", from: "看 todo.js 和现有测试", to: "看 todo.js 和已有测试" }]);
    assert.deepEqual(diff.origins.get(0), { kind: "reworded", from: "看 todo.js 和现有测试" });
    assert.deepEqual(diff.pairs, [0, 1]);
  });

  test("完全不像的一换一：是去掉 + 加了，不是改说法", () => {
    const diff = diffPlans(plan("甲", "清理缓存目录"), plan("甲", "部署到测试环境"));
    assert.deepEqual(diff.changes.map((c) => c.kind), ["added", "removed"]);
  });

  test("调顺序：只报被挪的那一步，挪到哪一步前面", () => {
    const diff = diffPlans(plan("甲步骤", "乙步骤", "丙步骤"), plan("甲步骤", "丙步骤", "乙步骤"));
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0]?.kind, "moved");
  });

  test("一步都对不上 = 一张新计划（fresh），不逐条报", () => {
    const diff = diffPlans(plan("给 CI 加缓存", "改 workflow"), plan("调研向量库", "写对比表"));
    assert.equal(diff.fresh, true);
    assert.deepEqual(diff.changes, []);
    assert.deepEqual(diff.pairs, [null, null]);
  });
});

describe("diffPlans：拆与合", () => {
  test("一步拆成两步", () => {
    const diff = diffPlans(plan("看代码", "写测试并跑通", "写 README"), plan("看代码", "写测试", "跑通测试", "写 README"));
    assert.deepEqual(diff.changes, [{ kind: "split", from: "写测试并跑通", into: ["写测试", "跑通测试"] }]);
    assert.deepEqual(diff.origins.get(1), { kind: "split", from: "写测试并跑通" });
    assert.deepEqual(diff.origins.get(2), { kind: "split", from: "写测试并跑通" });
  });

  test("两步合成一步", () => {
    const diff = diffPlans(plan("看代码", "写测试", "跑通测试", "写 README"), plan("看代码", "写测试并跑通", "写 README"));
    assert.deepEqual(diff.changes, [{ kind: "merged", from: ["写测试", "跑通测试"], into: "写测试并跑通" }]);
    assert.deepEqual(diff.removed, []);
  });
});

describe("assignStepIds", () => {
  test("配上的沿用旧 id，新出现的取新 id，重新编号不影响", () => {
    let n = 0;
    const mint = () => `n${++n}`;
    const first = plan("看代码", "写函数", "补测试");
    const ids1 = assignStepIds(null, diffPlans(null, first), mint);
    assert.deepEqual(ids1, ["n1", "n2", "n3"]);
    const second = plan("看代码", "修时区比较", "写函数", "补测试");
    const ids2 = assignStepIds(ids1, diffPlans(first, second), mint);
    assert.deepEqual(ids2, ["n1", "n4", "n2", "n3"]);
  });
});

describe("dice", () => {
  test("相同 = 1，无关 ≈ 0，标点空白不计，空串 = 0", () => {
    assert.equal(dice("写测试", "写测试"), 1);
    assert.equal(dice("写 测试!", "写测试"), 1);
    assert.ok(dice("清理缓存", "部署环境") < 0.2);
    assert.equal(dice("", "a"), 0);
  });
});
