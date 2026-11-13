import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PANEL_THEME_VARS,
  type PluginBoardCardLive,
  type PluginPanelActionFailure,
  type PluginPanelDataProblem,
  type PluginPanelProblem,
} from "../../../../shared/plugin-panel.ts";
import { mergeBoardCards } from "./board-card.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  actionFailureText,
  buildPanelTheme,
  dataProblemText,
  formatBytes,
  formatSizeVsLimit,
  panelProblemText,
  reduceShownData,
  sameTheme,
  showHostEmpty,
} from "./panel-view.ts";

const ready = (value: unknown, updatedAt = 1): { kind: "ready"; value: unknown; updatedAt: number } => ({ kind: "ready", value, updatedAt });

describe("buildPanelTheme 主题变量下发", () => {
  const dark: Record<string, string> = {
    "--color-text-primary": " rgb(229, 229, 229) ",
    "--color-accent": "rgb(214, 194, 69)",
    "--font-size-lg": "calc(14px + 2px)",
    "color-scheme": "dark",
  };

  test("发的是计算值（去首尾空白），名字取自契约里的那张表；取不到的不发", () => {
    const theme = buildPanelTheme((property) => dark[property] ?? "", "black");
    assert.equal(theme.name, "black");
    assert.equal(theme.scheme, "dark");
    assert.deepEqual(theme.vars, { "--color-text-primary": "rgb(229, 229, 229)", "--color-accent": "rgb(214, 194, 69)", "--font-size-lg": "calc(14px + 2px)" });
  });

  test("没有 color-scheme（或是 light / normal）当 light", () => {
    assert.equal(buildPanelTheme(() => "", "light").scheme, "light");
    assert.equal(buildPanelTheme((p) => (p === "color-scheme" ? "light" : ""), "light").scheme, "light");
  });

  test("契约表覆盖任务要求的角色：文字三档、背景、边框、accent、success / warning / danger、字体族、字号档", () => {
    const has = (name: string): boolean => (PANEL_THEME_VARS as readonly string[]).includes(name);
    for (const name of [
      "--color-text-primary", "--color-text-secondary", "--color-text-tertiary",
      "--color-bg-panel", "--color-bg-muted",
      "--color-border-subtle", "--color-border-default", "--color-border-strong",
      "--color-accent", "--color-success", "--color-warning", "--color-danger",
      "--font-family-base", "--font-family-mono",
      "--font-size-xl", "--font-size-lg", "--font-size-base", "--font-size-sm", "--font-size-xs",
    ]) assert.ok(has(name), name);
  });

  test("只下发表里的变量：读取函数被问到的每个名字都在表里（模板拿不到别的东西）", () => {
    const asked: string[] = [];
    buildPanelTheme((property) => {
      asked.push(property);
      return "x";
    }, "light");
    assert.deepEqual(asked.filter((name) => name !== "color-scheme"), [...PANEL_THEME_VARS]);
  });

  test("sameTheme：值变了才算不同；两边都没有算相同", () => {
    const a = buildPanelTheme((p) => (p === "--color-accent" ? "rgb(1, 1, 1)" : ""), "light");
    const same = buildPanelTheme((p) => (p === "--color-accent" ? "rgb(1, 1, 1)" : ""), "light");
    const other = buildPanelTheme((p) => (p === "--color-accent" ? "rgb(2, 2, 2)" : ""), "light");
    const dark2 = buildPanelTheme((p) => (p === "--color-accent" ? "rgb(1, 1, 1)" : p === "color-scheme" ? "dark" : ""), "light");
    assert.equal(sameTheme(a, same), true);
    assert.equal(sameTheme(a, other), false);
    assert.equal(sameTheme(a, dark2), false);
    assert.equal(sameTheme(null, null), true);
    assert.equal(sameTheme(a, null), false);
  });
});

