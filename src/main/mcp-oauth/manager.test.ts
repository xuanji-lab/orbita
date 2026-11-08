/**
 * OAuth 客户端的端到端：对一台本机「假 Notion」（oauth-fixture-server.ts）走完
 * PRM → 授权服务器元数据 → 动态注册 → PKCE 授权码 → token → 续期（含 refresh token 轮换）→ 撤销。
 * 不 mock SDK 的 auth()：风险全在「我们和真实授权服务器握手对不对」。
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { SecretsPort } from "../provider/store.ts";
import { McpOauthCredentialStore } from "./credential-store.ts";
import { isSafeAuthorizationUrl, McpOauthManager, type McpOauthPorts } from "./manager.ts";
import { fakeBrowser, startOauthFixture, type OauthFixture } from "./oauth-fixture-server.ts";

class MemorySecrets implements SecretsPort {
  readonly data = new Map<string, string>();
  async set(account: string, plaintext: string): Promise<void> {
    this.data.set(account, plaintext);
  }
  async get(account: string): Promise<string | null> {
    return this.data.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.data.delete(account);
  }
}

let fixture: OauthFixture;
let secrets: MemorySecrets;
let clock = 1_000_000;
/** 浏览器收到的授权地址 */
let opened: string[] = [];

before(async () => {
  fixture = await startOauthFixture();
});
after(async () => {
  await fixture.close();
});
beforeEach(() => {
  secrets = new MemorySecrets();
  clock = 1_000_000;
  opened = [];
  fixture.log.registered.length = 0;
  fixture.log.authorize.length = 0;
  fixture.log.tokenGrants.length = 0;
  fixture.log.revoked.length = 0;
});

function manager(extra: Partial<McpOauthPorts> = {}): McpOauthManager {
  return new McpOauthManager(new McpOauthCredentialStore(secrets), {
    openExternal: async (url) => {
      opened.push(url);
      void fakeBrowser(url);
    },
    now: () => clock,
    ...extra,
  });
}

