/**
 * bash 使用统计脚本的纯函数测试（2026-10-18）。
 * 只测分类逻辑与 JSONL 解析——读盘那半（main）不进测试。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CUTOFF,
  bashCallsOf,
  firstCommand,
  isSearchOrView,
  parseArgs,
  parseSessionJsonl,
  searchViewBreakdown,
  splitSegments,
  summarizeByPeriod,
  toolCallCounts,
} from "./tool-usage-stats.mjs";

describe("splitSegments", () => {
  it("按管道 / && / ; / 换行切段", () => {
    assert.deepEqual(splitSegments("cd foo && grep -rn x . | head -5"), ["cd foo", "grep -rn x .", "head -5"]);
    assert.deepEqual(splitSegments("a; b\nc || d"), ["a", "b", "c", "d"]);
  });

  it("空段（连续分隔符 / 首尾空白）被滤掉", () => {
    assert.deepEqual(splitSegments("  &&  "), []);
  });
});

describe("firstCommand", () => {
  it("取首个命令，只留末段路径并转小写", () => {
    assert.equal(firstCommand("/usr/bin/Grep -rn x ."), "grep");
    assert.equal(firstCommand("git status"), "git");
  });

  it("跳过 cd / pushd / export 这类不干活的段头", () => {
    assert.equal(firstCommand("cd /repo"), "");
    assert.equal(firstCommand("export FOO=bar"), "");
    assert.equal(firstCommand("cat x"), "cat");
    assert.deepEqual(splitSegments("cd /repo && cat x").map(firstCommand), ["", "cat"]);
    assert.deepEqual(splitSegments("export A=1; rg foo").map(firstCommand), ["", "rg"]);
  });
});

describe("isSearchOrView", () => {
  it("grep / rg / find / fd / ls / cat / head / tail 算搜索查看", () => {
    for (const command of [
      "grep -rn X .",
      "rg TODO src",
      "find . -name '*.ts'",
      "fd '*.ts'",
      "ls -la",
      "cat src/a.ts",
      "head -20 f",
      "tail -f log",
    ]) {
      assert.equal(isSearchOrView(command), true, command);
    }
  });

  it("只有带 -n 的 sed 才算（-n 是 read 的活；替换不是）", () => {
    assert.equal(isSearchOrView("sed -n '1,5p' f"), true);
    assert.equal(isSearchOrView("sed 's/a/b/' f"), false);
  });

  it("真命令不算：构建 / 测试 / git / 包管理", () => {
    assert.equal(isSearchOrView("bun run test && git status"), false);
    assert.equal(isSearchOrView("bun install"), false);
    assert.equal(isSearchOrView("python -m pytest"), false);
  });

  it("段中间的搜索命令也算（cd 之后 / 管道前面）", () => {
    assert.equal(isSearchOrView("cd C:/repo && grep -rn X src"), true);
    assert.equal(isSearchOrView("git diff | cat"), true);
  });
});

describe("parseSessionJsonl / toolCallCounts / bashCallsOf", () => {
  const jsonl = [
    JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] }),
    JSON.stringify({
      role: "assistant",
      timestamp: 1000,
      content: [
        { type: "thinking", thinking: "..." },
        { type: "toolCall", toolCallId: "a", toolName: "bash", input: { command: "grep -rn x ." } },
        { type: "toolCall", toolCallId: "b", toolName: "grep", input: { pattern: "x" } },
      ],
    }),
    "这条是半截行 {",
    JSON.stringify({
      role: "assistant",
      timestamp: 2000,
      content: [{ type: "toolCall", toolCallId: "c", toolName: "bash", input: { command: "bun run test" } }],
    }),
  ].join("\n");

  it("坏行跳过，其余照常解析", () => {
    assert.equal(parseSessionJsonl(jsonl).length, 3);
  });

  it("toolCallCounts 按工具名计数（只认 assistant 的 toolCall 块）", () => {
    const counts = toolCallCounts(parseSessionJsonl(jsonl));
    assert.equal(counts.get("bash"), 2);
    assert.equal(counts.get("grep"), 1);
    assert.equal(counts.get("thinking"), undefined);
  });

  it("bashCallsOf 只取 bash 且带时间戳，input.command 非字符串的跳过", () => {
    const calls = bashCallsOf(parseSessionJsonl(jsonl));
    assert.deepEqual(
      calls.map((call) => [call.timestamp, call.command]),
      [
        [1000, "grep -rn x ."],
        [2000, "bun run test"],
      ],
    );
  });

  it("searchViewBreakdown 细分到子命令", () => {
    const calls = bashCallsOf(
      parseSessionJsonl(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "toolCall", toolName: "bash", input: { command: "grep -rn x . && cat a.ts" } },
            { type: "toolCall", toolName: "bash", input: { command: "sed -n '1,5p' b.ts" } },
            { type: "toolCall", toolName: "bash", input: { command: "bun test" } },
          ],
        }),
      ),
    );
    const breakdown = searchViewBreakdown(calls);
    assert.equal(breakdown.get("grep"), 1);
    assert.equal(breakdown.get("cat"), 1);
    assert.equal(breakdown.get("sed -n"), 1);
    assert.equal(breakdown.get("bun"), undefined);
  });
});

describe("summarizeByPeriod", () => {
  const calls = [
    { timestamp: 1000, command: "grep -rn x ." }, // 修复前，搜索
    { timestamp: 2000, command: "bun run test" }, // 修复前，真命令
    { timestamp: 3000, command: "rg foo" }, // 修复后，搜索
    { timestamp: 4000, command: "git status" }, // 修复后，真命令
  ];

  it("按 cutoff 分前后，各自算搜索查看占比", () => {
    const summary = summarizeByPeriod(calls, 2500);
    assert.deepEqual(summary.before, { total: 2, searchView: 1, pct: 50 });
    assert.deepEqual(summary.after, { total: 2, searchView: 1, pct: 50 });
    assert.deepEqual(summary.all, { total: 4, searchView: 2, pct: 50 });
  });

  it("某段没有 bash 调用：pct 为 null，不除零", () => {
    const summary = summarizeByPeriod([{ timestamp: 1000, command: "grep x" }], 9999999999999);
    assert.deepEqual(summary.after, { total: 0, searchView: 0, pct: null });
  });

  it("采不到时间戳的调用只进 all，不进前后两段", () => {
    const summary = summarizeByPeriod([{ timestamp: null, command: "grep x" }], 2500);
    assert.equal(summary.all.total, 1);
    assert.equal(summary.before.total, 0);
    assert.equal(summary.after.total, 0);
  });
});

describe("parseArgs", () => {
  it("位置参数是目录，--cutoff 的值不会被当成目录", () => {
    assert.deepEqual(parseArgs(["C:/sessions", "--cutoff", "2026-10-05"]), {
      dir: "C:/sessions",
      cutoff: "2026-10-05",
    });
    assert.deepEqual(parseArgs(["--cutoff", "2026-10-05"]), { dir: null, cutoff: "2026-10-05" });
  });

  it("--cutoff=… 形式也认；缺席都是 null", () => {
    assert.deepEqual(parseArgs(["--cutoff=2026-10-05"]), { dir: null, cutoff: "2026-10-05" });
    assert.deepEqual(parseArgs([]), { dir: null, cutoff: null });
    assert.deepEqual(parseArgs(["/a", "/b"]), { dir: "/a", cutoff: null });
  });
});

describe("默认 cutoff", () => {
  it("是 grep/find/ls 合入的 2026-10-04（改这个值要同时改 commit 里的解读）", () => {
    assert.equal(DEFAULT_CUTOFF, "2026-10-04");
  });
});
