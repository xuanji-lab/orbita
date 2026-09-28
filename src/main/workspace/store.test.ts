import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore, assertLegalName } from "./store.ts";
import { WORKSPACE_NAME_MAX } from "../../shared/workspace.ts";

let dir = "";
let store: WorkspaceStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-workspace-"));
  store = new WorkspaceStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 落一份 v2 文件——老版本写出来的形状：version 2 + 名字那一列是机器从路径铸的 */
async function writeV2(workspaces: readonly unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspaces.json"), JSON.stringify({ version: 2, workspaces }), "utf8");
}

/** 一条 v2 记录（id 由名字派生，够用即可） */
function v2Record(name: string, path: string): Record<string, unknown> {
  return { id: `w-${name}`, name, path, createdAt: 1, attachedDirs: [] };
}

/** 磁盘上那份 workspaces.json 现在长什么样 */
async function readDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "workspaces.json"), "utf8")) as Record<string, unknown>;
}

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

  // ── v2 → v3：名字那一列治一次 ──
  //
  // 老数据里名字被铸成了整条路径（早期只切 `/` 的派生在 Windows 上的产物），治它是
  // **一次性迁移**而不是「每次读判一遍指纹」：判不准就会漏（真实数据两种形态都有，
  // 见下面两条），而每次读都改一个用户看得见的字段本身就是隐藏的数据变更。

  test("v2 → v3：整条路径当名字的老记录治成末段，并整份写回（version 抬到 3）", async () => {
    const path = "C:\\Users\\dama\\Desktop\\p1\\paper3";
    await writeV2([v2Record(path, path)]);
    const [workspace] = await new WorkspaceStore(dir).list();
    assert.equal(workspace?.name, "paper3");
    const disk = await readDisk();
    assert.equal(disk["version"], 3);
    assert.equal((disk["workspaces"] as Array<{ name: string }>)[0]?.name, "paper3");
  });

  test("v2 → v3：被 40 上限切过的老记录也治——名字是路径的前 40 字", async () => {
    const path = "C:\\Users\\dama\\Desktop\\my-super-long-project-folder-name-2026";
    await writeV2([v2Record(path.slice(0, WORKSPACE_NAME_MAX), path)]);
    const [workspace] = await new WorkspaceStore(dir).list();
    // 治回来的名字**不截**：磁盘上的目录名是完整的，add 铸名本来也不截
    assert.equal(workspace?.name, "my-super-long-project-folder-name-2026");
  });

  // 治好的名字要活过重启：v2 → v3 把 >40 字的尾段原样落盘，若读盘再切一刀（老 parse
  // 的 40 上限），治好的名字只活一个会话——重启变分尸名，之后任何一次写操作把分尸名
  // 回写磁盘，治愈彻底销毁。这一条把「迁移不截 + 读盘不截」整条链钉住
  test("治好的超长尾段活过重启：再读不变形，写操作后磁盘不碎", async () => {
    const long = "my-extremely-long-project-directory-name-2026-forever";
    const path = "C:\\Users\\dama\\Desktop\\" + long;
    await writeV2([v2Record(path.slice(0, WORKSPACE_NAME_MAX), path)]);
    await new WorkspaceStore(dir).list(); // 第一次启动:迁移治好,落盘 v3

    const reopened = (await new WorkspaceStore(dir).list())[0]; // 重启:version 3,纯解析
    assert.equal(reopened?.name, long);

    await new WorkspaceStore(dir).add("/another/proj"); // 重启后的任意写操作
    const disk = await readDisk();
    assert.equal((disk["workspaces"] as Array<{ name: string }>)[0]?.name, long);
  });

  test("v2 → v3：用户自己起的名字一个字不动——含 / 的、长度刚好 40 的", async () => {
    const path = "/Users/wafo/repo/orbita-lab";
    await writeV2([
      v2Record("PhD/Year1", path),
      v2Record("x".repeat(WORKSPACE_NAME_MAX), path),
      v2Record("a\\b", path),
    ]);
    assert.deepEqual(
      (await new WorkspaceStore(dir).list()).map((w) => w.name),
      ["PhD/Year1", "x".repeat(WORKSPACE_NAME_MAX), "a\\b"],
    );
  });

  test("v2 → v3：盘符大小写不同也算同一条路径", async () => {
    await writeV2([v2Record("c:\\users\\dama\\proj", "C:\\Users\\dama\\proj")]);
    assert.equal((await new WorkspaceStore(dir).list())[0]?.name, "proj");
  });

  // 版本号就是「治过了」那个开关。已经是 v3 就一点都不动——文件里留一个我们不会写回去的
  // 字段当指纹：它还在，就说明这次读没有顺手写盘
  test("v3 文件不再改写（幂等）——连手写痕迹都留着", async () => {
    const path = "C:\\x\\paper3";
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({ version: 3, workspaces: [v2Record(path, path)], 手写的: true }),
      "utf8",
    );
    const [workspace] = await new WorkspaceStore(dir).list();
    assert.equal(workspace?.name, path); // 说好了 v3 不迁就不迁——哪怕名字还像路径
    assert.equal((await readDisk())["手写的"], true);
  });

  // 版本号认不出来（字段缺了 / 被人手改）就当最老的算：多治一次是幂等的，把用户挡在门外才是真事故
  test("没有 version 字段的文件也照治，不拦路", async () => {
    const path = "C:\\Users\\dama\\Desktop\\p1\\paper3";
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({ workspaces: [v2Record(path, path)] }),
      "utf8",
    );
    assert.equal((await new WorkspaceStore(dir).list())[0]?.name, "paper3");
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

  // 合法 JSON 但形状不对（手改坏了）就是「读不懂」，同样不能被覆写。
  // 注意 version 高不是理由——版本号只决定要不要迁移，形状才是能不能读的门槛
  test("结构不对的文件不当成空列表", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({ version: 99, folders: [] }),
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

  test("非法名字抛错：空、纯空白、. 、.. 、像路径（含 / 或盘符起头）或空字节，且不上磁盘", async () => {
    const s = new WorkspaceStore(dir, join(dir, "Orbita"));
    for (const bad of ["", "   ", ".", "..", "a/b", "C:\\x\\y", "a\0b"]) {
      await assert.rejects(() => s.create(bad), Error);
    }
    assert.deepEqual(await s.list(), []);
  });

  test("rename 是自由显示文本：含 / 的 PhD/Year1 也收——显示层原样显示不截尾（wafo 裁决）", async () => {
    const added = await store.add("/repo/x");
    await store.rename(added.id, "PhD/Year1");
    assert.equal((await store.list())[0]?.name, "PhD/Year1");
  });

  test("assertLegalName 平台矩阵：\\ 只在 Windows 拒——POSIX 系（Mac / Linux）里它是文件名的合法字符", () => {
    assert.throws(() => assertLegalName("a\\b", "win32"), Error);
    assertLegalName("a\\b", "darwin"); // Mac 上 a\b 是正常名字，不抛
    assertLegalName("a\\b", "linux"); // Linux 同 POSIX
    assert.throws(() => assertLegalName("a/b", "darwin"), Error);
    assert.throws(() => assertLegalName("C:\\x", "darwin"), Error); // 盘符形在哪个 OS 都像路径
    assert.throws(() => assertLegalName("..", "darwin"), Error);
  });

  // 名字在 create 里会真的变成 ~/Orbita 下的一个目录。这些名字在 Windows 上要么建出来
  // 的东西不是它（保留名、尾点），要么报一串用户看不懂的 errno（`阶段一: 重构`）
  test("assertLegalName：Windows 非法字符 / 保留名 / 尾点——只在 Windows 拒", () => {
    const windowsOnly = [
      "阶段一: 重构", // 中文用户用 ASCII 冒号起名很常见；macOS 上合法，Finder 会显示成 》阶段一/ 重构《
      "a<b",
      "a>b",
      'a"b',
      "a|b",
      "a?b",
      "a*b",
      "proj.",
      "第 1 阶段.",
      "CON",
      "nul",
      "Com1", // 不分大小写
      "con.txt", // 带扩展名同样是设备
      "LPT9",
    ];
    for (const bad of windowsOnly) {
      assert.throws(() => assertLegalName(bad, "win32"), Error, bad);
      assertLegalName(bad, "darwin"); // POSIX 里它们都是正常文件名，不能一刀切拒掉
      assertLegalName(bad, "linux");
    }
  });

  // 报错要说人话：用户要能从话里看出该改哪里
  test("assertLegalName：报错点名是哪一条", () => {
    const message = (name: string, platform: NodeJS.Platform): string => {
      try {
        assertLegalName(name, platform);
        return "";
      } catch (cause) {
        return (cause as Error).message;
      }
    };
    assert.match(message("阶段一: 重构", "win32"), /不能含 :/);
    assert.match(message("CON", "win32"), /保留的设备名/);
    assert.match(message("proj.", "win32"), /不能以 \. 或空格结尾/);
    assert.match(message("a\\b", "win32"), /不能含 \\/);
    assert.match(message("a/b", "darwin"), /不能含 \//);
    assert.match(message("C:\\x", "darwin"), /不能像路径/);
  });

  // 截断退役：目录名就是用户给的名字，照实建（显示层 CSS ellipsis 兜底）。NTFS 单段
  // 上限 255 字符，50 字毫无压力；真到 255+ 是 mkdir 报错，不是静默建错东西
  test("超长名字原样当目录名，不截断", async () => {
    const root = join(dir, "Orbita");
    const s = new WorkspaceStore(dir, root);
    const created = await s.create("长".repeat(50));
    assert.equal(created.name, "长".repeat(50));
    assert.equal(created.path, join(root, "长".repeat(50)));
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
