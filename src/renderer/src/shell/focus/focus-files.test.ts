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
  POLL_GATE_IDLE,
  pollGateAccept,
  pollGateBegin,
  pollGateSettle,
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
  assert.equal(formatChangeLines(entry("a", "M", 42, 7)), "+42 \u22127");
  assert.equal(formatChangeLines(entry("a", "U", 86, 0)), "+86");
  assert.equal(formatChangeLines(entry("a", "M", 0, 5)), "\u22125");
  assert.equal(formatChangeLines(entry("a", "M", 0, 0)), "");
  assert.equal(formatChangeLines(entry("a", "M", 10, 2, true)), "");
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

test("pollGate：同一工作区在途时新拍放弃（慢 git 不叠跑）", () => {
  const first = pollGateBegin(POLL_GATE_IDLE, "ws-a");
  assert.notEqual(first, null);
  // 同工作区又来一拍（30 秒钟到的钟点 / 回前台补拍）：放弃
  assert.equal(pollGateBegin(first!.gate, "ws-a"), null);
  // 落定对得上号：收，清在途
  assert.equal(pollGateAccept(first!.gate, first!.mine), true);
  const settled = pollGateSettle(first!.gate);
  assert.equal(settled.inflight, false);
  // 清了之后下一拍又能发（代次继续 +1，不是永远卡住）
  const second = pollGateBegin(settled, "ws-a");
  assert.notEqual(second, null);
  assert.equal(second!.mine, first!.mine + 1);
});

test("pollGate：换工作区顶替在途，旧结果落定作废", () => {
  const a = pollGateBegin(POLL_GATE_IDLE, "ws-a");
  assert.notEqual(a, null);
  // ws-a 还在途就切到 ws-b：不等待，直接顶替（代次 +1）
  const b = pollGateBegin(a!.gate, "ws-b");
  assert.notEqual(b, null);
  assert.equal(b!.gate.workspaceId, "ws-b");
  // 旧的那遭后到：对不上号，作废——不拿 ws-a 的清单盖 ws-b
  assert.equal(pollGateAccept(b!.gate, a!.mine), false);
  // 新的那遭照收
  assert.equal(pollGateAccept(b!.gate, b!.mine), true);
  // settle 只清在途不动代次：先 settle 后落定的那遭照样对得上号
  assert.equal(pollGateAccept(pollGateSettle(b!.gate), b!.mine), true);
});
