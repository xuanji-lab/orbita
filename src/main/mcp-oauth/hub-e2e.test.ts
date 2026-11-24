/**
 * 整条链的端到端（不在进程边界上 mock）：McpHub（agent 进程里的连接）→ 鉴权 fetch 壳 → requestToken
 * （生产里是 agent→主进程的 mcpTokenRequest 往返，这里直连 manager）→ 授权服务器 / MCP 资源服务器（假 Notion）。
 * 验：带 Bearer 列工具与调用、到期前续期后新 token 上线、服务端把 access token 撤了（401）→ 强制续期重试一次、
 * refresh 也被撤了 → 「需要登录」而不是笼统的 401、没登录过 → 需要登录、手写的远端回 401 + Bearer 挑战 → 同样需要登录。
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpHub, probeRemoteMcp } from "../../agent/mcp.ts";
import type { McpServer } from "../../shared/mcp.ts";
import type { SecretsPort } from "../provider/store.ts";
import { McpOauthCredentialStore } from "./credential-store.ts";
import { McpOauthManager } from "./manager.ts";
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
let clock = 5_000_000;
let manager: McpOauthManager;
let hub: McpHub;

before(async () => {
  fixture = await startOauthFixture();
});
after(async () => {
  await fixture.close();
});
beforeEach(() => {
  clock = 5_000_000;
  fixture.log.mcpAuth.length = 0;
  fixture.log.tokenGrants.length = 0;
  manager = new McpOauthManager(new McpOauthCredentialStore(new MemorySecrets()), {
    openExternal: async (url) => {
      void fakeBrowser(url);
    },
    now: () => clock,
  });
  hub = new McpHub({ requestToken: (name, url, force) => manager.accessToken(name, url, force) });
});

const oauthServer = (): McpServer => ({ transport: "http", url: fixture.mcpUrl, auth: "oauth" });

async function callWhoami(): Promise<string> {
  const tool = hub.toolsFor("").find((t) => t.name === "mcp__notion__whoami");
  assert.ok(tool, "工具没列出来");
  const result = await tool.execute("id", {}, undefined, undefined, undefined as never);
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("OAuth 型远程 MCP 经 McpHub 连接", () => {
  test("登录后：带 Bearer 握手、列工具、调用；每个请求都带了当前 token", async () => {
    await manager.login("notion", fixture.mcpUrl);
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      assert.equal(hub.describe()[0]?.status.kind, "ready");
      const text = await callWhoami();
      assert.match(text, /^ok:at-/);
      assert.ok(fixture.log.mcpAuth.length >= 3);
      assert.ok(fixture.log.mcpAuth.every((header) => header?.startsWith("Bearer at-") === true));
    } finally {
      await hub.dispose();
    }
  });

  test("到期后的下一次请求用的是续期后的新 token（不是缓存在连接里的旧值）", async () => {
    await manager.login("notion", fixture.mcpUrl);
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      const before = await callWhoami();
      clock += 3600 * 1000; // 过了 1 小时，access token 到期
      const after = await callWhoami();
      assert.notEqual(after, before, "连接里不该写死 token");
      assert.equal(fixture.log.tokenGrants.filter((g) => g.grant === "refresh_token").length, 1);
    } finally {
      await hub.dispose();
    }
  });

  test("服务端把 access token 撤了（401）：强制续期、重试一次，调用照常成功", async () => {
    await manager.login("notion", fixture.mcpUrl);
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      fixture.revokeAccessTokens();
      assert.match(await callWhoami(), /^ok:at-/);
      assert.equal(fixture.log.tokenGrants.filter((g) => g.grant === "refresh_token").length, 1);
    } finally {
      await hub.dispose();
    }
  });

  test("access 与 refresh 都被撤了：调用报「登录已失效」（McpLoginRequiredError 的话），凭据被清", async () => {
    await manager.login("notion", fixture.mcpUrl);
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      fixture.revokeAccessTokens();
      fixture.revokeRefreshTokens();
      await assert.rejects(callWhoami(), /需要重新登录|登录已失效/);
      assert.equal(await manager.hasCredential("notion"), false);
    } finally {
      await hub.dispose();
    }
  });

  test("没登录过：状态是 failed + needsLogin，不发任何 MCP 请求", async () => {
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      const status = hub.describe()[0]?.status;
      assert.equal(status?.kind, "failed");
      assert.equal(status?.kind === "failed" ? status.needsLogin : undefined, true);
      assert.equal(fixture.log.mcpAuth.length, 0, "没有 token 就不该去敲服务端");
    } finally {
      await hub.dispose();
    }
  });

  test("手写的远端（没标 auth、没自带 Authorization）回 401 + Bearer 挑战：needsLogin，不是笼统的 HTTP 401", async () => {
    try {
      await hub.ensure("", { notion: { transport: "http", url: fixture.mcpUrl } }, "");
      const status = hub.describe()[0]?.status;
      assert.equal(status?.kind, "failed");
      assert.equal(status?.kind === "failed" ? status.needsLogin : undefined, true);
      assert.match(status?.kind === "failed" ? status.message : "", /要求登录/);
    } finally {
      await hub.dispose();
    }
  });

  test("自带了 Authorization 头（贴 token 的）被 401：是 token 无效，不是要登录", async () => {
    try {
      await hub.ensure("", { notion: { transport: "http", url: fixture.mcpUrl, headers: { Authorization: "Bearer wrong" } } }, "");
      const status = hub.describe()[0]?.status;
      assert.equal(status?.kind, "failed");
      assert.equal(status?.kind === "failed" ? status.needsLogin : undefined, undefined);
    } finally {
      await hub.dispose();
    }
  });

  test("登录之后再 ensure 同一份配置的 hub.reset()（= 主进程 reload）：重新连得上", async () => {
    try {
      await hub.ensure("", { notion: oauthServer() }, "");
      assert.equal(hub.describe()[0]?.status.kind, "failed");
      await manager.login("notion", fixture.mcpUrl);
      await hub.reset();
      await hub.ensure("", { notion: oauthServer() }, "");
      assert.equal(hub.describe()[0]?.status.kind, "ready");
    } finally {
      await hub.dispose();
    }
  });

  test("hub 没接 requestToken（auth: oauth）：一律 needsLogin，不会裸连", async () => {
    const bare = new McpHub();
    try {
      await bare.ensure("", { notion: oauthServer() }, "");
      const status = bare.describe()[0]?.status;
      assert.equal(status?.kind === "failed" ? status.needsLogin : undefined, true);
    } finally {
      await bare.dispose();
    }
  });
});

describe("probeRemoteMcp（连接目录的实测，跑在主进程）", () => {
  test("登录后：连上并数出工具；没登录：needsLogin", async () => {
    const probe = (): ReturnType<typeof probeRemoteMcp> =>
      probeRemoteMcp({ transport: "http", url: fixture.mcpUrl, auth: "oauth" }, undefined, {
        serverName: "notion",
        tokenSource: (force) => manager.accessToken("notion", fixture.mcpUrl, force),
      });
    assert.deepEqual(await probe(), { ok: false, message: "notion 还没有登录", needsLogin: true });
    await manager.login("notion", fixture.mcpUrl);
    assert.deepEqual(await probe(), { ok: true, tools: 1 });
  });

  test("手写远端回 401 + Bearer 挑战：needsLogin", async () => {
    const result = await probeRemoteMcp({ transport: "http", url: fixture.mcpUrl });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.needsLogin, true);
  });
});
