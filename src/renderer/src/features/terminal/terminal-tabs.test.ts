import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TerminalInfo } from "@shared/terminal";
import { activeTerminalId, mergeTerminals } from "./terminal-tabs.ts";

const tab = (id: string): TerminalInfo => ({
  terminalId: id,
  title: id,
  shell: "pwsh",
  cwd: "/repo",
  pid: 1,
  exited: null,
  owner: { kind: "agent", sessionId: "s1" },
});

describe("activeTerminalId —— 当前看哪个 tab", () => {
  it("点过的那个还在：留着", () => {
    strictEqual(activeTerminalId(["a", "b", "c"], "a"), "a");
    strictEqual(activeTerminalId(["a", "b", "c"], "b"), "b");
  });

  it("点过的不在了（被关 / 还没收养）：落最后一个", () => {
    strictEqual(activeTerminalId(["a", "b"], "gone"), "b");
    strictEqual(activeTerminalId(["a"], null), "a");
  });

  it("一个都没有：null（面板走空态）", () => {
    strictEqual(activeTerminalId([], null), null);
    strictEqual(activeTerminalId([], "whatever"), null);
  });
});

describe("mergeTerminals —— 收养 agent 开的终端", () => {
  it("未知终端并进来，已知的不重复，新的排末尾（tab 顺序 = 创建顺序）", () => {
    deepStrictEqual(mergeTerminals([tab("a")], [tab("a"), tab("b")]).map((t) => t.terminalId), ["a", "b"]);
    deepStrictEqual(mergeTerminals([tab("a"), tab("b")], [tab("c")]).map((t) => t.terminalId), ["a", "b", "c"]);
  });

  it("幂等：同一个终端合并两次还是一个", () => {
    deepStrictEqual(mergeTerminals([tab("a")], [tab("a")]).map((t) => t.terminalId), ["a"]);
  });

  it("空清单合并是空；只合并不替换——关掉的 tab 不会被旧清单复活", () => {
    deepStrictEqual(mergeTerminals([], []), []);
    // 用户关掉了 b，面板只剩 a；此刻若按一份过期清单整体替换，b 会回来（PTY 已杀）
    deepStrictEqual(mergeTerminals([tab("a")], [tab("a"), tab("b")]).map((t) => t.terminalId), ["a", "b"]);
    deepStrictEqual(mergeTerminals([tab("a")], [tab("b")]).map((t) => t.terminalId), ["a", "b"]);
  });
});
