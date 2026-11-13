/**
 * 上下文面板显示口径：分组汇总（空组不出、gone 不计量）、规则组拆解、用量条
 * （其余 = 真实 − 估算、估算超额按比例压、总量未知不编数）。
 */
import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextFileRow, ContextInventory, ContextRulesGroup } from "../../../../shared/context-inventory.ts";
import { contextBar, groupSummaries, rulesBreakdown, shortOutsideDir } from "./context-panel-view.ts";

function inventory(patch: Partial<ContextInventory> = {}): ContextInventory {
  return {
    scope: "task",
    currentTurn: 3,
    compactions: 0,
    rules: null,
    attach: { rows: [], tokens: 0 },
    files: { dirs: [], searches: [], tokens: 0 },
    web: { rows: [], tokens: 0 },
    tasks: { rows: [], tokens: 0 },
    mcp: { rows: [], tokens: 0 },
    skills: { rows: [], tokens: 0 },
    ...patch,
  };
}

const RULES: ContextRulesGroup = {
  files: [
    { path: "/home/u/.pi/AGENTS.md", name: "AGENTS.md", scope: "global", tokens: 500 },
    { path: "/repo/AGENTS.md", name: "AGENTS.md", scope: "project", tokens: 2000 },
  ],
  baseTokens: 4000,
  skillsIndex: { names: ["a", "b"], tokens: 300 },
  segments: [
    { id: "permission", tokens: 200 },
    { id: "quote", tokens: 100 },
  ],
  tokens: 4300,
};

function fileRow(name: string, tokens: number, gone = false): ContextFileRow {
  return { turn: 1, gone, tokens, path: name, name, outside: false, ranges: [{ kind: "all" }] };
}

describe("shortOutsideDir", () => {
  it("只留最后两级；两级以内原样", () => {
    equal(shortOutsideDir("/Users/me/Documents/repo/Proma/apps/electron"), "…/apps/electron");
    equal(shortOutsideDir("/Users/me"), "/Users/me");
    equal(shortOutsideDir("C:/Users/me/proj"), "…/me/proj");
  });
});

describe("rulesBreakdown", () => {
  it("内置那一行 = base − 规则文件 − 技能索引 + 追加段（base 已含前两者，不加重）", () => {
    const out = rulesBreakdown(RULES);
    // 4000 − 2500 − 300 + 300
    equal(out.builtinTokens, 1500);
    equal(out.files.length, 2);
    ok(out.skillsIndex !== null);
  });

  it("估算误差让差值为负时钉到 0；没有技能时不出技能索引行", () => {
    const out = rulesBreakdown({ ...RULES, baseTokens: 1000, skillsIndex: { names: [], tokens: 0 }, segments: [] });
    equal(out.builtinTokens, 0);
    strictEqual(out.skillsIndex, null);
  });
});

describe("groupSummaries", () => {
  it("空组整组不出；规则清单未知时没有规则组", () => {
    deepStrictEqual(groupSummaries(inventory()), []);
  });

  it("规则组行数 = 规则文件 + 技能索引 + 内置一行，量取组合计", () => {
    const [rules] = groupSummaries(inventory({ rules: RULES }));
    deepStrictEqual(rules, { key: "rules", count: 4, liveTokens: 4300, allGone: false });
  });

  it("文件组行数含搜索小计；已压缩出去的行不计量，全部压出才算 allGone", () => {
    const groups = groupSummaries(
      inventory({
        files: {
          dirs: [{ dir: ".", outside: false, rows: [fileRow("a.ts", 100), fileRow("b.ts", 50, true)], tokens: 150 }],
          searches: [{ tool: "grep", count: 2, turn: 1, gone: false, tokens: 30 }],
          tokens: 180,
        },
      }),
    );
    deepStrictEqual(groups, [{ key: "files", count: 3, liveTokens: 130, allGone: false }]);

    const allGone = groupSummaries(
      inventory({ files: { dirs: [{ dir: ".", outside: false, rows: [fileRow("a.ts", 100, true)], tokens: 100 }], searches: [], tokens: 100 } }),
    );
    deepStrictEqual(allGone, [{ key: "files", count: 1, liveTokens: 0, allGone: true }]);
  });

  it("组按固定顺序：规则 → 附带 → 文件 → 网页", () => {
    const keys = groupSummaries(
      inventory({
        rules: RULES,
        web: { rows: [{ turn: 1, gone: false, tokens: 10, url: "https://a.dev", title: null, domain: "a.dev" }], tokens: 10 },
        files: { dirs: [{ dir: ".", outside: false, rows: [fileRow("a.ts", 1)], tokens: 1 }], searches: [], tokens: 1 },
      }),
    ).map((group) => group.key);
    deepStrictEqual(keys, ["rules", "files", "web"]);
  });
});

describe("contextBar", () => {
  const groups = [
    { key: "rules" as const, count: 3, liveTokens: 4000, allGone: false },
    { key: "files" as const, count: 2, liveTokens: 6000, allGone: false },
  ];

  it("整条 = 已用总量（不是窗口）：其余 = 真实总量 − 各来源估算，段宽是构成占比", () => {
    const bar = contextBar(groups, { tokens: 20_000, contextWindow: 1_000_000, percent: 2 });
    ok(bar !== null);
    equal(bar.rest, 10_000);
    deepStrictEqual(
      bar.segments.map((segment) => [segment.key, segment.ratio]),
      [
        ["rules", 0.2],
        ["files", 0.3],
        ["rest", 0.5],
      ],
    );
    equal(bar.percent, 2);
  });

  it("估算之和超过真实总量：以估算之和为整条，不出其余段", () => {
    const bar = contextBar(groups, { tokens: 5_000, contextWindow: 100_000, percent: null });
    ok(bar !== null);
    equal(bar.rest, 0);
    deepStrictEqual(
      bar.segments.map((segment) => [segment.key, segment.ratio]),
      [
        ["rules", 0.4],
        ["files", 0.6],
      ],
    );
    equal(bar.percent, 5);
  });

  it("总量未知（压缩刚做完）：按各来源估算画，其余与百分比都是 null", () => {
    const bar = contextBar(groups, { tokens: null, contextWindow: 100_000, percent: null });
    ok(bar !== null);
    strictEqual(bar.rest, null);
    strictEqual(bar.percent, null);
    deepStrictEqual(
      bar.segments.map((segment) => [segment.key, segment.ratio]),
      [
        ["rules", 0.4],
        ["files", 0.6],
      ],
    );
  });

  it("占整条不到 0.5% 的来源不画段（免得条头一排细竖线），「其余」照算", () => {
    const bar = contextBar(
      [
        { key: "rules", count: 3, liveTokens: 100, allGone: false },
        { key: "web", count: 1, liveTokens: 10_000, allGone: false },
      ],
      { tokens: 50_000, contextWindow: 1_000_000, percent: 5 },
    );
    deepStrictEqual(
      bar?.segments.map((segment) => segment.key),
      ["web", "rest"],
    );
    equal(bar?.rest, 50_000 - 10_100);
  });

  it("pi 连窗口都不知道 = 不画条；量为 0 的组不出段", () => {
    strictEqual(contextBar(groups, null), null);
    const bar = contextBar([{ key: "web", count: 1, liveTokens: 0, allGone: true }], { tokens: 100, contextWindow: 1000, percent: 10 });
    deepStrictEqual(
      bar?.segments.map((segment) => segment.key),
      ["rest"],
    );
  });
});
