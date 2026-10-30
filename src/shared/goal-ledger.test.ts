import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalLedger, headLine, headSnippet, renderLedgerForModel, snippetPair, type LedgerEvent } from "./goal-ledger.ts";

let seq = 0;
const user = (text: string, at: number): LedgerEvent => ({ kind: "user", id: `u${++seq}`, at, text });
const goal = (g: string, at: number, extra: Record<string, unknown> = {}, failed = false): LedgerEvent => ({
  kind: "call",
  id: `g${++seq}`,
  at,
  tool: "update_goal",
  input: { goal: g, ...extra },
  failed,
});
const plan = (steps: [string, "pending" | "in_progress" | "done"][], at: number, extra: Record<string, unknown> = {}): LedgerEvent => ({
  kind: "call",
  id: `p${++seq}`,
  at,
  tool: "update_plan",
  input: { items: steps.map(([text, status]) => ({ text, status })), ...extra },
  failed: false,
});

describe("buildGoalLedger：目标", () => {
  test("第一次定目标：from = null，来源是最近一条用户消息（时间 + 头一行）", () => {
    const ledger = buildGoalLedger([user("帮我把待办模块做完\n细节见 README", 100), goal("把待办模块做完", 110)]);
    assert.deepEqual(ledger.goal, { text: "把待办模块做完", at: 110 });
    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0];
    assert.equal(entry?.kind, "goal");
    if (entry?.kind !== "goal") return;
    assert.equal(entry.from, null);
    assert.deepEqual(entry.source, { kind: "user", id: "u1", at: 100, head: "帮我把待办模块做完" });
  });

  test("用户改了说法：记 从什么 → 什么 + why + 触发的那条用户消息", () => {
    const ledger = buildGoalLedger([
      user("做排序", 100),
      goal("做排序", 110),
      user("不对，还要按到期日筛选", 200),
      goal("做排序，再做按到期日筛选", 210, { why: "用户补充了筛选" }),
    ]);
    assert.equal(ledger.goal?.text, "做排序，再做按到期日筛选");
    const last = ledger.entries.at(-1);
    assert.equal(last?.kind, "goal");
    if (last?.kind !== "goal") return;
    assert.equal(last.from, "做排序");
    assert.equal(last.why, "用户补充了筛选");
    assert.equal(last.source.kind === "user" ? last.source.head : null, "不对，还要按到期日筛选");
  });

  test("agent 自己发现（by: self）：来源是 self，不挂用户消息", () => {
    const ledger = buildGoalLedger([user("修 bug", 100), goal("修 bug", 110), goal("修 bug 并补回归测试", 150, { by: "self", why: "发现没有测试" })]);
    const last = ledger.entries.at(-1);
    assert.deepEqual(last?.source, { kind: "self" });
  });

  test("没有任何用户消息就定目标：来源 self", () => {
    assert.deepEqual(buildGoalLedger([goal("x", 1)]).entries[0]?.source, { kind: "self" });
  });

  test("重复发同一个目标不入账；被拒的调用不入账；坏入参跳过", () => {
    const ledger = buildGoalLedger([user("a", 1), goal("目标", 2), goal("目标", 3), goal("别的", 4, {}, true), goal("", 5)]);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.goal?.text, "目标");
  });

  test("没有任何事件：空账", () => {
    assert.deepEqual(buildGoalLedger([]), { goal: null, entries: [], todos: { done: [], open: [] } });
  });
});

