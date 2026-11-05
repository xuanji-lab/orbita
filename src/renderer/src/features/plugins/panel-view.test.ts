import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PANEL_THEME_VARS,
  type PluginPanelActionFailure,
  type PluginPanelDataProblem,
  type PluginPanelProblem,
} from "../../../../shared/plugin-panel.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  RAW_VIEW_MAX_CHARS,
  actionFailureText,
  buildPanelTheme,
  dataProblemText,
  formatBytes,
  formatSizeVsLimit,
  panelProblemText,
  rawDataText,
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

describe("rawDataText 原始数据视图", () => {
  test("缩进的 JSON；空 / 有问题给空串", () => {
    assert.deepEqual(rawDataText(ready({ a: [1] })), { text: '{\n  "a": [\n    1\n  ]\n}', truncated: false });
    assert.deepEqual(rawDataText({ kind: "empty" }), { text: "", truncated: false });
  });
  test("太长截断并标出", () => {
    const result = rawDataText(ready("x".repeat(RAW_VIEW_MAX_CHARS + 10)));
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, RAW_VIEW_MAX_CHARS);
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
    { kind: "shape", detail: "template" },
    { kind: "shape", detail: "data" },
    { kind: "shape", detail: "panel" },
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
  ];
  for (const [name, messages] of [["en", en], ["zh", zh]] as const) {
    test(`${name}：解析问题带上路径 / 变量名 / 键名`, () => {
      for (const problem of problems) {
        const text = panelProblemText(messages.pluginPanel, problem);
        assert.ok(text.length > 8, `${problem.kind}: ${text}`);
        const sizeOnly = ["template-too-large", "spec-too-large", "sample-too-large"];
        if (problem.kind !== "shape" && problem.kind !== "data-needs-workspace" && !sizeOnly.includes(problem.kind)) {
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
