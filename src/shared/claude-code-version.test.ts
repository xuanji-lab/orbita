import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CODE_VERSION } from "./claude-code-version.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * agent 真会话发请求用的是 pi-coding-agent 引用的那份 pi-ai（compat 入口的 streamSimple）。
 * 按 Node 的解析顺序找它：先 pi-coding-agent 自己的 node_modules，再顶层。
 * pi-agent-core 底下另有一份没打补丁的 pi-ai，只提供 EventStream 等工具函数，不发请求。
 */
function piAiUsedByAgent(): string {
  const nested = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai");
  return existsSync(nested) ? nested : join(ROOT, "node_modules/@earendil-works/pi-ai");
}

describe("Claude Code 版本口径", () => {
  test("是三段数字版本号", () => {
    assert.match(CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/);
  });

  test("补丁后的 pi-ai 自报版本与 CLAUDE_CODE_VERSION 一致（agent 真会话的 user-agent）", () => {
    const source = readFileSync(join(piAiUsedByAgent(), "dist/api/anthropic-messages.js"), "utf8");
    const match = /const claudeCodeVersion = "([^"]+)";/.exec(source);
    assert.ok(match, "pi-ai 里找不到 claudeCodeVersion——升级 pi 后补丁位置变了，要重做补丁");
    assert.equal(
      match[1],
      CLAUDE_CODE_VERSION,
      "pi-ai 补丁与 shared/claude-code-version.ts 不一致：两处要一起改（patches/@earendil-works%2Fpi-ai@*.patch）",
    );
  });
});
