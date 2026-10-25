/**
 * 工作区文件视图纯推导的测试（focus-files.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestorsOf,
  changeIndexOf,
  changeSummary,
  dirChangeIndex,
  formatChangeLines,
  isHiddenEntry,
  joinRel,
  shouldPollChanges,
} from "./focus-files.ts";
import type { FocusChangeEntry } from "@shared/focus";

const entry = (path: string, kind: "U" | "M", added = 0, removed = 0, binary = false): FocusChangeEntry => ({
  path,
  kind,
  added,
  removed,
  binary,
});

test("isHiddenEntry：点开头隐藏，其余照列", () => {
  assert.equal(isHiddenEntry(".git"), true);
  assert.equal(isHiddenEntry(".DS_Store"), true);
  assert.equal(isHiddenEntry("src"), false);
  assert.equal(isHiddenEntry("a.ts"), false);
});

test("dirChangeIndex：祖先全标；U 压过 M；根层文件不产目录", () => {
  const dirs = dirChangeIndex([
    entry("src/renderer/src/shell/Sidebar.tsx", "M"),
    entry("notes/new.md", "U"),
    entry("README.md", "M"),
  ]);
  assert.equal(dirs.get("src"), "M");
  assert.equal(dirs.get("src/renderer"), "M");
  assert.equal(dirs.get("src/renderer/src"), "M");
  assert.equal(dirs.get("src/renderer/src/shell"), "M");
  assert.equal(dirs.get("notes"), "U");
  // 没有改动的目录不在表里
  assert.equal(dirs.has("design-system"), false);
  // 混合目录（同目录 U + M）：U 压过 M
  const mixed = dirChangeIndex([entry("a/x.ts", "M"), entry("a/y.ts", "U")]);
  assert.equal(mixed.get("a"), "U");
  // 根层文件（README.md）没有祖先
  assert.equal([...dirs.keys()].includes("README.md"), false);
});

test("ancestorsOf：浅→深；根层文件为空", () => {
  assert.deepEqual(ancestorsOf("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestorsOf("root.ts"), []);
  assert.deepEqual(ancestorsOf("a/x.ts"), ["a"]);
});

test("changeSummary：总数与新文件数", () => {
  assert.deepEqual(changeSummary([entry("a", "M"), entry("b", "U"), entry("c", "U")]), {
    changed: 3,
    untracked: 2,
  });
  assert.deepEqual(changeSummary([]), { changed: 0, untracked: 0 });
});

test("formatChangeLines：两侧 / 单侧 / 零 / 二进制", () => {
  assert.equal(formatChangeLines(entry("a", "M", 42, 7), ""), "+42 \u22127");
  assert.equal(formatChangeLines(entry("a", "U", 86, 0), ""), "+86");
  assert.equal(formatChangeLines(entry("a", "M", 0, 5), ""), "\u22125");
  assert.equal(formatChangeLines(entry("a", "M", 0, 0), ""), "");
  assert.equal(formatChangeLines(entry("a", "M", 10, 2, true), ""), "");
});

test("formatChangeLines：超大未跟踪文件的文案由调用方按界面语言给（不写死中文），不拿 +0 冒充", () => {
  // 超过单文件上限只判了二进制、没数行 → 用调用方传进来的那句（t.focus.linesUnknown）
  const big = { ...entry("big.dat", "U", 0, 0), lineCountUnknown: true };
  assert.equal(formatChangeLines(big, "行数未知"), "行数未知");
  assert.equal(formatChangeLines(big, "line count unavailable"), "line count unavailable");
  // 二进制仍是空串：binary 优先，不额外说「行数未知」
  assert.equal(
    formatChangeLines({ ...entry("big.bin", "U", 0, 0, true), lineCountUnknown: true }, "行数未知"),
    "",
  );
});

test("joinRel 与 changeIndexOf", () => {
  assert.equal(joinRel("", "src"), "src");
  assert.equal(joinRel("src", "a.ts"), "src/a.ts");
  const index = changeIndexOf([entry("src/a.ts", "M", 3, 1)]);
  assert.equal(index.get("src/a.ts")?.added, 3);
  assert.equal(index.get("nope"), undefined);
});

test("shouldPollChanges：只在看得见时拉 U / M", () => {
  assert.equal(shouldPollChanges("visible"), true);
  // 窗口藏着（最小化 / 在别的应用前）：这一拍跳过
  assert.equal(shouldPollChanges("hidden"), false);
  // 「先渲染再画」的中间态不算藏起来——宁可多拉一拍，屏幕上的人在看
  assert.equal(shouldPollChanges("prerender"), true);
});
