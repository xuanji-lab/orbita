import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalLedger, type LedgerEvent } from "../../../../shared/goal-ledger.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { buildGoalSeed, SEED_MAX_CHANGES, SEED_MAX_LIST } from "./goal-seed.ts";

const at = new Date(2026, 9, 30, 14, 30).getTime();
const user = (id: string, ms: number, text: string): LedgerEvent => ({ kind: "user", id, at: at + ms, text });
const goal = (id: string, ms: number, g: string, extra: Record<string, unknown> = {}): LedgerEvent => ({
  kind: "call", id, at: at + ms, tool: "update_goal", input: { goal: g, ...extra }, failed: false,
});
const plan = (id: string, ms: number, steps: [string, string][], extra: Record<string, unknown> = {}): LedgerEvent => ({
  kind: "call", id, at: at + ms, tool: "update_plan", input: { items: steps.map(([text, status]) => ({ text, status })), ...extra }, failed: false,
});

const events: LedgerEvent[] = [
  user("u1", 0, "帮我把待办模块做完"),
  goal("g1", 1000, "把待办模块做完"),
  plan("p1", 2000, [["读代码", "done"], ["写排序", "in_progress"], ["写 README", "pending"]]),
  user("u2", 60_000, "还要按到期日筛选"),
  goal("g2", 61_000, "把待办模块做完，含按到期日筛选", { why: "用户补充了筛选" }),
];

describe("buildGoalSeed（带着目标开新会话的种子）", () => {
  test("带目标原文、做完的 / 没做完的 todo、开着的以后再做、改动要点（中文）", () => {
    const seed = buildGoalSeed(zh, {
      sourceTitle: "待办模块",
      ledger: buildGoalLedger(events),
      later: [{ title: "nextId 是模块级可变量", detail: "不影响本次" }, { title: "addTask 不校验 priority", detail: "" }],
    });
    assert.ok(seed !== null);
    assert.match(seed, /^接着做任务「待办模块」的目标。/);
    assert.match(seed, /目标：把待办模块做完，含按到期日筛选/);
    assert.match(seed, /已经做完的：\n- 读代码/);
    assert.match(seed, /还没做完的：\n- 写排序\n- 写 README/);
    assert.match(seed, /- nextId 是模块级可变量（不影响本次）\n- addTask 不校验 priority/);
    // 改动账要点：从什么变成什么、why、来源（用户哪句话）
    assert.match(seed, /目标「把待办模块做完」改成「把待办模块做完，含按到期日筛选」——用户补充了筛选（你 10-30 14:31 说：「还要按到期日筛选」）/);
    assert.match(seed, /请把上面的目标记成这个会话的目标（update_goal，保留我的原话）/);
  });

  test("英文：用英文文案，同样的结构", () => {
    const seed = buildGoalSeed(en, { sourceTitle: null, ledger: buildGoalLedger(events), later: [] });
    assert.ok(seed !== null);
    assert.match(seed, /the task has been deleted/);
    assert.match(seed, /Goal：|Goal: /);
    assert.match(seed, /Done so far/);
    assert.match(seed, /goal "把待办模块做完" → "把待办模块做完，含按到期日筛选" — 用户补充了筛选/);
  });

  test("没有目标 = null；没有以后再做 / 改动时不写那一段", () => {
    assert.equal(buildGoalSeed(zh, { sourceTitle: "x", ledger: buildGoalLedger([user("u", 0, "hi")]), later: [] }), null);
    const seed = buildGoalSeed(zh, { sourceTitle: "x", ledger: buildGoalLedger([user("u", 0, "a"), goal("g", 1, "只有目标")]), later: [] });
    assert.ok(seed !== null);
    assert.doesNotMatch(seed, /已经做完的|还没做完的|以后再做|怎么改过来的\n/);
    assert.match(seed, /目标：只有目标/);
    // 第一次定目标也是一条改动要点
    assert.match(seed, /定下目标：「只有目标」/);
  });

  test("条数上限：每段最多 12 条、改动要点最近 6 条", () => {
    const many: LedgerEvent[] = [user("u", 0, "a"), plan("p0", 1, Array.from({ length: 12 }, (_, i) => [`步骤${i}`, "done"] as [string, string]))];
    for (let i = 0; i < 10; i++) many.push(goal(`g${i}`, 10 + i, `目标${i}`));
    const later = Array.from({ length: 20 }, (_, i) => ({ title: `以后${i}`, detail: "" }));
    const seed = buildGoalSeed(zh, { sourceTitle: "x", ledger: buildGoalLedger(many), later }) ?? "";
    assert.equal(seed.split("\n").filter((line) => line.startsWith("- 以后")).length, SEED_MAX_LIST);
    assert.equal(seed.split("\n").filter((line) => /^- .*\d\d-\d\d \d\d:\d\d|^- \d\d-\d\d/.test(line)).length, SEED_MAX_CHANGES);
    assert.doesNotMatch(seed, /目标「目标0」/);
    assert.match(seed, /目标9/);
  });
});
