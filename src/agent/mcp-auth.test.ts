import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAuthFetch, isBearerChallenge, McpLoginRequiredError, type McpTokenSource } from "./mcp-auth.ts";

type Call = { url: string; authorization: string | null };

/** 假的底层 fetch：按顺序吐预设的响应，并记下每次带的 Authorization */
function scripted(responses: Response[]): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      const next = queue.shift();
      if (next === undefined) throw new Error("没有预设的响应了");
      return next;
    },
  };
}

const ok = (): Response => new Response("{}", { status: 200 });
const unauthorized = (challenge?: string): Response =>
  new Response("no", { status: 401, ...(challenge === undefined ? {} : { headers: { "WWW-Authenticate": challenge } }) });

function tokens(...values: string[]): { source: McpTokenSource; asked: boolean[] } {
  const asked: boolean[] = [];
  let i = 0;
  return {
    asked,
    source: async (force) => {
      asked.push(force);
      const value = values[Math.min(i, values.length - 1)] ?? "";
      i += 1;
      return { ok: true, accessToken: value };
    },
  };
}

describe("isBearerChallenge", () => {
  test("401 + Bearer 挑战（带或不带 resource_metadata）才算；200、403、Basic 挑战、没头的 401 不算", () => {
    assert.equal(isBearerChallenge(unauthorized('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"')), true);
    assert.equal(isBearerChallenge(unauthorized("Bearer realm=x")), true);
    assert.equal(isBearerChallenge(unauthorized('resource_metadata="https://x"')), true);
    assert.equal(isBearerChallenge(unauthorized("Basic realm=x")), false);
    assert.equal(isBearerChallenge(unauthorized()), false);
    assert.equal(isBearerChallenge(new Response("", { status: 403, headers: { "WWW-Authenticate": "Bearer" } })), false);
    assert.equal(isBearerChallenge(ok()), false);
  });
});

describe("OAuth 型（有 tokenSource）", () => {
  test("每个请求带 Bearer；成功就一次请求、一次取 token", async () => {
    const base = scripted([ok()]);
    const t = tokens("A");
    const fetch = createAuthFetch({ serverName: "n", tokenSource: t.source, hasStaticAuthorization: false, baseFetch: base.fetch });
    assert.equal((await fetch("https://x/mcp", { method: "POST", headers: { "content-type": "application/json" } })).status, 200);
    assert.deepEqual(base.calls, [{ url: "https://x/mcp", authorization: "Bearer A" }]);
    assert.deepEqual(t.asked, [false]);
  });

  test("原有请求头不丢（只加 Authorization，已有的同名头被替换）", async () => {
    let seen: Headers | undefined;
    const fetch = createAuthFetch({
      serverName: "n",
      tokenSource: tokens("A").source,
      hasStaticAuthorization: true,
      baseFetch: async (_input, init) => {
        seen = new Headers(init?.headers);
        return ok();
      },
    });
    await fetch("https://x/mcp", { headers: { Accept: "text/event-stream", Authorization: "static" } });
    assert.equal(seen?.get("accept"), "text/event-stream");
    assert.equal(seen?.get("authorization"), "Bearer A");
  });

  test("401 → 强制续期 → 换了新 token 重试一次 → 成功", async () => {
    const base = scripted([unauthorized(), ok()]);
    const t = tokens("OLD", "NEW");
    const fetch = createAuthFetch({ serverName: "n", tokenSource: t.source, hasStaticAuthorization: false, baseFetch: base.fetch });
    assert.equal((await fetch("https://x/mcp")).status, 200);
    assert.deepEqual(base.calls.map((c) => c.authorization), ["Bearer OLD", "Bearer NEW"]);
    assert.deepEqual(t.asked, [false, true]);
  });

  test("续期后还是同一个 token：不重试，抛 McpLoginRequiredError", async () => {
    const base = scripted([unauthorized()]);
    const fetch = createAuthFetch({ serverName: "n", tokenSource: tokens("SAME").source, hasStaticAuthorization: false, baseFetch: base.fetch });
    await assert.rejects(fetch("https://x/mcp"), McpLoginRequiredError);
    assert.equal(base.calls.length, 1);
  });

  test("重试后仍 401：McpLoginRequiredError，只重试这一次", async () => {
    const base = scripted([unauthorized(), unauthorized()]);
    const fetch = createAuthFetch({ serverName: "n", tokenSource: tokens("A", "B").source, hasStaticAuthorization: false, baseFetch: base.fetch });
    await assert.rejects(fetch("https://x/mcp"), McpLoginRequiredError);
    assert.equal(base.calls.length, 2);
  });

  test("主进程说 login-required：McpLoginRequiredError，根本不发请求；说 error：普通 Error（不冒充要登录）", async () => {
    const base = scripted([]);
    const required = createAuthFetch({
      serverName: "n",
      tokenSource: async () => ({ ok: false, code: "login-required", error: "n 还没有登录" }),
      hasStaticAuthorization: false,
      baseFetch: base.fetch,
    });
    await assert.rejects(required("https://x/mcp"), (error: unknown) => error instanceof McpLoginRequiredError && error.message === "n 还没有登录");
    const broken = createAuthFetch({
      serverName: "n",
      tokenSource: async () => ({ ok: false, code: "error", error: "续期失败：网络" }),
      hasStaticAuthorization: false,
      baseFetch: base.fetch,
    });
    await assert.rejects(broken("https://x/mcp"), (error: unknown) => error instanceof Error && !(error instanceof McpLoginRequiredError));
    assert.equal(base.calls.length, 0);
  });
});

describe("非 OAuth 型（没有 tokenSource）", () => {
  test("401 + Bearer 挑战、没自带 Authorization → 需要登录", async () => {
    const fetch = createAuthFetch({ serverName: "pangram", tokenSource: null, hasStaticAuthorization: false, baseFetch: scripted([unauthorized('Bearer resource_metadata="https://x"')]).fetch });
    await assert.rejects(fetch("https://x/mcp"), (error: unknown) => error instanceof McpLoginRequiredError && /pangram/.test(error.message));
  });

  test("自带了 Authorization（贴 token 的）→ 401 原样交回，不当成要登录", async () => {
    const fetch = createAuthFetch({ serverName: "n", tokenSource: null, hasStaticAuthorization: true, baseFetch: scripted([unauthorized("Bearer")]).fetch });
    assert.equal((await fetch("https://x/mcp")).status, 401);
  });

  test("普通 401（没有 Bearer 挑战，如百度网盘）与成功响应原样交回，也不动请求头", async () => {
    const base = scripted([unauthorized(), ok()]);
    const fetch = createAuthFetch({ serverName: "n", tokenSource: null, hasStaticAuthorization: false, baseFetch: base.fetch });
    assert.equal((await fetch("https://x/mcp", { headers: { a: "1" } })).status, 401);
    assert.equal((await fetch("https://x/mcp")).status, 200);
    assert.deepEqual(base.calls.map((c) => c.authorization), [null, null]);
  });
});
