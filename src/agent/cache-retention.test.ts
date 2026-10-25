/**
 * Claude 提示缓存时长（cache-retention.ts）：判定表、包装层、以及到真实请求体的端到端。
 * 端到端走 pi 0.84.3 的 anthropic-messages streamSimple，用假 fetch 截下真正要发出的
 * HTTP body（不联网），断言 tools / system / 最后一条消息上的 cache_control。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Context, FetchFunction, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  applyCacheRetentionPatch,
  chooseCacheRetention,
  wrapStreamWithCacheRetention,
  type SessionRole,
} from "./cache-retention.ts";
import { wrapStreamWithBilling } from "./cc-billing-stream.ts";
import { ccBillingPatch } from "./cc-billing-patch.ts";

type SessionStreamFn = AgentSession["agent"]["streamFunction"];

const OFFICIAL = "https://api.anthropic.com";
const GATEWAY = "https://rnm.wublubdubdub.fyi";

describe("chooseCacheRetention —— 判定表", () => {
  const anthropic = (baseUrl: string) => ({ api: "anthropic-messages", baseUrl });
  const cases: { name: string; model: { api: string; baseUrl: string }; role: SessionRole; want: "long" | undefined }[] = [
    { name: "官方地址主会话（订阅 OAuth 与 API key 同一地址）", model: anthropic(OFFICIAL), role: "root", want: "long" },
    { name: "官方地址子会话", model: anthropic(OFFICIAL), role: "child", want: undefined },
    { name: "官方地址带尾斜杠", model: anthropic("https://api.anthropic.com/"), role: "root", want: "long" },
    { name: "官方地址带路径", model: anthropic("https://api.anthropic.com/v1"), role: "root", want: "long" },
    { name: "官方地址大写主机", model: anthropic("https://API.Anthropic.com"), role: "root", want: "long" },
    { name: "anthropic-compatible 网关", model: anthropic(GATEWAY), role: "root", want: undefined },
    { name: "自建网关路径里带官方主机名", model: anthropic("https://proxy.example/api.anthropic.com"), role: "root", want: undefined },
    { name: "主机名后缀伪装", model: anthropic("https://api.anthropic.com.evil.example"), role: "root", want: undefined },
    { name: "主机名前缀伪装", model: anthropic("https://evilapi.anthropic.com"), role: "root", want: undefined },
    { name: "userinfo 伪装", model: anthropic("https://api.anthropic.com@evil.example"), role: "root", want: undefined },
    { name: "Anthropic 协议的国内厂商（Kimi / GLM / DeepSeek）", model: anthropic("https://api.moonshot.cn/anthropic"), role: "root", want: undefined },
    { name: "非 Anthropic 协议（即便地址是官方）", model: { api: "openai-responses", baseUrl: OFFICIAL }, role: "root", want: undefined },
    { name: "非 Anthropic 协议（OpenAI）", model: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, role: "root", want: undefined },
    { name: "Bedrock", model: { api: "bedrock-converse-stream", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" }, role: "root", want: undefined },
    { name: "空 baseUrl", model: anthropic(""), role: "root", want: undefined },
    { name: "非法 baseUrl", model: anthropic("api.anthropic.com"), role: "root", want: undefined },
  ];
  for (const c of cases) {
    test(`${c.name} → ${c.want ?? "不传"}`, () => {
      assert.equal(chooseCacheRetention(c.model, c.role), c.want);
    });
  }
});

/** 只捕获 options 的假 streamFn */
function fakeInner(captured: unknown[]): SessionStreamFn {
  const settled = Promise.resolve(null as unknown as Awaited<ReturnType<SessionStreamFn>>);
  return (_model, _context, options) => {
    captured.push(options);
    return settled;
  };
}
const fakeContext = { systemPrompt: "", messages: [] } as unknown as Parameters<SessionStreamFn>[1];
const officialModel = { id: "claude-sonnet-5-5", api: "anthropic-messages", baseUrl: OFFICIAL } as unknown as Parameters<SessionStreamFn>[0];
const gatewayModel = { id: "claude-sonnet-5-5", api: "anthropic-messages", baseUrl: GATEWAY } as unknown as Parameters<SessionStreamFn>[0];

