import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { collectOpenHints, resetOpenedAfterTurn } from "./auto-open-panel.ts";
import { readCommandCard, readOpenPanel } from "../../../../shared/builtin-command.ts";

const tool = (toolCallId: string, details: unknown, status: "running" | "complete" | "error" = "complete"): TranscriptItem =>
  ({ id: `i-${toolCallId}`, role: "tool", toolCallId, toolName: "slides_create", input: {}, content: [], timestamp: 0, status, isError: status === "error", details }) as unknown as TranscriptItem;

const hint = (path: string, force?: boolean) => ({ openPanel: { kind: "slides", path, ...(force === true ? { force } : {}) } });

describe("collectOpenHints", () => {
  it("本轮在跑：新落定的结果带 openPanel 就请求打开，同一个 id 只处理一次", () => {
    const seen = new Set<string>();
    const opened = new Set<string>();
    const transcript = [tool("a", hint("/w/x.slides.json", true))];
    assert.deepEqual(collectOpenHints(transcript, seen, opened, true), [{ kind: "slides", path: "/w/x.slides.json", force: true }]);
    assert.deepEqual(collectOpenHints(transcript, seen, opened, true), []);
  });

  it("历史回放（本轮没在跑）不开面板，但记为已处理", () => {
    const seen = new Set<string>();
    const transcript = [tool("a", hint("/w/x.slides.json", true))];
    assert.deepEqual(collectOpenHints(transcript, seen, new Set(), false), []);
    assert.deepEqual(collectOpenHints(transcript, seen, new Set(), true), []);
  });

  it("非 force：同一个文件只在第一次开；force 每次开", () => {
    const seen = new Set<string>();
    const opened = new Set<string>();
    const out = collectOpenHints(
      [tool("a", hint("/w/x")), tool("b", hint("/w/x")), tool("c", hint("/w/x", true))],
      seen,
      opened,
      true,
    );
    assert.deepEqual(out.map((h) => h.force === true), [false, true]);
  });

  it("running / error 帧与坏形状不开", () => {
    const out = collectOpenHints(
      [tool("a", hint("/w/x"), "running"), tool("b", hint("/w/y"), "error"), tool("c", { openPanel: { kind: "nope", path: "/z" } }), tool("d", undefined)],
      new Set(),
      new Set(),
      true,
    );
    assert.deepEqual(out, []);
  });
});

describe("details 校验", () => {
  it("openPanel 的 path 必须是非空字符串、kind 必须认识", () => {
    assert.equal(readOpenPanel({ openPanel: { kind: "slides", path: "" } }), null);
    assert.equal(readOpenPanel({ openPanel: { kind: "files", path: "/a" } })?.kind, "files");
    assert.equal(readOpenPanel(null), null);
    assert.equal(readOpenPanel([]), null);
  });

  it("card 逐字段校验", () => {
    assert.equal(readCommandCard({ card: { kind: "slides", path: "/a", title: "t" } })?.title, "t");
    assert.equal(readCommandCard({ card: { kind: "slides", path: "/a", title: 3 } }), null);
    assert.equal(readCommandCard({ card: { kind: "weird", path: "/a", title: "t" } }), null);
    assert.equal(readCommandCard({ card: { kind: "doc", path: "/a", title: "t", subtitle: "s" } })?.subtitle, "s");
  });
});

describe("一轮结束后忘掉已开过的路径", () => {
  it("同一轮里同一个文件只开一次；下一轮再说「打开 X」还能开（用户可能已关掉标签）", () => {
    const seen = new Set<string>();
    const opened = new Set<string>();
    assert.equal(collectOpenHints([tool("a", hint("/w/x.md"))], seen, opened, true).length, 1);
    resetOpenedAfterTurn(opened, true, true); // 还在跑：不清
    assert.equal(collectOpenHints([tool("b", hint("/w/x.md"))], seen, opened, true).length, 0);
    resetOpenedAfterTurn(opened, true, false); // 本轮结束：清
    assert.equal(collectOpenHints([tool("c", hint("/w/x.md"))], seen, opened, true).length, 1);
  });
});
