import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConnectorStatus } from "../../shared/connectors.ts";
import { McpStore } from "../mcp/store.ts";
import { saveConnectorToken } from "./save-token.ts";

let dir = "";
let store: McpStore;
const connected: ConnectorStatus = { kind: "connected", by: "mcp", tools: 4 };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-token-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fresh(initial?: unknown): Promise<void> {
  const caseDir = join(dir, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(caseDir, { recursive: true });
  store = new McpStore(caseDir);
  if (initial !== undefined) await writeFile(store.path(), JSON.stringify(initial));
}

const read = async (): Promise<{ mcpServers: Record<string, unknown> } & Record<string, unknown>> => JSON.parse(await readFile(store.path(), "utf8"));

function deps(over: { probe?: ConnectorStatus; reload?: () => Promise<void> } = {}) {
  const calls = { reload: 0, probe: 0 };
  return {
    calls,
    deps: {
      store,
      reload: () => {
        calls.reload += 1;
        return over.reload?.() ?? Promise.resolve();
      },
      probe: () => {
        calls.probe += 1;
        return Promise.resolve(over.probe ?? connected);
      },
    },
  };
}

describe("保存 token", () => {
  test("腾讯文档：原样 token 写成 http 条目、重连、再实测一次并把状态带回", async () => {
    await fresh();
    const { deps: d, calls } = deps();
    const result = await saveConnectorToken("tencent-docs", "  secret-token  ", d);
    assert.deepEqual(result, { ok: true, status: connected });
    assert.deepEqual((await read()).mcpServers["tencent-docs"], { transport: "http", url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: "secret-token" } });
    assert.deepEqual(calls, { reload: 1, probe: 1 });
  });

  test("百度网盘：Bearer + sse；连 Bearer 一起贴也只留一个", async () => {
    await fresh();
    await saveConnectorToken("baidu-netdisk", "Bearer abc.def", deps().deps);
    assert.deepEqual((await read()).mcpServers["baidu-netdisk"], { transport: "sse", url: "https://mcp-pan.baidu.com/sse", headers: { Authorization: "Bearer abc.def" } });
  });

  test("重新贴 token：替换旧条目并清掉停用标记，其它 server 与顶层键原样保留", async () => {
    await fresh({ keep: 1, mcpServers: { other: { transport: "stdio", command: "x" }, "tencent-docs": { transport: "http", url: "https://old", headers: { Authorization: "old" }, disabled: true } } });
    const result = await saveConnectorToken("tencent-docs", "new", deps().deps);
    assert.equal(result.ok, true);
    const file = await read();
    assert.equal(file["keep"], 1);
    assert.deepEqual(file.mcpServers["other"], { transport: "stdio", command: "x" });
    assert.deepEqual(file.mcpServers["tencent-docs"], { transport: "http", url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: "new" } });
  });

  test("校验不过（空、含空白换行、超长）：不写盘、不重连、不探测", async () => {
    await fresh();
    for (const [token, code] of [["", "empty"], ["   ", "empty"], ["a b", "invalid"], ["x\r\nHost: evil", "invalid"], ["a".repeat(5000), "too-long"]] as const) {
      const { deps: d, calls } = deps();
      assert.deepEqual(await saveConnectorToken("tencent-docs", token, d), { ok: false, code, message: code });
      assert.deepEqual(calls, { reload: 0, probe: 0 });
    }
    await assert.rejects(readFile(store.path(), "utf8"), "校验不过不该创建文件");
  });

  test("不是 token 型 / 不认识的 id：unsupported，不写盘", async () => {
    await fresh();
    for (const id of ["feishu", "ctrip", "notion", "tabbit", "nope", "__proto__"]) {
      const result = await saveConnectorToken(id, "tok", deps().deps);
      assert.equal(result.ok, false, id);
      if (!result.ok) assert.equal(result.code, "unsupported", id);
    }
    await assert.rejects(readFile(store.path(), "utf8"));
  });

  test("重连失败不算保存失败（配置已在）；实测失败如实带回 failed，条目留着", async () => {
    await fresh();
    const failed: ConnectorStatus = { kind: "failed", code: "mcp", message: "401" };
    const { deps: d } = deps({ reload: () => Promise.reject(new Error("agent down")), probe: failed });
    const result = await saveConnectorToken("tencent-docs", "tok", d);
    assert.deepEqual(result, { ok: true, status: failed });
    assert.ok((await read()).mcpServers["tencent-docs"]);
  });

  test("写盘失败（mcp.json 形状不对）以数据返回，错误里不含 token", async () => {
    await fresh({ mcpServers: [] });
    const { deps: d, calls } = deps();
    const result = await saveConnectorToken("tencent-docs", "super-secret-token", d);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "write-failed");
      assert.ok(!result.message.includes("super-secret-token"));
    }
    assert.deepEqual(calls, { reload: 0, probe: 0 });
  });

  test("并发保存两家不互相覆盖（沿用 McpStore 的串行化）", async () => {
    await fresh();
    await Promise.all([saveConnectorToken("tencent-docs", "a", deps().deps), saveConnectorToken("baidu-netdisk", "b", deps().deps)]);
    assert.deepEqual(Object.keys((await read()).mcpServers).sort(), ["baidu-netdisk", "tencent-docs"]);
  });
});
