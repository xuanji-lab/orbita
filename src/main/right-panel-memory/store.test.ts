import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RIGHT_PANEL_MEMORY_MAX_ENTRIES } from "../../shared/right-panel-memory.ts";
import { RightPanelMemoryStore } from "./store.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpm-"));
  dirs.push(dir);
  return join(dir, "right-panel-memory.json");
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RightPanelMemoryStore", () => {
  it("文件不在 / 坏了：load 回 null", async () => {
    const file = await scratch();
    strictEqual(await new RightPanelMemoryStore(file).load(), null);
    await writeFile(file, "{not json");
    strictEqual(await new RightPanelMemoryStore(file).load(), null);
    await writeFile(file, JSON.stringify({ version: 2, entries: [] }));
    strictEqual(await new RightPanelMemoryStore(file).load(), null);
  });

  it("save 后落盘；新实例读回同一份", async () => {
    const file = await scratch();
    const body = { version: 1, entries: [{ id: "a", panel: "plugins", sub: { selected: "x" } }] };
    await new RightPanelMemoryStore(file).save(body);
    deepStrictEqual(JSON.parse(await readFile(file, "utf8")), body);
    deepStrictEqual(await new RightPanelMemoryStore(file).load(), body);
  });

  it("连着 save 两次：后到的一份最后落盘", async () => {
    const file = await scratch();
    const store = new RightPanelMemoryStore(file);
    await Promise.all([store.save({ version: 1, entries: [1] }), store.save({ version: 1, entries: [2] })]);
    deepStrictEqual((await store.load())?.entries, [2]);
  });

  it("信封不对 / 体积超限：save 抛，且不动已有文件", async () => {
    const file = await scratch();
    const store = new RightPanelMemoryStore(file);
    await store.save({ version: 1, entries: ["keep"] });
    await rejects(store.save({ version: 1 }));
    await rejects(store.save([]));
    await rejects(store.save({ version: 1, entries: ["x".repeat(1_100_000)] }));
    deepStrictEqual((await store.load())?.entries, ["keep"]);
  });

  it("条数超上限：只留最新的（数组末尾）", async () => {
    const file = await scratch();
    const store = new RightPanelMemoryStore(file);
    const entries = Array.from({ length: RIGHT_PANEL_MEMORY_MAX_ENTRIES + 3 }, (_, index) => index);
    await store.save({ version: 1, entries });
    const back = (await store.load())?.entries ?? [];
    strictEqual(back.length, RIGHT_PANEL_MEMORY_MAX_ENTRIES);
    strictEqual(back[0], 3);
    strictEqual(back[back.length - 1], RIGHT_PANEL_MEMORY_MAX_ENTRIES + 2);
  });
});