describe("buildGoalLedger：计划改动", () => {
  test("第一次写计划不是改动；只打勾不入账", () => {
    const ledger = buildGoalLedger([
      user("开工", 1),
      plan([["读代码", "in_progress"], ["改代码", "pending"]], 2),
      plan([["读代码", "done"], ["改代码", "in_progress"]], 3),
    ]);
    assert.equal(ledger.entries.length, 0);
  });

  test("用户消息之后的第一次改动算用户触发；同一轮再改是 agent 自己发现", () => {
    const ledger = buildGoalLedger([
      user("开工", 1),
      plan([["读代码", "in_progress"], ["改代码", "pending"]], 2),
      user("再加个 README", 10),
      plan([["读代码", "done"], ["改代码", "in_progress"], ["写 README", "pending"]], 11, { why: "用户要 README" }),
      plan([["读代码", "done"], ["改代码", "done"], ["修时区比较", "in_progress"], ["写 README", "pending"]], 20, { why: "测试发现时区问题" }),
    ]);
    assert.equal(ledger.entries.length, 2);
    const [first, second] = ledger.entries;
    assert.equal(first?.kind, "plan");
    assert.equal(first?.source.kind, "user");
    assert.deepEqual(first?.kind === "plan" ? first.changes : null, [{ kind: "added", text: "写 README" }]);
    assert.equal(first?.kind === "plan" ? first.why : null, "用户要 README");
    assert.deepEqual(second?.source, { kind: "self" });
    assert.equal(second?.kind === "plan" ? second.why : null, "测试发现时区问题");
  });

  test("下一条用户消息重新算『第一次』", () => {
    const ledger = buildGoalLedger([
      user("a", 1),
      plan([["读代码", "in_progress"], ["改代码", "pending"]], 2),
      user("b", 3),
      plan([["读代码", "done"], ["改代码", "in_progress"]], 4),
      plan([["读代码", "done"], ["改代码", "in_progress"], ["补测试", "pending"]], 5),
      user("c", 6),
      plan([["读代码", "done"], ["改代码", "in_progress"], ["补测试", "pending"], ["写文档", "pending"]], 7),
    ]);
    // b 那一轮的第一次是只打勾（占掉了『第一次』），所以 5 号的加步是 agent 自己发现；c 轮第一次改动算用户的
    assert.deepEqual(ledger.entries.map((entry) => entry.source.kind), ["self", "user"]);
  });

  test("换了一张新计划（一步都对不上）：记 replaced，不逐条报", () => {
    const ledger = buildGoalLedger([
      user("a", 1),
      plan([["读代码", "in_progress"], ["改代码", "pending"]], 2),
      user("换个方向：重写 CLI", 3),
      plan([["设计命令行参数", "in_progress"], ["实现解析器", "pending"]], 4, { why: "用户换了方向" }),
    ]);
    const entry = ledger.entries[0];
    assert.equal(entry?.kind, "plan");
    if (entry?.kind !== "plan") return;
    assert.deepEqual(entry.replaced, ["设计命令行参数", "实现解析器"]);
    assert.deepEqual(entry.changes, []);
  });
});

describe("buildGoalLedger：todo 累计", () => {
  test("做完的跨计划累计去重；没做完的只看当前计划", () => {
    const ledger = buildGoalLedger([
      user("a", 1),
      plan([["读代码", "done"], ["改代码", "in_progress"]], 2),
      user("换个方向", 3),
      plan([["设计参数", "done"], ["实现解析器", "in_progress"], ["写测试", "pending"]], 4),
    ]);
    assert.deepEqual(ledger.todos.done, ["读代码", "设计参数"]);
    assert.deepEqual(ledger.todos.open, ["实现解析器", "写测试"]);
  });

  test("先做完后来被去掉的步仍算做完过的", () => {
    const ledger = buildGoalLedger([
      user("a", 1),
      plan([["读代码", "done"], ["改代码", "in_progress"], ["写文档", "pending"]], 2),
      plan([["读代码", "done"], ["改代码", "in_progress"]], 3, { why: "不要文档了" }),
    ]);
    assert.deepEqual(ledger.todos.done, ["读代码"]);
    assert.deepEqual(ledger.todos.open, ["改代码"]);
  });
});

describe("headLine", () => {
  test("取头一行非空行、超长截断", () => {
    assert.equal(headLine("\n\n  第一行  \n第二行"), "第一行");
    assert.equal(headLine("x".repeat(100)).length, 60);
    assert.equal(headLine(""), "");
  });
});

