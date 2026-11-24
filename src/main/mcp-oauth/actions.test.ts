import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConnectorStatus } from "../../shared/connectors.ts";
import type { McpServer } from "../../shared/mcp.ts";
import type { McpOauthLoginResult } from "../../shared/mcp-oauth.ts";
import { disconnectConnector, loginMcpServer, type OauthActionDeps } from "./actions.ts";

function setup(over: { config?: Record<string, McpServer>; login?: McpOauthLoginResult; upsertFails?: boolean; reloadFails?: boolean; removeFails?: string } = {}) {
  const calls: string[] = [];
  const config: Record<string, McpServer> = { ...(over.config ?? {}) };
  const deps: OauthActionDeps = {
    oauth: {
      login: async (name, url) => {
        calls.push(`login ${name} ${url}`);
        return over.login ?? { ok: true, serverName: name };
      },
      logout: async (name) => {
        calls.push(`logout ${name}`);
        return { revoked: true };
      },
      cancel: (name) => calls.push(`cancel ${name}`),
    },
    store: {
      read: async () => config,
      upsert: async (name, server) => {
        calls.push(`upsert ${name}`);
        if (over.upsertFails === true) throw new Error("磁盘满了");
        config[name] = server;
      },
      remove: async (name) => {
        calls.push(`remove ${name}`);
        if (over.removeFails !== undefined) throw new Error(over.removeFails);
        if (!(name in config)) throw new Error(`No such server: ${name}`);
        delete config[name];
      },
    },
    reload: async () => {
      calls.push("reload");
      if (over.reloadFails === true) throw new Error("agent 不在");
    },
    probe: async (id): Promise<ConnectorStatus> => {
      calls.push(`probe ${id}`);
      return { kind: "unset", reason: "no-config" };
    },
  };
  return { deps, calls, config };
}

describe("loginMcpServer", () => {
  test("目录里的一家：用目录的地址登录；成功后写入「地址 + auth 标记」（不含任何凭据）并重连", async () => {
    const s = setup();
    assert.deepEqual(await loginMcpServer({ connectorId: "notion" }, s.deps), { ok: true, serverName: "notion" });
    assert.deepEqual(s.calls, ["login notion https://mcp.notion.com/mcp", "upsert notion", "reload"]);
    assert.deepEqual(s.config["notion"], { transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" });
  });

  test("目录里不是 OAuth 型的一家 / 不存在的 id：unsupported，什么都不做", async () => {
    for (const target of [{ connectorId: "github" as const }, { connectorId: "nope" as never }]) {
      const s = setup();
      const result = await loginMcpServer(target, s.deps);
      assert.equal(result.ok ? "" : result.code, "unsupported");
      assert.deepEqual(s.calls, []);
    }
  });

  test("mcp.json 里已有的一条（用户手写的远端）：保留它的其余字段（白名单、停用、请求头），只加 auth 标记", async () => {
    const s = setup({ config: { custom: { transport: "http", url: "https://mcp.example.com/mcp", workspaces: ["paper"], headers: { "X-Org": "1" } } } });
    assert.deepEqual(await loginMcpServer({ serverName: "custom" }, s.deps), { ok: true, serverName: "custom" });
    assert.deepEqual(s.calls[0], "login custom https://mcp.example.com/mcp");
    assert.deepEqual(s.config["custom"], { transport: "http", url: "https://mcp.example.com/mcp", workspaces: ["paper"], headers: { "X-Org": "1" }, auth: "oauth" });
  });

  test("不在全局 mcp.json 里的名字（含工作区自带的）、stdio 条目：unsupported，说明去哪改", async () => {
    const s = setup({ config: { local: { transport: "stdio", command: "node" } } });
    const missing = await loginMcpServer({ serverName: "ws-only" }, s.deps);
    assert.equal(missing.ok ? "" : missing.code, "unsupported");
    assert.match(missing.ok ? "" : missing.message, /\.mcp\.json/);
    const stdio = await loginMcpServer({ serverName: "local" }, s.deps);
    assert.equal(stdio.ok ? "" : stdio.code, "unsupported");
    assert.deepEqual(s.calls, []);
  });

  test("登录没成（取消 / 超时 / 拒绝）：原样带回，不写 mcp.json、不重连", async () => {
    const s = setup({ login: { ok: false, code: "cancelled", message: "登录已取消" } });
    assert.deepEqual(await loginMcpServer({ connectorId: "supabase" }, s.deps), { ok: false, code: "cancelled", message: "登录已取消" });
    assert.deepEqual(s.calls, ["login supabase https://mcp.supabase.com/mcp"]);
  });

  test("登录成功但写不进 mcp.json：failed 并说明；重连失败不算登录失败", async () => {
    const bad = setup({ upsertFails: true });
    const result = await loginMcpServer({ connectorId: "pangram" }, bad.deps);
    assert.equal(result.ok ? "" : result.code, "failed");
    assert.match(result.ok ? "" : result.message, /写不进 mcp\.json：磁盘满了/);
    assert.equal(bad.calls.includes("reload"), false);
    const flaky = setup({ reloadFails: true });
    assert.equal((await loginMcpServer({ connectorId: "pangram" }, flaky.deps)).ok, true);
  });
});

describe("disconnectConnector", () => {
  test("撤销 + 删凭据 + 移除 mcp.json 里的条目 + 重连 + 返回新实测", async () => {
    const s = setup({ config: { notion: { transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" } } });
    assert.deepEqual(await disconnectConnector("notion", s.deps), { kind: "unset", reason: "no-config" });
    assert.deepEqual(s.calls, ["logout notion", "remove notion", "reload", "probe notion"]);
    assert.deepEqual(s.config, {});
  });

  test("条目本来就不在（用户手动删过）：照常断开", async () => {
    const s = setup();
    assert.deepEqual(await disconnectConnector("notion", s.deps), { kind: "unset", reason: "no-config" });
  });

  test("删条目因别的原因失败：如实报 failed，不假装断开了", async () => {
    const s = setup({ removeFails: "EACCES" });
    const status = await disconnectConnector("notion", s.deps);
    assert.deepEqual(status, { kind: "failed", code: "error", message: "EACCES" });
    assert.equal(s.calls.includes("reload"), false);
  });

  test("不是 OAuth 型的卡不许断开（token 型有它自己的重新配置）", async () => {
    for (const id of ["tencent-docs", "github", "feishu", "nope"]) {
      const s = setup();
      const status = await disconnectConnector(id, s.deps);
      assert.equal(status.kind, "failed", id);
      assert.deepEqual(s.calls, [], id);
    }
  });
});