describe("登录：发现 → 动态注册 → PKCE 授权码 → token", () => {
  test("走完整条链，凭据按 server 名加密存、绑定登录时的地址", async () => {
    const result = await manager().login("notion", fixture.mcpUrl);
    assert.deepEqual(result, { ok: true, serverName: "notion" });
    // 动态注册：公共客户端 + 本次随机端口的 127.0.0.1 回调
    assert.equal(fixture.log.registered.length, 1);
    const registered = fixture.log.registered[0] as { redirect_uris: string[]; token_endpoint_auth_method: string };
    assert.match(registered.redirect_uris[0] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(registered.token_endpoint_auth_method, "none");
    // 授权地址：S256 + state + 注册的回调 + resource（RFC 8707）
    const query = fixture.log.authorize[0];
    assert.equal(query?.get("code_challenge_method"), "S256");
    assert.ok((query?.get("code_challenge") ?? "").length >= 43);
    assert.ok((query?.get("state") ?? "").length >= 32);
    assert.equal(query?.get("redirect_uri"), registered.redirect_uris[0]);
    assert.equal(query?.get("client_id"), "client-1");
    assert.equal(query?.get("resource"), fixture.mcpUrl);
    assert.equal(query?.get("response_type"), "code");
    // 凭据落盘
    const stored = JSON.parse(secrets.data.get("mcp-oauth:notion") ?? "{}") as { serverUrl: string; tokens: { access_token: string; refresh_token?: string }; expiresAt: number; revocationEndpoint: string };
    assert.equal(stored.serverUrl, fixture.mcpUrl);
    assert.match(stored.tokens.access_token, /^at-/);
    assert.match(stored.tokens.refresh_token ?? "", /^rt-/);
    assert.equal(stored.expiresAt, clock + 3600 * 1000);
    assert.equal(stored.revocationEndpoint, `${fixture.base}/revoke`);
  });

  test("授权码换 token 时带着 code_verifier，且它的 S256 就是授权请求里的 challenge", async () => {
    await manager().login("notion", fixture.mcpUrl);
    const grant = fixture.log.tokenGrants.find((g) => g.grant === "authorization_code");
    const verifier = grant?.body.get("code_verifier") ?? "";
    assert.ok(verifier.length >= 43);
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), fixture.log.authorize[0]?.get("code_challenge"));
  });

  test("每次登录都重新注册（回调端口每次不同）；同一台登录中的重复调用并入同一次", async () => {
    const m = manager();
    const [a, b] = await Promise.all([m.login("notion", fixture.mcpUrl), m.login("notion", fixture.mcpUrl)]);
    assert.deepEqual(a, b);
    assert.equal(opened.length, 1, "不该开两个浏览器页");
    assert.equal(fixture.log.registered.length, 1);
    assert.equal(m.isLoggingIn("notion"), false);
    await m.login("notion", fixture.mcpUrl);
    assert.equal(fixture.log.registered.length, 2);
  });

  test("回调的 state 不对：被忽略、继续等；之后对的那次才算", async () => {
    const m = manager({
      openExternal: async (url) => {
        opened.push(url);
        void (async () => {
          // 先有人拿错的 state 打回调，再是真浏览器
          const first = await fetch(url, { redirect: "manual" });
          const back = new URL(first.headers.get("location") ?? "");
          const forged = new URL(back);
          forged.searchParams.set("state", "forged");
          assert.equal((await fetch(forged)).status, 400);
          await fetch(back);
        })();
      },
    });
    assert.deepEqual(await m.login("notion", fixture.mcpUrl), { ok: true, serverName: "notion" });
  });

  test("别的本机进程往回调地址发 ?error=x（没有正确 state）取消不了登录", async () => {
    const m = manager({
      openExternal: async (url) => {
        opened.push(url);
        void (async () => {
          const first = await fetch(url, { redirect: "manual" });
          const back = new URL(first.headers.get("location") ?? "");
          const attack = new URL(back);
          attack.search = "?error=access_denied";
          assert.equal((await fetch(attack)).status, 400);
          await fetch(back);
        })();
      },
    });
    assert.deepEqual(await m.login("notion", fixture.mcpUrl), { ok: true, serverName: "notion" });
  });

  test("授权页回 access_denied（带对的 state）：denied，不存凭据", async () => {
    const m = manager({
      openExternal: async (url) => {
        void fakeBrowser(url, (cb) => {
          const denied = new URL(cb);
          denied.searchParams.delete("code");
          denied.searchParams.set("error", "access_denied");
          denied.searchParams.set("error_description", "用户拒绝了");
          return denied;
        });
      },
    });
    const result = await m.login("notion", fixture.mcpUrl);
    assert.deepEqual(result, { ok: false, code: "denied", message: "用户拒绝了" });
    assert.equal(secrets.data.size, 0);
  });

  test("时限内浏览器没回来：timeout，回调服务器关掉", async () => {
    const m = manager({ openExternal: async () => undefined, loginTimeoutMs: 80 });
    const result = await m.login("notion", fixture.mcpUrl);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.code, "timeout");
    assert.equal(m.isLoggingIn("notion"), false);
  });

  test("用户取消：cancelled；取消后能立刻重新登录", async () => {
    let first = true;
    const m = manager({
      openExternal: async (url) => {
        opened.push(url);
        if (first) {
          first = false;
          return; // 第一次浏览器没人理
        }
        void fakeBrowser(url);
      },
    });
    const pending = m.login("notion", fixture.mcpUrl);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(m.isLoggingIn("notion"), true);
    m.cancel("notion");
    const cancelled = await pending;
    assert.equal(cancelled.ok ? "" : cancelled.code, "cancelled");
    assert.deepEqual(await m.login("notion", fixture.mcpUrl), { ok: true, serverName: "notion" });
  });

  test("本机回调端口被占：failed，说清楚是回调起不来", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const result = await manager({ callbackPort: port }).login("notion", fixture.mcpUrl);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "failed");
      assert.match(result.ok ? "" : result.message, /本机开启登录回调/);
      assert.equal(opened.length, 0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("服务端不支持动态注册：discovery 失败，不开浏览器", async () => {
    const strict = await startOauthFixture({ noRegistration: true });
    try {
      const result = await manager().login("x", strict.mcpUrl);
      assert.equal(result.ok ? "" : result.code, "discovery");
      assert.match(result.ok ? "" : result.message, /dynamic client registration/i);
      assert.equal(opened.length, 0);
    } finally {
      await strict.close();
    }
  });

  test("授权端点是危险协议（远端元数据塞的）：拒绝打开浏览器", async () => {
    const evil = await startOauthFixture({ authorizeEndpoint: "file:///etc/passwd" });
    try {
      const result = await manager().login("x", evil.mcpUrl);
      assert.equal(result.ok, false);
      assert.equal(opened.length, 0, "不许把 file: 地址交给系统打开");
    } finally {
      await evil.close();
    }
  });

  test("MCP 地址不是 https（也不是本机）：unsupported，根本不发请求", async () => {
    const result = await manager().login("x", "http://example.com/mcp");
    assert.equal(result.ok ? "" : result.code, "unsupported");
    assert.equal(fixture.log.registered.length, 0);
  });

  test("isSafeAuthorizationUrl：https 与本机 http 放行，其余拒绝", () => {
    assert.equal(isSafeAuthorizationUrl(new URL("https://a.com/authorize")), true);
    assert.equal(isSafeAuthorizationUrl(new URL("http://127.0.0.1:1/x")), true);
    assert.equal(isSafeAuthorizationUrl(new URL("http://evil.com/x")), false);
    assert.equal(isSafeAuthorizationUrl(new URL("file:///etc/passwd")), false);
    assert.equal(isSafeAuthorizationUrl(new URL("javascript:alert(1)")), false);
  });
});