describe("wrapStreamWithCacheRetention —— 包装层", () => {
  test("官方主会话、调用方没给：补 long，其余字段原样", async () => {
    const captured: unknown[] = [];
    await wrapStreamWithCacheRetention(fakeInner(captured), "root")(officialModel, fakeContext, { apiKey: "k", maxTokens: 9 });
    assert.deepEqual(captured.at(-1), { apiKey: "k", maxTokens: 9, cacheRetention: "long" });
  });

  test("options 整个缺席也补", async () => {
    const captured: unknown[] = [];
    await wrapStreamWithCacheRetention(fakeInner(captured), "root")(officialModel, fakeContext);
    assert.deepEqual(captured.at(-1), { cacheRetention: "long" });
  });

  test("调用方显式给了 none（pi 压缩 / 分支摘要）：原样保留", async () => {
    const captured: unknown[] = [];
    const given = { apiKey: "k", cacheRetention: "none" as const };
    await wrapStreamWithCacheRetention(fakeInner(captured), "root")(officialModel, fakeContext, given);
    assert.equal(captured.at(-1), given);
  });

  test("调用方显式给了 short：不改成 long", async () => {
    const captured: unknown[] = [];
    await wrapStreamWithCacheRetention(fakeInner(captured), "root")(officialModel, fakeContext, { cacheRetention: "short" });
    assert.deepEqual(captured.at(-1), { cacheRetention: "short" });
  });

  test("子会话 / 网关：options 逐字透传（同一个对象，不补字段）", async () => {
    const captured: unknown[] = [];
    const given = { apiKey: "k" };
    await wrapStreamWithCacheRetention(fakeInner(captured), "child")(officialModel, fakeContext, given);
    assert.equal(captured.at(-1), given);
    await wrapStreamWithCacheRetention(fakeInner(captured), "root")(gatewayModel, fakeContext, given);
    assert.equal(captured.at(-1), given);
  });

  test("按每次请求的 model 判：同一包装中途换到网关就不再补", async () => {
    const captured: unknown[] = [];
    const wrapped = wrapStreamWithCacheRetention(fakeInner(captured), "root");
    await wrapped(officialModel, fakeContext, {});
    await wrapped(gatewayModel, fakeContext, {});
    assert.deepEqual(captured, [{ cacheRetention: "long" }, {}]);
  });

  test("applyCacheRetentionPatch 换掉会话的 streamFunction 且生效", async () => {
    const captured: unknown[] = [];
    const inner = fakeInner(captured);
    const session = { agent: { streamFunction: inner } } as unknown as AgentSession;
    applyCacheRetentionPatch(session, "root");
    assert.notEqual(session.agent.streamFunction, inner);
    await session.agent.streamFunction(officialModel, fakeContext, {});
    assert.deepEqual(captured.at(-1), { cacheRetention: "long" });
  });
});

// ---- 端到端：到真正发出的 HTTP body ----

function claudeModel(provider: string, baseUrl: string): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    api: "anthropic-messages",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

const context: Context = {
  systemPrompt: "You are a test.",
  messages: [
    { role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic-messages",
      provider: "claude",
      model: "claude-sonnet-5-5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    },
    { role: "user", content: [{ type: "text", text: "second" }], timestamp: 0 },
  ],
  tools: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }],
};

interface WireBlock {
  cache_control?: unknown;
}
interface WireBody {
  tools?: WireBlock[];
  system?: WireBlock[];
  messages?: { content: string | WireBlock[] }[];
}

/** 假 fetch：截下请求 URL 与 body，然后当网络断开（pi 默认 maxRetries 0，不重试） */
function capturingFetch(captured: { url?: string; body?: WireBody }): FetchFunction {
  return async (input, init) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body)) as WireBody;
    throw new Error("offline (test)");
  };
}

/**
 * 按生产装配顺序走一遍：billing 包装在内、cacheRetention 包装在外（runtime openTurn 同序），
 * 最里层是真的 pi streamSimple。mainLoop 为真时模拟主循环（扩展注册的 onPayload = ccBillingPatch）。
 */
