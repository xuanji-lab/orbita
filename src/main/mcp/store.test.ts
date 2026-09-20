/**
 * McpStore 读-改-写的账（4-2）：加删启停只动 `mcpServers[name]`，
 * 其它顶层键与键序原样保留；文件不在从空起步；坏 JSON 不许被悄悄重置。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore } from "./store.ts";

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
