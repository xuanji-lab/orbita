import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ccBillingPatch, isAnthropicOauthPayload, sanitizeSystemPrompt } from "./cc-billing-patch.ts";

/** pi 0.84.3 给 OAuth 请求加的身份块（anthropic-messages.ts 的 OAuth 分支原文） */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** 我们这版 pi 基础 prompt 的开头（system-prompt.js:82） */
const PI_PROMPT_HEAD = "You are an expert coding assistant operating inside pi, a coding agent harness.";

function oauthPayload(system: unknown[] = [{ type: "text", text: IDENTITY }, { type: "text", text: PI_PROMPT_HEAD }]) {
  return { model: "claude-haiku-5-5", stream: true, system, messages: [{ role: "user", content: "hi" }] };
}

describe("isAnthropicOauthPayload —— 只认带 pi OAuth 身份块的请求", () => {
  test("有身份块 = OAuth 直连", () => {
    assert.equal(isAnthropicOauthPayload(oauthPayload()), true);
  });
  test("API key / 网关请求没有身份块：不动", () => {
    assert.equal(isAnthropicOauthPayload({ ...oauthPayload(), system: [{ type: "text", text: PI_PROMPT_HEAD }] }), false);
    assert.equal(isAnthropicOauthPayload({ model: "gpt", messages: [] }), false);
    assert.equal(isAnthropicOauthPayload(null), false);
  });
});

describe("sanitizeSystemPrompt —— 洗掉 pi 自称", () => {
  test("基础 prompt 的触发句全部换掉", () => {
    const out = sanitizeSystemPrompt(
      "You are an expert coding assistant operating inside pi, a coding agent harness. Pi documentation (read only when the user asks about pi itself, its SDK). See pi packages docs. Always read pi .md files completely. Path: node_modules/@earendil-works/pi-coding-agent/README.md",
    );
    assert.ok(!/inside pi/.test(out));
    assert.ok(!/Pi documentation/.test(out));
    assert.ok(!/pi itself/.test(out));
    assert.ok(!/pi packages/.test(out));
    assert.ok(!/read pi \.md/.test(out));
    assert.ok(!/pi-coding-agent/.test(out));
    assert.match(out, /operating as a coding assistant\./);
  });
  test("独立的 pi 一词兜底替换；连字符形式（pi-sessions）不动", () => {
    const out = sanitizeSystemPrompt("use pi for the loop; see pi-sessions dir");
    assert.ok(!/\bpi\b[\s,.]/.test(out));
    assert.match(out, /pi-sessions/);
  });
});

describe("ccBillingPatch —— OAuth 请求的四件事", () => {
  test("路由标打头、身份块删除、prompt 过洗、metadata 补齐；不动入参", () => {
    const payload = oauthPayload();
    const patched = ccBillingPatch(payload) as { system: { type: string; text: string }[]; metadata: { user_id: string } };
    assert.ok(patched !== undefined);
    assert.match(patched.system[0]!.text, /^x-anthropic-billing-header: cc_version=2\.1\.280\.000; cc_entrypoint=cli;$/);
    assert.ok(!patched.system.some((b) => b.text.includes("official CLI")));
    assert.ok(!patched.system.some((b) => b.text.includes("inside pi")));
    assert.ok(JSON.stringify(patched.metadata).includes("device_id"));
    // 入参不被就地改（会话侧的对象不属于这一层）
    assert.deepEqual(payload.system, [IDENTITY, PI_PROMPT_HEAD].map((text) => ({ type: "text", text })));
  });

  test("cache_control 等伴生字段保留", () => {
    const patched = ccBillingPatch(
      oauthPayload([
        { type: "text", text: IDENTITY },
        { type: "text", text: PI_PROMPT_HEAD, cache_control: { type: "ephemeral" } },
      ]),
    ) as { system: { text: string; cache_control?: { type: string } }[] };
    const kept = patched.system.find((b) => b.text.includes("coding assistant"));
    assert.deepEqual(kept?.cache_control, { type: "ephemeral" });
  });

  test("幂等：已带路由标的 payload 再过一遍不堆块", () => {
    const once = ccBillingPatch(oauthPayload()) as { system: unknown[] };
    // 重建身份块模拟 pi 再组装一次（身份块来自 pi，不会来自我们）
    const again = ccBillingPatch(oauthPayload([once.system[0], { type: "text", text: IDENTITY }, ...once.system.slice(1)])) as {
      system: { text: string }[];
    };
    assert.equal(again.system.filter((b) => b.text.startsWith("x-anthropic-billing-header")).length, 1);
  });

  test("已有 metadata 不覆盖", () => {
    const patched = ccBillingPatch({ ...oauthPayload(), metadata: { user_id: "existing" } }) as { metadata: { user_id: string } };
    assert.equal(patched.metadata.user_id, "existing");
  });

  test("非 OAuth payload 返回 undefined（调用方不替换）", () => {
    assert.equal(ccBillingPatch({ ...oauthPayload(), system: [{ type: "text", text: PI_PROMPT_HEAD }] }), undefined);
    assert.equal(ccBillingPatch(undefined), undefined);
  });
});
