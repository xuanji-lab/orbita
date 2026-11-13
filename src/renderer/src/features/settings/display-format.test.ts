import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { abbreviateHome, formatDay, middleEllipsis } from "./display-format.ts";

describe("display-format", () => {
  test("家目录缩成 ~（含 Windows 反斜杠路径）；不在家目录下的原样", () => {
    assert.equal(abbreviateHome("/Users/me/.proma-dev/agent-sessions.json", "/Users/me"), "~/.proma-dev/agent-sessions.json");
    assert.equal(abbreviateHome("/Users/meta/x", "/Users/me"), "/Users/meta/x");
    assert.equal(abbreviateHome("/Users/me", "/Users/me"), "~");
    assert.equal(abbreviateHome("C:\\Users\\me\\.proma-dev\\x", "C:\\Users\\me"), "~\\.proma-dev\\x");
    assert.equal(abbreviateHome("/x", ""), "/x");
  });

  test("今年只写月-日，往年带年份", () => {
    const now = new Date(2026, 10, 14).getTime();
    assert.equal(formatDay(new Date(2026, 2, 5).getTime(), now), "03-05");
    assert.equal(formatDay(new Date(2025, 11, 31).getTime(), now), "2025-12-31");
  });

  test("长路径中间省略：留头尾、总长不超；短路径原样", () => {
    const long = "~/Library/Application Support/orbita/workbenches/c22f24c6-e12e-485a-b923/custom-kimi";
    const cut = middleEllipsis(long, 40);
    assert.equal(cut.length, 40);
    assert.ok(cut.startsWith("~/Library"));
    assert.ok(cut.endsWith("custom-kimi"));
    assert.ok(cut.includes("…"));
    assert.equal(middleEllipsis("~/.codex", 40), "~/.codex");
  });
});
