import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { applyBillingStreamPatch, wrapStreamWithBilling } from "./cc-billing-stream.ts";

/** 会话 streamFunction 的公开形状（与实现同源，不另维护一份类型） */
type SessionStreamFn = AgentSession["agent"]["streamFunction"];

/** pi 0.84.3 给 OAuth 请求加的身份块（anthropic-messages.js OAuth 分支原文） */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function oauthPayload(): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    stream: true,
    system: [
      { type: "text", text: IDENTITY },
      { type: "text", text: "You are an expert coding assistant." },
    ],
    messages: [{ role: "user", content: "hi" }],
  };
}

function plainPayload(): Record<string, unknown> {
  return {
    model: "gpt-5.3",
    stream: true,
    system: [{ type: "text", text: "You are an expert coding assistant." }],
    messages: [{ role: "user", content: "hi" }],
  };
}

/** 只捕获 options 的假 streamFn：返回已结的 promise，测试只看出站 options 的形状 */
function fakeInner(captured: unknown[]): SessionStreamFn {
  const settled = Promise.resolve(null as unknown as Awaited<ReturnType<SessionStreamFn>>);
  return (_model, _context, options) => {
    captured.push(options);
    return settled;
  };
}

/** wrapper 对参数透传用的最小占位（不进任何真实代码路径） */
const fakeModel = { id: "claude-opus-5-5" } as unknown as Parameters<SessionStreamFn>[0];
const fakeContext = { systemPrompt: "", messages: [] } as unknown as Parameters<SessionStreamFn>[1];

describe("wrapStreamWithBilling —— 摘要路径注入车道改写", () => {
  test("调用方没给 onPayload（= 压缩 / 分支摘要的形状）：注入的改写换掉身份块", async () => {
    const captured: unknown[] = [];
    const wrapped = wrapStreamWithBilling(fakeInner(captured));
    await wrapped(fakeModel, fakeContext, { apiKey: "sk-ant-oat01-fake", maxTokens: 100 });

    const options = captured.at(-1) as { apiKey: string; maxTokens: number; onPayload?: (payload: unknown) => unknown };
    // 原有字段原样保留，onPayload 被补上
    assert.equal(options.apiKey, "sk-ant-oat01-fake");
    assert.equal(options.maxTokens, 100);
    assert.ok(typeof options.onPayload === "function");

    const patched = options.onPayload!(oauthPayload()) as { system: { text: string }[]; metadata: unknown };
    assert.match(patched.system[0]!.text, /^x-anthropic-billing-header: cc_version=/);
    assert.ok(!patched.system.some((block) => block.text.includes("official CLI")));
    assert.ok(JSON.stringify(patched.metadata).includes("user_id"));
  });

  test("非 OAuth payload 原样通过（返回 undefined = 调用方不替换）", async () => {
    const captured: unknown[] = [];
    const wrapped = wrapStreamWithBilling(fakeInner(captured));
    await wrapped(fakeModel, fakeContext, { apiKey: "sk-real-key" });

    const options = captured.at(-1) as { onPayload?: (payload: unknown) => unknown };
    assert.equal(options.onPayload!(plainPayload()), undefined);
  });

  test("options 整个缺席也注入（摘要调用可能只带 undefined options）", async () => {
    const captured: unknown[] = [];
    const wrapped = wrapStreamWithBilling(fakeInner(captured));
    await wrapped(fakeModel, fakeContext);

    const options = captured.at(-1) as { onPayload?: (payload: unknown) => unknown };
    const patched = options.onPayload!(oauthPayload()) as { system: { text: string }[] };
    assert.match(patched.system[0]!.text, /^x-anthropic-billing-header/);
  });

  test("调用方已带 onPayload（= 主循环经扩展注册的通路）：逐字透传、不注入", async () => {
    const captured: unknown[] = [];
    const wrapped = wrapStreamWithBilling(fakeInner(captured));
    const given = (payload: unknown): unknown => payload;
    await wrapped(fakeModel, fakeContext, { apiKey: "sk-ant-oat01-fake", onPayload: given });

    const options = captured.at(-1) as { onPayload: (payload: unknown) => unknown };
    assert.equal(options.onPayload, given);
  });
});

describe("applyBillingStreamPatch —— 换掉会话的 streamFunction 属性", () => {
  test("包装后属性不再是原函数，且包装层行为生效（无 onPayload 的调用被注入）", async () => {
    const captured: unknown[] = [];
    const inner = fakeInner(captured);
    const session = { agent: { streamFunction: inner } } as unknown as AgentSession;
    applyBillingStreamPatch(session);
    assert.notEqual(session.agent.streamFunction, inner);
    // 假 streamFn 同步捕获 options，返回的 promise 已结，await 即回
    await session.agent.streamFunction(fakeModel, fakeContext, { apiKey: "k" });
    const options = captured.at(-1) as { onPayload?: (payload: unknown) => unknown };
    assert.ok(typeof options.onPayload === "function");
  });
});
