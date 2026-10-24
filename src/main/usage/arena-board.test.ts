import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { boardEntriesFor, boardIndexOf, type BoardRow } from "./arena-board.ts";
import snapshot from "./arena-snapshot.json" with { type: "json" };

const row = (name: string, score: number, rank: number): BoardRow => [name, score, score - 5, score + 5, 1000, rank];

const D = "2026-10-23";
const one = (name: string, modelId: string) => boardEntriesFor([row(name, 1500, 1)], modelId, D)[0];

describe("榜单名解析：括号里的档 / harness / 日期", () => {
  test("末尾括号的档映射到 Orbita 的档", () => {
    assert.equal(one("Claude Opus 5.5 (Max)", "claude-opus-5-5")?.thinking, "max");
    assert.equal(one("Claude Sonnet 5.5 (xHigh)", "claude-sonnet-5-5")?.thinking, "xhigh");
    assert.equal(one("GPT-6 Luna (Low)", "gpt-6-luna")?.thinking, "low");
    assert.equal(one("GPT-6 Luna (Medium)", "gpt-6-luna")?.thinking, "medium");
  });

  test("没括号 = 榜单没标档：null，不猜", () => {
    assert.equal(one("GLM-5.3-Flash", "glm-5.3-flash")?.thinking, null);
  });

  test("harness 记下来；括号里与名字里的日期都剥掉，基名照样对上", () => {
    const sol = one("GPT-5.6 Sol (xHigh, Codex Harness)", "gpt-5.6-sol");
    assert.equal(sol?.thinking, "xhigh");
    assert.equal(sol?.harness, "Codex Harness");
    assert.equal(one("DeepSeek-V4-Pro (High, 20260813)", "deepseek-v4-pro")?.thinking, "high");
    assert.equal(one("Qwen3.8-Max (0902)", "qwen3.8-max")?.thinking, null);
    assert.equal(one("DeepSeek-V4.1-Flash-20261017 (Max)", "deepseek-v4.1-flash")?.thinking, "max");
  });

  test("认不得的限定词不映射", () => {
    assert.equal(one("Kimi K3 (Thinking)", "kimi-k3"), undefined);
  });
});

describe("Orbita id → 榜单基名", () => {
  test("各家写法的别名共用一份分数", () => {
    for (const id of ["k3", "kimi-k3", "k3-256k"]) assert.equal(one("Kimi K3 (Max)", id)?.name, "Kimi K3 (Max)", id);
    assert.equal(one("Kimi K3.1 Pro (Max)", "k3.1-pro-highspeed")?.thinking, "max");
    assert.equal(one("DeepSeek-V4.1-Flash-20261017 (Max)", "deepseek-flash")?.thinking, "max");
  });

  test("聚合网关的前缀写法取最后一段", () => {
    assert.equal(one("GLM-5.3 (Max)", "z-ai/glm-5.3")?.thinking, "max");
  });

  test("kimi-for-coding（K2.8 Preview）不被 K2.7 Code 顶替；不认识的 id 查不到；基名不做前缀匹配", () => {
    assert.equal(one("Kimi K2.7 Code", "kimi-for-coding"), undefined);
    assert.equal(one("Kimi K3 (Max)", "my-private-model"), undefined);
    assert.equal(one("Kimi K3.1 Pro (Max)", "kimi-k3"), undefined);
  });
});

