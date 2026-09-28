import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises";
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

  // 真正的代价在这里：损坏只是「读不懂」，被覆盖才是「真的没了」
  test("文件坏了不会被下一次 add 覆盖掉——原文还在，能手工救", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspaces.json"), "{ 这不是 JSON", "utf8");
    await assert.rejects(() => new WorkspaceStore(dir).add("/repo/new"));
    assert.equal(await readFile(join(dir, "workspaces.json"), "utf8"), "{ 这不是 JSON");
  });

  // 合法 JSON 但结构不对（手改坏了，或未来的 v3 格式）也是「读不懂」，同样不能被覆写
  test("结构不对的文件不当成空列表", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({ version: 3, folders: [] }),
      "utf8",
    );
    await assert.rejects(() => new WorkspaceStore(dir).list());
  });

  // v1 只是迁移来源，它坏了不该拦住一个全新开始的用户
  test("v1 旧文件坏了不拦路，当作没有工作区", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.json"), "{ 这不是 JSON", "utf8");
    assert.deepEqual(await new WorkspaceStore(dir).list(), []);
  });

  test("原子写不留临时文件", async () => {
    await store.add("/repo/a");
    await store.add("/repo/b");
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
  });

  test("默认路径是 Orbita 根下的 Home——UI 上那个「Home」和它必须是同一个值", async () => {
    const store2 = new WorkspaceStore(dir, join(dir, "Orbita"));
    assert.equal(store2.defaultPath(), join(dir, "Orbita", "Home"));
  });

  test("ensureHome 幂等：调两次不炸，Home 目录真实存在", async () => {
    const root = join(dir, "Orbita");
    const home = new WorkspaceStore(dir, root);
    await home.ensureHome();
    await home.ensureHome();
    assert.equal((await stat(join(root, "Home"))).isDirectory(), true);
  });

  // 命名新建（2026-09-22）：名字就是目录名，建在 ~/Orbita 根下
  test("create 建目录并入列表，名字就是用户给的名字", async () => {
    const root = join(dir, "Orbita");
    const s = new WorkspaceStore(dir, root);
    const created = await s.create("意图系统");
    assert.equal(created.name, "意图系统");
    assert.equal(created.path, join(root, "意图系统"));
    assert.equal((await stat(join(root, "意图系统"))).isDirectory(), true);
    assert.deepEqual((await s.list()).map((w) => w.path), [join(root, "意图系统")]);
  });

  test("名字先 trim 再当目录名，目录名与工作区名永远一致", async () => {
    const root = join(dir, "Orbita");
    const s = new WorkspaceStore(dir, root);
    const created = await s.create("  我的项目  ");
    assert.equal(created.name, "我的项目");
    assert.equal(created.path, join(root, "我的项目"));
  });

  test("同名再 create 返回同一条，不重复", async () => {
    const s = new WorkspaceStore(dir, join(dir, "Orbita"));
    const first = await s.create("意图系统");
    const second = await s.create("意图系统");
    assert.equal(second.id, first.id);
    assert.equal((await s.list()).length, 1);
  });

  test("同名文件夹已存在（用户手动建的）就直接加它，不覆盖不报错", async () => {
    const root = join(dir, "Orbita");
    await mkdir(join(root, "已有文件夹"), { recursive: true });
    const s = new WorkspaceStore(dir, root);
    const added = await s.create("已有文件夹");
    assert.equal(added.path, join(root, "已有文件夹"));
  });

  test("非法名字抛错：空、纯空白、. 、.. 、含 / 或 \\ 或空字节，且不上磁盘", async () => {
    const s = new WorkspaceStore(dir, join(dir, "Orbita"));
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "a\0b"]) {
      await assert.rejects(() => s.create(bad), Error);
    }
    assert.deepEqual(await s.list(), []);
  });

  test("改成带分隔符的名字抛错——显示层会把 a\\b 截成 b，落库的就不再是真名", async () => {
    const added = await store.add("/repo/x");
    await assert.rejects(() => store.rename(added.id, "a\\b"), Error);
    await assert.rejects(() => store.rename(added.id, "a/b"), Error);
    assert.equal((await store.list())[0]?.name, "x");
  });

  test("超长名字截到 WORKSPACE_NAME_MAX，目录名跟着截后的走", async () => {
    const root = join(dir, "Orbita");
    const s = new WorkspaceStore(dir, root);
    const created = await s.create("长".repeat(50));
    assert.equal(created.name.length, 40);
    assert.equal(created.path, join(root, "长".repeat(40)));
  });

  // ── 附加目录（文件面板与开轮目录清单共同的数据源）──

  test("attachDir：挂真实目录落盘，返回更新后的 attachedDirs", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-attach-"));
    try {
      const ws = await store.add("/repo/x");
      const updated = await store.attachDir(ws.id, real);
      assert.deepEqual(updated, [await realpath(real)]);
      assert.equal((await store.list()).find((w) => w.id === ws.id)?.attachedDirs.length, 1);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("attachDir：不存在的路径抛中文错", async () => {
    const ws = await store.add("/repo/x");
    await assert.rejects(
      () => store.attachDir(ws.id, join(dir, "不在的目录")),
      /附加目录不存在/,
    );
  });

  test("attachDir：文件不是目录，抛中文错", async () => {
    const file = join(dir, "a-file.txt");
    await writeFile(file, "x", "utf8");
    const ws = await store.add("/repo/x");
    await assert.rejects(() => store.attachDir(ws.id, file), /不是文件夹/);
  });

  test("attachDir：存的是 realpath 后的真身，链接与真身不会攒成两条", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-real-"));
    try {
      const alias = join(dir, "alias");
      await symlink(real, alias);
      const ws = await store.add("/repo/x");
      await store.attachDir(ws.id, alias);
      const again = await store.attachDir(ws.id, real); // 用真身再挂一次也不重复
      assert.deepEqual(again, [await realpath(real)]);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("detachDir：摘掉后落盘；摘不在列表里的不报错（幂等）", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-detach-"));
    try {
      const ws = await store.add("/repo/x");
      const attached = await store.attachDir(ws.id, real);
      const detached = await store.detachDir(ws.id, attached[0] ?? "");
      assert.deepEqual(detached, []);
      // 再摘一次（列表里已没有）：不报错，返回的仍是空清单
      const again = await store.detachDir(ws.id, real);
      assert.deepEqual(again, []);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  // ── Home 的附加目录（id null；放文件顶层，不造一条 Home 记录进列表）──

  test("attachDir(null)：挂到 Home，落盘在顶层 homeAttachedDirs，工作区列表不动", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-home-attach-"));
    try {
      const before = await store.list();
      const home = await store.attachDir(null, real);
      assert.deepEqual(home, [await realpath(real)]);
      // 列表里没多出 Home 记录：null 缺席即 Home 的纪律不动
      assert.deepEqual(await store.list(), before);
      const raw = JSON.parse(await readFile(join(dir, "workspaces.json"), "utf8")) as {
        homeAttachedDirs?: string[];
        workspaces: unknown[];
      };
      assert.deepEqual(raw.homeAttachedDirs, [await realpath(real)]);
      assert.deepEqual(raw.workspaces, []);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("attachDir(null)：同目录重复挂不重复（realpath 归一后比）", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-home-dup-"));
    try {
      const alias = join(dir, "home-alias");
      await symlink(real, alias);
      await store.attachDir(null, alias);
      const again = await store.attachDir(null, real); // 用真身再挂一次也不重复
      assert.deepEqual(again, [await realpath(real)]);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("detachDir(null)：摘掉后清单为空且不落字段；再摘不报错（幂等）", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-home-detach-"));
    try {
      await store.attachDir(null, real);
      const detached = await store.detachDir(null, await realpath(real));
      assert.deepEqual(detached, []);
      const again = await store.detachDir(null, real); // 幂等：不炸
      assert.deepEqual(again, []);
      const raw = JSON.parse(await readFile(join(dir, "workspaces.json"), "utf8")) as {
        homeAttachedDirs?: string[];
      };
      assert.equal(raw.homeAttachedDirs, undefined); // 空 → 字段缺席（缺席即空）
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("attachedDirsOf：null → Home 清单；工作区 → 它的清单；不存在的 id → []；没挂过即空", async () => {
    assert.deepEqual(await store.attachedDirsOf(null), []); // 字段缺席即空
    const real = await mkdtemp(join(tmpdir(), "orbita-home-of-"));
    try {
      await store.attachDir(null, real);
      assert.deepEqual(await store.attachedDirsOf(null), [await realpath(real)]);
      const ws = await store.add("/repo/x");
      assert.deepEqual(await store.attachedDirsOf(ws.id), []);
      assert.deepEqual(await store.attachedDirsOf("00000000-0000-0000-0000-000000000000"), []);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("顶层 homeAttachedDirs 按 parseAttachedDirs 同套规则解析：非数组当空、空串丢、重复留一条", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({
        version: 2,
        workspaces: [],
        homeAttachedDirs: ["", "/a", "/a", 3, "/b"],
      }),
      "utf8",
    );
    assert.deepEqual(await new WorkspaceStore(dir).attachedDirsOf(null), ["/a", "/b"]);
  });
});
