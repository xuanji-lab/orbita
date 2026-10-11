/**
 * McpStore 读-改-写的账（4-2）：加删启停只动 `mcpServers[name]`，
 * 其它顶层键与键序原样保留；文件不在从空起步；坏 JSON 不许被悄悄重置。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore, readMcpConfigFile } from "./store.ts";

let dir = "";
let store: McpStore;
const file = (): string => join(dir, "mcp.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-mcp-store-"));
  store = new McpStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("McpStore 读-改-写", () => {
  test("文件不存在：add 从空起步并建出 mcpServers", async () => {
    await store.add("demo", { transport: "stdio", command: "node" });
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    assert.deepEqual(parsed.mcpServers, { demo: { transport: "stdio", command: "node" } });
  });

  // 2026-10-11 用户实测事故：agent 并发两次 add，后写的覆盖先写的。mutate 必须
  // 串行化——写路径的测试在 write-requests.test.ts（走 applyMcpWrite），这里直接打 store
  test("并发 add 两台：两台都在（读-改-写串行化）", async () => {
    await Promise.all([
      store.add("first", { transport: "http", url: "https://a.example/mcp" }),
      store.add("second", { transport: "stdio", command: "node" }),
    ]);
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["first", "second"]);
  });

  test("一次失败的 mutate 不拖死后续（重名抛错后排队的照常执行）", async () => {
    await store.add("dup", { transport: "stdio", command: "node" });
    await assert.rejects(
      () => store.add("dup", { transport: "stdio", command: "other" }),
      /already exists/,
    );
    await store.add("after-failure", { transport: "stdio", command: "node" });
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["after-failure", "dup"]);
    assert.deepEqual(parsed.mcpServers["dup"], { transport: "stdio", command: "node" });
  });

  test("只改 mcpServers[name]：其它顶层键与键序原样保留", async () => {
    await writeFile(
      file(),
      JSON.stringify({ custom: { keep: true }, mcpServers: { old: { transport: "stdio", command: "x" } } }),
      "utf8",
    );
    await store.add("new", { transport: "http", url: "https://x/y" });
    const raw = JSON.parse(await readFile(file(), "utf8"));
    assert.deepEqual(Object.keys(raw), ["custom", "mcpServers"]);
    assert.deepEqual(raw["custom"], { keep: true });
    assert.deepEqual(Object.keys(raw.mcpServers), ["old", "new"]);
  });

  test("重名拒绝，不覆盖已有配置", async () => {
    await store.add("dup", { transport: "stdio", command: "a" });
    await assert.rejects(store.add("dup", { transport: "stdio", command: "b" }), /already exists/);
    const after = (await store.read()).dup as { command?: string } | undefined;
    assert.equal(after?.command, "a");
  });

  test("remove 删掉那一条；不存在时抛错", async () => {
    await store.add("gone", { transport: "stdio", command: "x" });
    await store.remove("gone");
    assert.deepEqual(await store.read(), {});
    await assert.rejects(store.remove("never"), /No such server/);
  });

  test("setDisabled：true 落 disabled 字段；false 删字段保持文件干净", async () => {
    await store.add("toggle", { transport: "stdio", command: "x" });
    await store.setDisabled("toggle", true);
    const on = (await store.read()).toggle as { disabled?: boolean } | undefined;
    assert.equal(on?.disabled, true);
    await store.setDisabled("toggle", false);
    const off = (await store.read()).toggle as { disabled?: boolean } | undefined;
    assert.equal(off !== undefined && "disabled" in off, false);
    await assert.rejects(store.setDisabled("ghost", true), /No such server/);
  });

  // 写路径上把坏 JSON 悄悄重置成空，等于替用户删配置——必须抛
  test("坏 JSON 往上抛，不重置", async () => {
    await writeFile(file(), "{ 不是 JSON", "utf8");
    await assert.rejects(store.add("x", { transport: "stdio", command: "y" }), /SyntaxError|JSON/);
  });

  test("顶层没有 mcpServers 对象时报形状错，不瞎建", async () => {
    await writeFile(file(), JSON.stringify([1, 2, 3]), "utf8");
    await assert.rejects(store.add("x", { transport: "stdio", command: "y" }), /wrong shape/);
  });
});

/**
 * readMcpConfigFile：任意 MCP 配置文件的读法（全局 mcp.json 与工作区自带的
 * .mcp.json 同构）。语义与 McpStore.read 一致——不在 = 空，坏了 = 抛。
 */
describe("readMcpConfigFile", () => {
  test("文件不在返回空（工作区没自带配置是常态）", async () => {
    assert.deepEqual(await readMcpConfigFile(join(dir, ".mcp.json")), {});
  });

  test("正常解析，与全局同构（含 workspaces 白名单字段）", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "node", workspaces: ["paper3"] } } }),
      "utf8",
    );
    const parsed = await readMcpConfigFile(join(dir, ".mcp.json"));
    assert.deepEqual(parsed["demo"], {
      transport: "stdio",
      command: "node",
      workspaces: ["paper3"],
    });
  });

  test("坏 JSON 往上抛（调用方决定怎么报，不在这里伪装成空）", async () => {
    await writeFile(join(dir, ".mcp.json"), "{ 不是 JSON", "utf8");
    await assert.rejects(readMcpConfigFile(join(dir, ".mcp.json")), /SyntaxError|JSON/);
  });
});
