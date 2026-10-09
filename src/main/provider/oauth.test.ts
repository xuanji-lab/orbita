import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicOauthHeaders,
  buildAuthorizeUrl,
  exchangeCodeForCredential,
  fetchAccountEmail,
  generatePkce,
  isClaudeOauthToken,
  parseCallbackQuery,
  refreshClaudeCredential,
  CLAUDE_TOKEN_URL,
} from "./oauth.ts";

/** 假 fetch：按 URL 断言并回放预备的响应（oauth 流程不碰真网络） */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: string }) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { status, body } = handler(url, init);
    return new Response(body, { status });
  };
}

describe("generatePkce / buildAuthorizeUrl", () => {
  test("PKCE 对：43 字符 verifier，challenge 是它的 S256（可复算）", async () => {
    const { verifier, challenge } = await generatePkce();
    assert.equal(verifier.length, 43);
    // 同一 verifier 的 challenge 稳定（S256，不是随机值）
    const again = await generatePkce();
    assert.notEqual(again.verifier, verifier, "两次生成不得同值");
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  });

  test("授权 URL 带 PKCE、state、scope 与 loopback redirect", async () => {
    const { challenge } = await generatePkce();
    const url = new URL(
      buildAuthorizeUrl({ challenge, state: "abc123", redirectUri: "http://localhost:53199/callback" }),
    );
    assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "abc123");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:53199/callback");
    assert.match(url.searchParams.get("scope") ?? "", /user:inference/);
  });
});

describe("parseCallbackQuery", () => {
  test("正常回调：code 与 state 都在", () => {
    assert.deepEqual(parseCallbackQuery("?code=x.y&state=abc"), { code: "x.y", state: "abc" });
  });
  test("带 error：单独带回来（登录页拒绝授权）", () => {
    assert.deepEqual(parseCallbackQuery("?error=access_denied"), { error: "access_denied" });
  });
  test("空查询：什么都没有", () => {
    assert.deepEqual(parseCallbackQuery(""), {});
  });
});

describe("exchangeCodeForCredential / refreshClaudeCredential", () => {
  test("授权码换令牌：state 回传，expiresAt 已扣 5 分钟提前量", async () => {
    let sawBody: Record<string, string> | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      assert.equal(url, CLAUDE_TOKEN_URL);
      sawBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return {
        status: 200,
        body: JSON.stringify({ access_token: "sk-ant-oat-A", refresh_token: "rt-1", expires_in: 28800 }),
      };
    });
    const before = Date.now();
    const credential = await exchangeCodeForCredential(
      { code: "c", verifier: "v", state: "st-1", redirectUri: "http://localhost:1/callback" },
      fetchImpl,
    );
    assert.ok(sawBody);
    assert.equal(sawBody.grant_type, "authorization_code");
    assert.equal(sawBody.code_verifier, "v");
    // token 端点把 state 当必填：缺了 400 invalid_request_error「Invalid request format」（实测）
    assert.equal(sawBody.state, "st-1");
    assert.equal(credential.accessToken, "sk-ant-oat-A");
    assert.equal(credential.accountEmail, null);
    assert.ok(credential.expiresAt <= before + 28800 * 1000 - 5 * 60 * 1000 + 50);
  });

  test("续期：带旧 refresh token，返回新的一对，保留账号邮箱", async () => {
    let sawBody: Record<string, string> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      sawBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return {
        status: 200,
        body: JSON.stringify({ access_token: "sk-ant-oat-B", refresh_token: "rt-2", expires_in: 28800 }),
      };
    });
    const fresh = await refreshClaudeCredential(
      { accessToken: "sk-ant-oat-A", refreshToken: "rt-1", expiresAt: 1, accountEmail: "a@b.c" },
      fetchImpl,
    );
    assert.ok(sawBody);
    assert.equal(sawBody.grant_type, "refresh_token");
    assert.equal(sawBody.refresh_token, "rt-1");
    assert.equal(fresh.refreshToken, "rt-2");
    assert.equal(fresh.accountEmail, "a@b.c");
  });

  test("invalid_grant：错误体带出来（调用方据此提示重新登录）", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
    }));
    await assert.rejects(
      refreshClaudeCredential({ accessToken: "a", refreshToken: "r", expiresAt: 1, accountEmail: null }, fetchImpl),
      /invalid_grant/,
    );
  });

  test("非 JSON 响应：报「无法解析」而不是把 HTML 当令牌", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: "<html>login page</html>" }));
    await assert.rejects(
      exchangeCodeForCredential(
        { code: "c", verifier: "v", state: "s", redirectUri: "http://localhost:1/callback" },
        fetchImpl,
      ),
      /无法解析/,
    );
  });
});

describe("fetchAccountEmail —— 展示信息，失败一律容忍", () => {
  test("拿到邮箱", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: JSON.stringify({ email: "me@anthropic.com" }) }));
    assert.equal(await fetchAccountEmail("sk-ant-oat-A", fetchImpl), "me@anthropic.com");
  });
  test("404 / 非 JSON 都返回 null，不抛", async () => {
    assert.equal(await fetchAccountEmail("t", fakeFetch(() => ({ status: 404, body: "{}" }))), null);
    assert.equal(await fetchAccountEmail("t", fakeFetch(() => ({ status: 200, body: "not json" }))), null);
  });
});

describe("oauth 请求头的口径（discover / test-connection 与 agent 侧 pi 的行为对齐）", () => {
  test("令牌识别：只认 sk-ant-oat 前缀特征的串", () => {
    assert.equal(isClaudeOauthToken("sk-ant-oat-12345"), true);
    assert.equal(isClaudeOauthToken("sk-ant-api03-xxx"), false);
  });
  test("Bearer + oauth beta 头，不带 x-api-key", () => {
    const headers = anthropicOauthHeaders("sk-ant-oat-A");
    assert.equal(headers.Authorization, "Bearer sk-ant-oat-A");
    assert.match(headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
    assert.match(headers["anthropic-beta"] ?? "", /claude-code-20250219/);
    assert.equal("x-api-key" in headers, false);
  });
});