describe("renderLedgerForModel：压缩后附在摘要后面的固定段", () => {
  test("空账 = null（不附）", () => {
    assert.equal(renderLedgerForModel(buildGoalLedger([])), null);
  });

  test("目标原样、改动带 从→到 / why / 来源，todo 分做完与未完", () => {
    const at = new Date(2026, 9, 30, 14, 5).getTime();
    const ledger = buildGoalLedger([
      user("把待办模块做完", at),
      goal("把待办模块做完", at + 1000),
      user("还要按到期日筛选", at + 60_000),
      goal("把待办模块做完，含按到期日筛选", at + 61_000, { why: "用户补充了筛选" }),
      plan([["读代码", "done"], ["写筛选", "in_progress"]], at + 62_000),
    ]);
    const text = renderLedgerForModel(ledger) ?? "";
    assert.match(text, /Current goal: "把待办模块做完，含按到期日筛选"/);
    assert.match(text, /"把待办模块做完" → "把待办模块做完，含按到期日筛选" because 用户补充了筛选 \(user message 2026-10-30 14:06 "还要按到期日筛选"\)/);
    assert.match(text, /set "把待办模块做完"/);
    assert.match(text, /Todos done: "读代码"/);
    assert.match(text, /Todos still open: "写筛选"/);
  });

  test("同一份账渲染两次逐字节相同（压缩后每轮重放，不能抖）", () => {
    const events = [user("a", 1000), goal("g", 2000), plan([["x", "in_progress"], ["y", "pending"]], 3000)];
    assert.equal(renderLedgerForModel(buildGoalLedger(events)), renderLedgerForModel(buildGoalLedger(events)));
  });

  test("改动要点里的目标文字过长只留开头（当前目标另行全文）", () => {
    const long = "很长的目标".repeat(60);
    const text = renderLedgerForModel(buildGoalLedger([user("a", 1), goal(long, 2), goal(`${long}再加一句`, 3)])) ?? "";
    assert.ok(text.includes(`Current goal: "${long}再加一句"`), "当前目标全文");
    const changes = text.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(changes.every((line) => line.length < 400), "历史行不随目标长度膨胀");
    assert.ok(changes.some((line) => line.includes("…")));
  });

  test("改动很多时只留最近若干条", () => {
    const events: LedgerEvent[] = [user("a", 1)];
    for (let i = 0; i < 20; i++) events.push(goal(`目标版本${i}`, 10 + i));
    const text = renderLedgerForModel(buildGoalLedger(events)) ?? "";
    assert.ok(!text.includes("目标版本1\""), "较早的改动被截掉");
    assert.ok(text.includes("目标版本19"));
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 8);
  });
});

describe("snippetPair（长目标「从 A 改成 B」只留不同处）", () => {
  test("两段都不长：原样", () => {
    assert.deepEqual(snippetPair("做排序", "做排序和筛选"), ["做排序", "做排序和筛选"]);
  });

  test("末尾追加一句（公共开头很长）：两边都从不同处附近开始，改动看得见", () => {
    const base = "把待办模块做成能用的小工具：".repeat(10);
    const [from, to] = snippetPair(base, `${base}最后还要有命令行入口 cli.js。`);
    assert.notEqual(from, to);
    assert.ok(from.startsWith("…") && to.startsWith("…"));
    assert.ok(to.endsWith("最后还要有命令行入口 cli.js。"), "新增的那句在里面");
    assert.ok([...to].length <= 120 && [...from].length <= 120);
  });

  test("中间改了一处：保留不同处前后的上下文，两头用省略号", () => {
    const head = "前文".repeat(60);
    const tail = "后文".repeat(60);
    const [from, to] = snippetPair(`${head}README 要写${tail}`, `${head}改成 exportCsv${tail}`);
    assert.ok(from.includes("README 要写") && to.includes("改成 exportCsv"));
    assert.ok(from.startsWith("…") && from.endsWith("…"));
    assert.ok(to.startsWith("…") && to.endsWith("…"));
  });

  test("第一次定目标只留开头（不是不同处——没有可比的上一版）", () => {
    assert.equal(headSnippet("短目标"), "短目标");
    const out = headSnippet("开头".repeat(100));
    assert.equal([...out].length, 120);
    assert.ok(out.startsWith("开头开头") && out.endsWith("…"));
  });

  test("完全不同的两段长文字：各自截到上限，不炸", () => {
    const [from, to] = snippetPair("甲".repeat(300), "乙".repeat(300));
    assert.equal([...from].length, 120);
    assert.equal([...to].length, 120);
  });
});