describe("reduceShownData 新数据与上一份好的怎么取舍", () => {
  test("读成功就换，并记作上一份好的", () => {
    const first = reduceShownData(null, ready({ n: 1 }));
    assert.deepEqual(first, { shown: ready({ n: 1 }), problem: null, lastGood: ready({ n: 1 }) });
  });

  test("读不出来（写到一半 / 超限）：留着上一份好的，只带问题；没有上一份就是空", () => {
    const good = reduceShownData(null, ready({ n: 1 })).lastGood;
    const problem: PluginPanelDataProblem = { kind: "invalid-json", message: "Unexpected end" };
    assert.deepEqual(reduceShownData(good, { kind: "problem", problem }), { shown: ready({ n: 1 }), problem, lastGood: good });
    assert.deepEqual(reduceShownData(null, { kind: "problem", problem }), { shown: { kind: "empty" }, problem, lastGood: null });
  });

  test("文件真的空了 / 没了：回到空态并清掉旧数据（不留着已删的内容）", () => {
    const good = reduceShownData(null, ready({ n: 1 })).lastGood;
    assert.deepEqual(reduceShownData(good, { kind: "empty" }), { shown: { kind: "empty" }, problem: null, lastGood: null });
  });
});

describe("showHostEmpty 宿主何时盖「还没有产出」", () => {
  const base = { shown: { kind: "empty" } as const, problem: null, templateHandlesEmpty: false, graceOver: true };
  test("数据为空、模板没声明画了空态、宽限已过 → 盖", () => {
    assert.equal(showHostEmpty(base), true);
  });
  test("模板声明了 emptyState / 宽限没过（还在等 ready）/ 有数据 / 有读取问题（问题条已说明）→ 不盖", () => {
    assert.equal(showHostEmpty({ ...base, templateHandlesEmpty: true }), false);
    assert.equal(showHostEmpty({ ...base, graceOver: false }), false);
    assert.equal(showHostEmpty({ ...base, shown: ready(1) }), false);
    assert.equal(showHostEmpty({ ...base, problem: { kind: "too-large", bytes: 9 } }), false);
  });
});

describe("formatSizeVsLimit 超限那句话里的两个数不能自相矛盾", () => {
  test("刚超一点点（2 MB 多几百字节）：写成 2049 KB 对 2048 KB，不是「2.0 MB 超过 2.0 MB」", () => {
    assert.deepEqual(formatSizeVsLimit(2 * 1024 * 1024 + 130, 2 * 1024 * 1024), { size: "2049 KB", limit: "2048 KB" });
  });
  test("很大（≥ 10 MB）换 MB", () => {
    assert.deepEqual(formatSizeVsLimit(25 * 1024 * 1024, 2 * 1024 * 1024), { size: "25.0 MB", limit: "2.0 MB" });
  });
});

