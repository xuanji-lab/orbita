import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./store.ts";

let dir = "";
let store: WorkspaceStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-workspace-"));
  store = new WorkspaceStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  test("全新安装：一个工作区都没有", async () => {
    assert.deepEqual(await store.list(), []);
  });

  // 读不了 ≠ 没有：吞成空列表会让用户以为工作区全没了（D-3 真实教训）
  test("文件读不了就抛错，不吞成空列表", async () => {
    // 用同名目录顶替文件——readFile 打在目录上必炸，且不是 ENOENT
    await mkdir(join(dir, "workspaces.json"));
    await assert.rejects(() => store.list());
  });

  test("加一个，名字默认取路径末段", async () => {
    const added = await store.add("/Users/wafo/repo/orbita-lab");
    assert.equal(added.name, "orbita-lab");
    assert.equal(added.path, "/Users/wafo/repo/orbita-lab");
    assert.notEqual(added.id, "");
    assert.deepEqual((await new WorkspaceStore(dir).list()).map((w) => w.path), [added.path]);
  });

  // 同一个文件夹加两次应该还是一条，否则侧栏会出现两个同名工作区
  test("同一路径重复加返回已有的那条，不新建", async () => {
    const first = await store.add("/repo/x");
    const second = await store.add("/repo/x");
    assert.equal(first.id, second.id);
    assert.equal((await store.list()).length, 1);
  });

  test("改名落盘，id 不变", async () => {
    const added = await store.add("/repo/x");
    await store.rename(added.id, "  我的项目  ");
    const [after] = await new WorkspaceStore(dir).list();
    assert.equal(after?.name, "我的项目");
    assert.equal(after?.id, added.id);
  });

  test("改成空名字退回路径末段，不留一行看不见的东西", async () => {
    const added = await store.add("/repo/orbita-lab");
    await store.rename(added.id, "   ");
    assert.equal((await store.list())[0]?.name, "orbita-lab");
  });

  test("移除只是从列表里拿掉", async () => {
    const a = await store.add("/repo/a");
    await store.add("/repo/b");
    await store.remove(a.id);
    assert.deepEqual((await new WorkspaceStore(dir).list()).map((w) => w.path), ["/repo/b"]);
  });

  /**
   * v1 只有一个工作区、存的是路径。迁移要给它铸一个 id、取末段当名字。
   * 这条是真实数据：wafo 磁盘上就是 `{"version":1,"current":"/…/orbita-lab"}`。
   */
  test("从 v1 的 workspace.json 迁移过来", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspace.json"),
      JSON.stringify({ version: 1, current: "/Users/wafo/Documents/repo/orbita-lab" }),
      "utf8",
    );
    const [migrated] = await new WorkspaceStore(dir).list();
    assert.equal(migrated?.name, "orbita-lab");
    assert.equal(migrated?.path, "/Users/wafo/Documents/repo/orbita-lab");
    assert.notEqual(migrated?.id, undefined);
    // 迁完要落盘，下次不必再迁一遍
    assert.equal((await readdir(dir)).includes("workspaces.json"), true);
  });

  test("迁移不删旧文件——重写不回去了，留着那份 v1 是唯一能回头看的东西", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.json"), JSON.stringify({ version: 1, current: "/repo/x" }));
    await new WorkspaceStore(dir).list();
    assert.equal((await readdir(dir)).includes("workspace.json"), true);
  });

  test("v1 里是空路径就当没有工作区", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.json"), JSON.stringify({ version: 1, current: "" }));
    assert.deepEqual(await new WorkspaceStore(dir).list(), []);
  });

  test("坏掉的一条跳过，不让它挡住整张列表", async () => {
    const good = await store.add("/repo/good");
    const raw = JSON.parse(await readFile(join(dir, "workspaces.json"), "utf8")) as {
      workspaces: unknown[];
    };
    raw.workspaces.push({ name: "没有 id 和 path" });
    await writeFile(join(dir, "workspaces.json"), JSON.stringify(raw), "utf8");
    assert.deepEqual((await new WorkspaceStore(dir).list()).map((w) => w.id), [good.id]);
  });

  // 2026-09-03（D-3）改语义：文件坏了照抛，与 provider store 同一条规矩——
  // 「坏文件 → 空列表」会让用户以为工作区全没了，静默吞掉的正是这一刀要杀的东西
  test("整个文件坏了就抛错，不静默清空", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspaces.json"), "{ 这不是 JSON", "utf8");
    await assert.rejects(() => new WorkspaceStore(dir).list());
  });

  test("原子写不留临时文件", async () => {
    await store.add("/repo/a");
    await store.add("/repo/b");
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
  });

  test("默认路径是 home——UI 上那个「Home」和它必须是同一个值", async () => {
    assert.equal(WorkspaceStore.defaultPath(), (await import("node:os")).homedir());
  });
});