describe("accessToken：绑定地址、到期前续期、轮换落盘", () => {
  test("没登录过：login-required", async () => {
    assert.deepEqual(await manager().accessToken("notion", fixture.mcpUrl, false), { ok: false, code: "login-required", error: "notion 还没有登录" });
  });

  test("地址与登录时不同：不给 token（凭据不跟着改过的地址走）", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    const other = await m.accessToken("notion", "https://evil.example.com/mcp", false);
    assert.equal(other.ok, false);
    assert.equal(other.ok ? "" : other.code, "login-required");
    assert.match(other.ok ? "" : other.error, /地址与登录时不同/);
    assert.equal((await m.accessToken("notion", `${fixture.mcpUrl}/`, false)).ok, true, "末尾斜杠不算不同");
  });

  test("没到期：直接给，不碰授权服务器", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    const before = fixture.log.tokenGrants.length;
    const token = await m.accessToken("notion", fixture.mcpUrl, false);
    assert.equal(token.ok, true);
    assert.equal(fixture.log.tokenGrants.length, before);
  });

  test("快到期：先续期；refresh token 被轮换，新的一对立刻落盘", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    const oldStored = JSON.parse(secrets.data.get("mcp-oauth:notion") ?? "{}") as { tokens: { access_token: string; refresh_token: string } };
    clock += 3600 * 1000 - 30_000; // 离失效不到 1 分钟
    const token = await m.accessToken("notion", fixture.mcpUrl, false);
    assert.equal(token.ok, true);
    const grants = fixture.log.tokenGrants.filter((g) => g.grant === "refresh_token");
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.body.get("refresh_token"), oldStored.tokens.refresh_token);
    const stored = JSON.parse(secrets.data.get("mcp-oauth:notion") ?? "{}") as { tokens: { access_token: string; refresh_token: string }; expiresAt: number };
    assert.notEqual(stored.tokens.access_token, oldStored.tokens.access_token);
    assert.notEqual(stored.tokens.refresh_token, oldStored.tokens.refresh_token, "轮换后的新 refresh token 必须落盘");
    assert.equal(token.ok ? token.accessToken : "", stored.tokens.access_token);
    assert.equal(stored.expiresAt, clock + 3600 * 1000);
    // 再要一次：用新的，不再续期
    await m.accessToken("notion", fixture.mcpUrl, false);
    assert.equal(fixture.log.tokenGrants.filter((g) => g.grant === "refresh_token").length, 1);
  });

  test("并发要 token：续期合并成一次（否则两路拿同一个旧 refresh token，后到的 invalid_grant）", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    clock += 3600 * 1000;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => m.accessToken("notion", fixture.mcpUrl, false)));
    assert.ok(results.every((r) => r.ok));
    assert.equal(new Set(results.map((r) => (r.ok ? r.accessToken : ""))).size, 1);
    assert.equal(fixture.log.tokenGrants.filter((g) => g.grant === "refresh_token").length, 1);
  });

  test("forceRefresh（刚被 401）：没到期也续", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    const first = await m.accessToken("notion", fixture.mcpUrl, false);
    const forced = await m.accessToken("notion", fixture.mcpUrl, true);
    assert.equal(forced.ok, true);
    assert.notEqual(forced.ok ? forced.accessToken : "", first.ok ? first.accessToken : "");
  });

  test("续期被拒（refresh token 已撤销）：login-required，并删掉没用的凭据", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    fixture.revokeRefreshTokens();
    clock += 3600 * 1000;
    const token = await m.accessToken("notion", fixture.mcpUrl, false);
    assert.equal(token.ok, false);
    assert.equal(token.ok ? "" : token.code, "login-required");
    assert.equal(secrets.data.has("mcp-oauth:notion"), false);
    // 续期没有弹浏览器
    assert.equal(opened.length, 1);
  });

  test("续期时授权服务器连不上：error，凭据原样留着（下次再试）", async () => {
    const brief = await startOauthFixture();
    const m = manager();
    await m.login("notion", brief.mcpUrl);
    await brief.close();
    clock += 3600 * 1000;
    const token = await m.accessToken("notion", brief.mcpUrl, false);
    assert.equal(token.ok, false);
    assert.equal(token.ok ? "" : token.code, "error");
    assert.equal(secrets.data.has("mcp-oauth:notion"), true);
  });

  test("服务端没发 refresh token：到期后只能重新登录", async () => {
    const plain = await startOauthFixture({ noRefreshToken: true });
    try {
      const m = manager();
      await m.login("notion", plain.mcpUrl);
      clock += 3600 * 1000;
      const token = await m.accessToken("notion", plain.mcpUrl, false);
      assert.equal(token.ok ? "" : token.code, "login-required");
    } finally {
      await plain.close();
    }
  });

  test("密文解不开 / 形状不对：当作没登录过，不抛", async () => {
    secrets.data.set("mcp-oauth:notion", "not json");
    assert.equal((await manager().accessToken("notion", fixture.mcpUrl, false)).ok, false);
    secrets.data.set("mcp-oauth:notion", JSON.stringify({ serverUrl: 1 }));
    assert.equal((await manager().accessToken("notion", fixture.mcpUrl, false)).ok, false);
  });
});

describe("断开", () => {
  test("调撤销端点（带 refresh token）并删本机凭据", async () => {
    const m = manager();
    await m.login("notion", fixture.mcpUrl);
    const stored = JSON.parse(secrets.data.get("mcp-oauth:notion") ?? "{}") as { tokens: { refresh_token: string } };
    assert.deepEqual(await m.logout("notion"), { revoked: true });
    assert.equal(fixture.log.revoked[0]?.get("token"), stored.tokens.refresh_token);
    assert.equal(fixture.log.revoked[0]?.get("token_type_hint"), "refresh_token");
    assert.equal(secrets.data.size, 0);
    assert.equal((await m.accessToken("notion", fixture.mcpUrl, false)).ok, false);
  });

  test("撤销端点连不上：仍然删本机凭据（断开的保证是本机删除）", async () => {
    const gone = await startOauthFixture();
    const m = manager();
    await m.login("notion", gone.mcpUrl);
    await gone.close();
    assert.deepEqual(await m.logout("notion"), { revoked: false });
    assert.equal(secrets.data.size, 0);
  });

  test("没登录过也能断开（空操作）", async () => {
    assert.deepEqual(await manager().logout("nope"), { revoked: false });
  });
});