describe("formatBytes", () => {
  test("B / KB / MB", () => {
    assert.equal(formatBytes(12), "12 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(3.2 * 1024 * 1024), "3.2 MB");
  });
});

describe("文案：每一种问题、每一种失败原因、两种语言都有一句话", () => {
  const problems: PluginPanelProblem[] = [
    { kind: "template-escape", detail: "../x.html" },
    { kind: "template-missing", detail: "./nope.html" },
    { kind: "template-unreadable", detail: "EACCES" },
    { kind: "template-too-large", detail: "2000000" },
    { kind: "data-escape", detail: "/etc/passwd" },
    { kind: "data-variable", detail: "HOME" },
    { kind: "data-config-missing", detail: "OUT_DIR" },
    { kind: "data-sensitive", detail: "TOKEN" },
    { kind: "data-needs-workspace", detail: "workspaceFolder" },
    { kind: "spec-escape", detail: "../spec.md" },
    { kind: "spec-missing", detail: "./nope.md" },
    { kind: "spec-unreadable", detail: "EACCES" },
    { kind: "spec-too-large", detail: "100000" },
    { kind: "sample-escape", detail: "../sample.json" },
    { kind: "sample-missing", detail: "./nope.json" },
    { kind: "sample-unreadable", detail: "EACCES" },
    { kind: "sample-too-large", detail: "3000000" },
    { kind: "sample-invalid", detail: "Unexpected token" },
    { kind: "repeat-not-array", detail: "items" },
    { kind: "repeat-limit", detail: "24" },
  ];
  for (const [name, messages] of [["en", en], ["zh", zh]] as const) {
    test(`${name}：解析问题带上路径 / 变量名 / 键名`, () => {
      for (const problem of problems) {
        const text = panelProblemText(messages.pluginPanel, problem);
        assert.ok(text.length > 8, `${problem.kind}: ${text}`);
        const sizeOnly = ["template-too-large", "spec-too-large", "sample-too-large"];
        if (problem.kind !== "data-needs-workspace" && !sizeOnly.includes(problem.kind)) {
          assert.ok(text.includes(problem.detail), `${problem.kind} 应带上 ${problem.detail}：${text}`);
        }
      }
    });
    test(`${name}：数据读取问题与动作失败`, () => {
      const dataProblems: PluginPanelDataProblem[] = [
        { kind: "too-large", bytes: 3 * 1024 * 1024 },
        { kind: "invalid-json", message: "Unexpected token" },
        { kind: "unreadable", message: "EACCES" },
      ];
      for (const problem of dataProblems) assert.ok(dataProblemText(messages.pluginPanel, problem, 2 * 1024 * 1024).length > 8);
      assert.match(dataProblemText(messages.pluginPanel, dataProblems[0] as PluginPanelDataProblem, 2 * 1024 * 1024), /3072 KB.*2048 KB/);
      const reasons: PluginPanelActionFailure[] = ["invalid", "action-too-long", "payload-too-large", "too-fast", "file-full", "unavailable", "failed"];
      for (const reason of reasons) assert.ok(actionFailureText(messages.pluginPanel, reason).length > 3, reason);
    });
  }
});

describe("mergeBoardCards 一份快照并进手里的记忆", () => {
  const live = (key: string, extra: Partial<PluginBoardCardLive> = {}): PluginBoardCardLive => ({
    key,
    id: key.split("#")[0] ?? key,
    title: key,
    size: "1x1",
    index: 0,
    problems: [],
    frameUrl: `orbita-panel://doc/${key}`,
    broken: false,
    data: ready({ n: 1 }),
    usingSample: false,
    ...extra,
  });
  const counter = (): (() => number) => {
    let n = 0;
    return () => (n += 1);
  };

  test("第一次来：每张卡拿到自己的 iframe 地址与递增的 frameKey", () => {
    const merged = mergeBoardCards(new Map(), [live("a"), live("b")], counter());
    assert.deepEqual(merged.views.map((view) => [view.key, view.frameUrl, view.frameKey]), [["a", "orbita-panel://doc/a", 1], ["b", "orbita-panel://doc/b", 2]]);
  });

  test("frameUrl 为 null（模板没变）：沿用手里的地址与 frameKey，只换数据——iframe 不重建", () => {
    const next = counter();
    const first = mergeBoardCards(new Map(), [live("a")], next);
    const second = mergeBoardCards(first.memory, [live("a", { frameUrl: null, data: ready({ n: 2 }) })], next);
    assert.equal(second.views[0]?.frameUrl, "orbita-panel://doc/a");
    assert.equal(second.views[0]?.frameKey, first.views[0]?.frameKey);
    assert.deepEqual(second.views[0]?.shown, ready({ n: 2 }));
  });

  test("模板换了（新地址）：frameKey 递增，iframe 重建", () => {
    const next = counter();
    const first = mergeBoardCards(new Map(), [live("a")], next);
    const second = mergeBoardCards(first.memory, [live("a", { frameUrl: "orbita-panel://doc/a2" })], next);
    assert.equal(second.views[0]?.frameUrl, "orbita-panel://doc/a2");
    assert.notEqual(second.views[0]?.frameKey, first.views[0]?.frameKey);
  });

  test("数据读不出来：留着上一份好的并带问题；快照里没有的卡的记忆丢掉（再来就是新的）", () => {
    const next = counter();
    const first = mergeBoardCards(new Map(), [live("a"), live("b")], next);
    const bad = mergeBoardCards(first.memory, [live("a", { frameUrl: null, data: { kind: "problem", problem: { kind: "invalid-json", message: "x" } } })], next);
    assert.deepEqual(bad.views[0]?.shown, ready({ n: 1 }));
    assert.equal(bad.views[0]?.problem?.kind, "invalid-json");
    assert.equal(bad.memory.has("b"), false);
    const again = mergeBoardCards(bad.memory, [live("a", { frameUrl: null }), live("b", { frameUrl: null })], next);
    assert.equal(again.views[1]?.frameUrl, null, "b 的记忆已丢，又没给新地址：画不出（显示载入中），不会拿旧地址冒充");
  });

  test("broken 的卡：不给 iframe，带原因", () => {
    const merged = mergeBoardCards(new Map(), [live("a", { broken: true, frameUrl: null, problems: [{ kind: "template-missing", detail: "./x.html" }] })], counter());
    assert.equal(merged.views[0]?.frameUrl, null);
    assert.equal(merged.views[0]?.brokenProblems?.[0]?.kind, "template-missing");
  });
});