async function wireBody(
  model: Model<"anthropic-messages">,
  role: SessionRole,
  apiKey: string,
  extra: { cacheRetention?: "none"; mainLoop: boolean },
): Promise<WireBody> {
  const captured: { url?: string; body?: WireBody } = {};
  const fetch = capturingFetch(captured);
  // pi-agent-core 自带一份嵌套的 pi-ai（0.84.4），事件流类型与顶层 0.84.3 名义上不同；
  // 运行时 pi-coding-agent 走的是顶层 0.84.3（本测试同一份），这里只桥接类型
  const inner: SessionStreamFn = (m, ctx, options) =>
    streamSimple(m as Model<"anthropic-messages">, ctx, { ...options, fetch }) as unknown as ReturnType<SessionStreamFn>;
  const wrapped = wrapStreamWithCacheRetention(wrapStreamWithBilling(inner), role);
  const events = await wrapped(model, context, {
    apiKey,
    ...(extra.mainLoop ? { onPayload: (payload: unknown) => ccBillingPatch(payload) } : {}),
    ...(extra.cacheRetention !== undefined ? { cacheRetention: extra.cacheRetention } : {}),
  });
  for await (const _event of events) {
    // 排空到 error 事件
  }
  assert.ok(captured.body !== undefined, "假 fetch 没截到请求体");
  assert.ok(captured.url?.startsWith(model.baseUrl), `请求发去了意外的地址：${captured.url}`);
  return captured.body;
}

/** tools 最后一个、system 最后一个、最后一条消息的最后一块——pi 放 cache_control 的三处 */
function breakpoints(body: WireBody): unknown[] {
  const lastTool = body.tools?.at(-1);
  const lastSystem = body.system?.at(-1);
  const lastMessage = body.messages?.at(-1)?.content;
  const lastBlock = Array.isArray(lastMessage) ? lastMessage.at(-1) : undefined;
  return [lastTool?.cache_control, lastSystem?.cache_control, lastBlock?.cache_control];
}

/** 整个 body 里出现过的全部 cache_control */
function allCacheControls(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) allCacheControls(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "cache_control") out.push(child);
      else allCacheControls(child, out);
    }
  }
  return out;
}

const ONE_HOUR = { type: "ephemeral", ttl: "1h" };
const DEFAULT = { type: "ephemeral" };

describe("端到端：真正发出的请求体", () => {
  test("Claude 订阅 OAuth 主会话（主循环，过订阅改写）：三处断点都是 1h", async () => {
    const body = await wireBody(claudeModel("claude", OFFICIAL), "root", "sk-ant-oat01-fake", { mainLoop: true });
    // 确实走了 OAuth 分支 + 订阅改写：路由标打头、身份块已删
    const system = body.system as { text?: string }[];
    assert.match(system[0]?.text ?? "", /^x-anthropic-billing-header/);
    assert.ok(!system.some((block) => (block.text ?? "").includes("official CLI")));
    assert.deepEqual(breakpoints(body), [ONE_HOUR, ONE_HOUR, ONE_HOUR]);
    assert.ok(allCacheControls(body).every((cc) => JSON.stringify(cc) === JSON.stringify(ONE_HOUR)));
  });

  test("Anthropic 官方 API key 主会话：三处断点都是 1h", async () => {
    const body = await wireBody(claudeModel("anthropic", OFFICIAL), "root", "sk-ant-api03-fake", { mainLoop: true });
    assert.deepEqual(breakpoints(body), [ONE_HOUR, ONE_HOUR, ONE_HOUR]);
  });

  test("官方地址子会话：断点在，但没有 ttl（pi 默认 5 分钟）", async () => {
    const body = await wireBody(claudeModel("claude", OFFICIAL), "child", "sk-ant-oat01-fake", { mainLoop: true });
    assert.deepEqual(breakpoints(body), [DEFAULT, DEFAULT, DEFAULT]);
    assert.ok(allCacheControls(body).every((cc) => JSON.stringify(cc) === JSON.stringify(DEFAULT)));
  });

  test("anthropic-compatible 网关主会话：断点在，但没有 ttl", async () => {
    const body = await wireBody(claudeModel("anthropic-compatible", GATEWAY), "root", "sk-gateway-fake", { mainLoop: true });
    assert.deepEqual(breakpoints(body), [DEFAULT, DEFAULT, DEFAULT]);
    assert.ok(allCacheControls(body).every((cc) => JSON.stringify(cc) === JSON.stringify(DEFAULT)));
  });

  test("官方主会话的压缩摘要（pi 传 none、无 onPayload）：一个 cache_control 都没有", async () => {
    const body = await wireBody(claudeModel("claude", OFFICIAL), "root", "sk-ant-oat01-fake", {
      cacheRetention: "none",
      mainLoop: false,
    });
    assert.deepEqual(allCacheControls(body), []);
  });
});