describe("boardEntriesFor：同 id × 同档只留一条", () => {
  test("多档各留一条（GPT-6 Luna 三档是三个点），按名次排", () => {
    const rows = [row("GPT-6 Luna (Max)", 0.03, 17), row("GPT-6 Luna (Low)", -0.05, 36), row("GPT-6 Luna (Medium)", 0.01, 20)];
    assert.deepEqual(
      boardEntriesFor(rows, "gpt-6-luna", "2026-10-23").map((e) => e.thinking),
      ["max", "medium", "low"],
    );
  });

  test("都带日期：取最新的日期版本，其余丢掉", () => {
    const rows = [row("DeepSeek-V4.1-Flash-20260910 (Max)", 1618, 27), row("DeepSeek-V4.1-Flash-20261017 (Max)", 1664, 14)];
    const entries = boardEntriesFor(rows, "deepseek-v4.1-flash", "2026-10-23");
    assert.deepEqual(entries.map((e) => e.name), ["DeepSeek-V4.1-Flash-20261017 (Max)"]);
  });

  test("带日期与不带日期并存：不带日期的当作当前别名（推断）", () => {
    const rows = [row("Qwen3.8-Max (0902)", 1673, 12), row("Qwen3.8-Max", 1672, 13)];
    assert.deepEqual(boardEntriesFor(rows, "qwen3.8-max", "2026-10-23").map((e) => e.name), ["Qwen3.8-Max"]);
  });

  test("同一个 id 只要有标了档的条目，就丢掉没标档的那条（deepseek-v4-pro 只留 High）", () => {
    const rows = [row("DeepSeek-V4-Pro (High, 20260813)", 1582, 37), row("DeepSeek-V4-Pro", 1447, 77)];
    assert.deepEqual(boardEntriesFor(rows, "deepseek-v4-pro", "2026-10-23").map((e) => e.name), [
      "DeepSeek-V4-Pro (High, 20260813)",
    ]);
  });

  test("都没标档才保留未标档的那条", () => {
    const rows = [row("GLM-5.3-Flash", 1475, 35), row("GLM-5.3 (Max)", 1480, 26)];
    assert.deepEqual(boardEntriesFor(rows, "glm-5.3-flash", "2026-10-23").map((e) => e.thinking), [null]);
  });

  test("真实快照：deepseek-v4-pro 在六类里都只剩标了档的条目", () => {
    for (const [category, board] of Object.entries(snapshot.categories)) {
      const entries = boardEntriesFor(board.rows as BoardRow[], "deepseek-v4-pro", board.publishDate);
      assert.ok(entries.length > 0, category);
      assert.ok(entries.every((e) => e.thinking !== null), category);
    }
  });

  test("同档里带 harness 与不带的并存取不带的；只有 harness 那条就照收并带上 harness", () => {
    const both = [row("GPT-5.6 Sol (xHigh, Codex Harness)", 1615, 29), row("GPT-5.6 Sol (xHigh)", 1600, 30)];
    assert.deepEqual(boardEntriesFor(both, "gpt-5.6-sol", "2026-10-23").map((e) => e.name), ["GPT-5.6 Sol (xHigh)"]);
    const only = boardEntriesFor([both[0] as BoardRow], "gpt-5.6-sol", "2026-10-23");
    assert.equal(only[0]?.harness, "Codex Harness");
  });

  test("不在榜上 / 不认识的 id：空", () => {
    assert.deepEqual(boardEntriesFor([row("Kimi K2.7 Code", 1473, 71)], "kimi-for-coding", "2026-10-23"), []);
  });
});

describe("随应用分发的快照", () => {
  test("六类齐全，出处带 revision 与 CC-BY-4.0 署名", () => {
    assert.deepEqual(Object.keys(snapshot.categories).sort(), [
      "agent",
      "coding",
      "instruction_following",
      "math",
      "overall",
      "webdev",
    ]);
    assert.equal(snapshot.license, "CC-BY-4.0");
    assert.match(snapshot.revision, /^[0-9a-f]{40}$/);
    assert.match(snapshot.attribution, /Arena/);
    assert.equal(snapshot.categories.agent.unit, "net-improvement");
  });

  test("真实快照里 Kimi K3.1 Pro 只在 WebDev 上（其余五类应列为未上榜）", () => {
    for (const [category, board] of Object.entries(snapshot.categories)) {
      const rows = board.rows as BoardRow[];
      const hit = boardEntriesFor(rows, "kimi-k3.1-pro", board.publishDate).length > 0;
      assert.equal(hit, category === "webdev", category);
    }
  });
});

describe("手写表查不到时：规范化后精确相等的兜底", () => {
  const withIndex = (rows: BoardRow[], modelId: string) => boardEntriesFor(rows, modelId, D, boardIndexOf([rows]));

  test("新服务商带进来的 id：Grok 4.7 → grok-4.7（空格换连字符、转小写，整串相等）", () => {
    const rows = [row("Grok 4.7 (xHigh)", 0.05, 6), row("Grok 4.6 (xHigh)", 0.02, 12)];
    assert.deepEqual(withIndex(rows, "grok-4.7").map((e) => e.name), ["Grok 4.7 (xHigh)"]);
    assert.deepEqual(withIndex(rows, "xai/grok-4.7").map((e) => e.thinking), ["xhigh"]);
  });

  test("不做前缀 / 包含匹配：claude-opus-5-5 配不到 Claude Opus 5，gpt-6-luna 配不到 GPT-6.1 Sol", () => {
    assert.deepEqual(withIndex([row("Claude Opus 5 (Max)", 1490, 13)], "claude-opus-5-5"), []);
    assert.deepEqual(withIndex([row("GPT-6.1 Sol (Max)", 1480, 27)], "gpt-6-luna"), []);
    assert.deepEqual(withIndex([row("Grok 4.7 (xHigh)", 0.05, 6)], "grok-4"), []);
    assert.deepEqual(withIndex([row("Grok 4 (0709)", 1400, 90)], "grok-4.7"), []);
  });

  test("没给 index 就不兜底（只走手写表）", () => {
    assert.deepEqual(boardEntriesFor([row("Grok 4.7 (xHigh)", 0.05, 6)], "grok-4.7", D), []);
  });

  test("真实快照：grok-4.7 在六类里都出点（文字榜与 WebDev 上也有 Grok 4.7 (xHigh)）", () => {
    const index = boardIndexOf(Object.values(snapshot.categories).map((c) => c.rows as BoardRow[]));
    for (const [category, board] of Object.entries(snapshot.categories)) {
      const entries = boardEntriesFor(board.rows as BoardRow[], "grok-4.7", board.publishDate, index);
      assert.deepEqual(entries.map((e) => e.name), ["Grok 4.7 (xHigh)"], category);
    }
  });
});
