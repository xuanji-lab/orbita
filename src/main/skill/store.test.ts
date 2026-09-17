import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore, parseSkillMd, rebuildSkillMd } from "./store.ts";

/** root 无视权限位，Windows 没有 chmod——那两个环境里造不出 EACCES */
const skipChmod =
  process.platform === "win32" || process.getuid?.() === 0
    ? "chmod 在这个环境里拦不住读取"
    : false;

let dir = "";
let store: SkillStore;

const SKILL = (name: string, description: string, body = "正文。\n"): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

async function put(slug: string, content: string): Promise<void> {
  await mkdir(join(dir, "skills", slug), { recursive: true });
  await writeFile(join(dir, "skills", slug, "SKILL.md"), content, "utf8");
}

/** 直接造一条断链（绕过 store）：链接目录 + 指向不存在目标的 symlink。 */
async function putBrokenLink(set: string, slug: string): Promise<void> {
  await mkdir(join(dir, "skill-links", set), { recursive: true });
  await symlink(join(dir, "skills", slug), join(dir, "skill-links", set, slug), "junction");
}

const meta = (list: Awaited<ReturnType<SkillStore["list"]>>, slug: string) => {
  const found = list.find((s) => s.slug === slug);
  assert.ok(found !== undefined, `列表里应有 ${slug}`);
  return found;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-skill-"));
  store = new SkillStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SkillStore.list", () => {
  test("目录都没建时是空的，不抛", async () => {
    assert.deepEqual(await store.list(), []);
  });

  test("中心存储里的都列出来，没链任何集合的也在（归属空）", async () => {
    await put("alpha", SKILL("alpha", "一条"));
    assert.deepEqual(await store.list(), [
      { slug: "alpha", name: "alpha", description: "一条", global: false, workspaces: [], missing: false, linkedPath: null },
    ]);
  });

  /**
   * 这条是缓存保险：skill 索引进 system prompt，是 provider 缓存的第一个断点。
   * 顺序一抖，内容没变缓存也会全废。pi 自己按 readdir 返回（实测是创建顺序）。
   */
  test("按 slug 排序，不跟 readdir 的创建顺序走", async () => {
    for (const slug of ["zebra", "alpha", "middle"]) {
      await put(slug, SKILL(slug, `描述 ${slug}`));
    }
    assert.deepEqual((await store.list()).map((s) => s.slug), ["alpha", "middle", "zebra"]);
  });

  test("一条读坏跳过它，不挡住整张列表", async () => {
    await put("good", SKILL("good", "正常"));
    await mkdir(join(dir, "skills", "empty-dir"), { recursive: true });
    assert.deepEqual((await store.list()).map((s) => s.slug), ["good"]);
  });

  test("没有 frontmatter 时 name 退回目录名，不丢掉这条", async () => {
    await put("headless", "只有正文，没有头");
    assert.deepEqual(await store.list(), [
      { slug: "headless", name: "headless", description: "", global: false, workspaces: [], missing: false, linkedPath: null },
    ]);
  });

  // D-3 同款：把「读不出来」说成「一个都没有」，用户会以为 skill 丢了而去重装
  test("中心存储读不出来时抛错，不谎报「一个都没有」", { skip: skipChmod }, async () => {
    await put("alpha", SKILL("alpha", "在盘上好好的"));
    const skills = join(dir, "skills");
    await chmod(skills, 0o000);
    try {
      await assert.rejects(store.list(), /EACCES/);
    } finally {
      await chmod(skills, 0o700);
    }
  });
});

describe("SkillStore.link / unlink —— 归属就是链接", () => {
  test("多对多：一条链 global，另一条同时链两个 workspace", async () => {
    await put("g", SKILL("g", "全局"));
    await put("w", SKILL("w", "工作区"));
    await store.link("g", { kind: "global" });
    await store.link("w", { kind: "workspace", workspaceId: "ws-1" });
    await store.link("w", { kind: "workspace", workspaceId: "ws-2" });
    const list = await store.list();
    assert.deepEqual(meta(list, "g"), { ...meta(list, "g"), global: true, workspaces: [] });
    assert.deepEqual(meta(list, "w").workspaces, ["ws-1", "ws-2"]);
    assert.equal(meta(list, "w").global, false);
    // 链接是真实的 symlink，指向中心存储的绝对路径
    assert.equal(typeof (await readFile(join(dir, "skill-links", "ws-1", "w", "SKILL.md"), "utf8")), "string");
  });

  test("互斥（链进 global 时删各 workspace 链接）——pi 不能看到两条同名 skill", async () => {
    await put("a", SKILL("a", "x"));
    await store.link("a", { kind: "workspace", workspaceId: "ws-1" });
    await store.link("a", { kind: "workspace", workspaceId: "ws-2" });
    await store.link("a", { kind: "global" });
    const a = meta(await store.list(), "a");
    assert.equal(a.global, true);
    assert.deepEqual(a.workspaces, []);
    const ws1 = await readdir(join(dir, "skill-links", "ws-1")).catch(() => null);
    assert.deepEqual(ws1, []);
  });

  test("互斥是双向的：链进 workspace 时删 global 链接", async () => {
    await put("a", SKILL("a", "x"));
    await store.link("a", { kind: "global" });
    await store.link("a", { kind: "workspace", workspaceId: "ws-1" });
    const a = meta(await store.list(), "a");
    assert.equal(a.global, false);
    assert.deepEqual(a.workspaces, ["ws-1"]);
  });

  test("从 global 移出不自动加回 workspace（删掉的归属不记历史）", async () => {
    await put("a", SKILL("a", "x"));
    await store.link("a", { kind: "workspace", workspaceId: "ws-1" });
    await store.link("a", { kind: "global" }); // 这一步删了 ws-1
    await store.unlink("a", { kind: "global" });
    const a = meta(await store.list(), "a");
    assert.equal(a.global, false);
    assert.deepEqual(a.workspaces, []);
  });

  test("unlink 没链时静默（幂等）；不存在的 skill 也能 unlink（清场用）", async () => {
    await put("a", SKILL("a", "x"));
    await store.unlink("a", { kind: "global" });
    await store.unlink("ghost", { kind: "workspace", workspaceId: "ws-1" });
    assert.equal(meta(await store.list(), "a").global, false);
  });

  test("link 不存在的 skill 报错（断链走 clean，不造新链接）", async () => {
    await put("a", SKILL("a", "x"));
    await assert.rejects(store.link("ghost", { kind: "global" }), /Skill not found/);
  });

  test("路径穿越的 slug 与集合 id 直接拒绝", async () => {
    await assert.rejects(store.link("../../etc", { kind: "global" }), /Invalid/);
    await assert.rejects(store.link("a", { kind: "workspace", workspaceId: "../skills" }), /Invalid/);
    await assert.rejects(store.link("a", { kind: "workspace", workspaceId: "global" }), /Invalid/);
  });

  test("链接位置已有实体文件夹时拒绝，不覆盖用户文件", async () => {
    await put("a", SKILL("a", "x"));
    await mkdir(join(dir, "skill-links", "global", "a"), { recursive: true });
    await writeFile(join(dir, "skill-links", "global", "a", "SKILL.md"), "用户手放的", "utf8");
    await assert.rejects(store.link("a", { kind: "global" }), /refusing to overwrite/);
    assert.equal(await readFile(join(dir, "skill-links", "global", "a", "SKILL.md"), "utf8"), "用户手放的");
  });

  test("unlink 遇到同名实体（不是链接）拒绝删——那可能是用户自己的文件夹", async () => {
    await mkdir(join(dir, "skill-links", "global", "a"), { recursive: true });
    await writeFile(join(dir, "skill-links", "global", "a", "keep.txt"), "珍贵文件", "utf8");
    await assert.rejects(store.unlink("a", { kind: "global" }), /not a link/);
    assert.equal(await readFile(join(dir, "skill-links", "global", "a", "keep.txt"), "utf8"), "珍贵文件");
  });

  test("用户的文件夹永远不被 rename / 删除——link/unlink 后中心存储原样", async () => {
    await put("a", SKILL("a", "x"));
    await store.link("a", { kind: "global" });
    await store.unlink("a", { kind: "global" });
    const raw = await readFile(join(dir, "skills", "a", "SKILL.md"), "utf8");
    assert.equal(raw, SKILL("a", "x"));
    assert.deepEqual(await readdir(join(dir, "skills")), ["a"]);
  });
});

describe("断链（missing）与 clean", () => {
  test("链接在、存储文件夹没了 → 列成 missing，不静默消失", async () => {
    await putBrokenLink("global", "gone");
    const list = await store.list();
    const gone = meta(list, "gone");
    assert.equal(gone.missing, true);
    assert.equal(gone.global, true);
  });

  test("missing 条目排在存储条目旁边，归属照常算", async () => {
    await put("alive", SKILL("alive", "好着的"));
    await putBrokenLink("ws-9", "dead");
    const dead = meta(await store.list(), "dead");
    assert.equal(dead.missing, true);
    assert.deepEqual(dead.workspaces, ["ws-9"]);
  });

  test("clean 清掉全部断链引用，列表回到干净", async () => {
    await putBrokenLink("global", "gone");
    await putBrokenLink("ws-1", "gone");
    await store.clean("gone");
    assert.deepEqual(await store.list(), []);
  });

  test("missing 的 skill 不能 link（要先修文件夹或 clean）", async () => {
    await putBrokenLink("global", "gone");
    await assert.rejects(store.link("gone", { kind: "global" }), /Skill not found/);
  });
});

describe("create / importFrom（4-1 应用内添加）", () => {
  test("新建：骨架 SKILL.md + 按归属建链；不重名不覆盖", async () => {
    await store.create("fresh", "Fresh Skill", { kind: "workspace", workspaceId: "ws-1" });
    const list = await store.list();
    assert.deepEqual(meta(list, "fresh").workspaces, ["ws-1"]);
    assert.match(await readFile(join(dir, "skills", "fresh", "SKILL.md"), "utf8"), /name: Fresh Skill/);
    await assert.rejects(store.create("fresh", "叉子", null), /already exists/);
  });

  test("新建 scope=null：只落存储不建链（Disabled 组）", async () => {
    await store.create("shy", "Shy", null);
    const shy = meta(await store.list(), "shy");
    assert.equal(shy.global, false);
    assert.deepEqual(shy.workspaces, []);
  });

  test("导入：store 条目是指向真身的 symlink，linkedPath 带出真身；两跳可读", async () => {
    const real = join(dir, "real-dir");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "SKILL.md"), SKILL("Imported", "真身里的"), "utf8");
    const slug = await store.importFrom(real, { kind: "global" });
    assert.equal(slug, "real-dir");
    const imported = meta(await store.list(), "real-dir");
    assert.equal(imported.global, true);
    assert.equal(imported.linkedPath, real);
    assert.equal((await store.read("real-dir"))?.description, "真身里的");
    // skill-link → store 条目 → 真身，两跳都通
    assert.equal(
      typeof (await readFile(join(dir, "skill-links", "global", "real-dir", "SKILL.md"), "utf8")),
      "string",
    );
  });

  test("导入的目录里没有 SKILL.md 就报错，不落盘", async () => {
    const real = join(dir, "no-skill-md");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "别的.txt"), "x", "utf8");
    await assert.rejects(store.importFrom(real, null), /No SKILL\.md/);
    assert.equal((await store.list()).some((s) => s.slug === "no-skill-md"), false);
  });

  test("目录名不合法（当不了 slug）报错，让用户改名后再选", async () => {
    const real = join(dir, "Bad Name!");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "SKILL.md"), SKILL("x", "y"), "utf8");
    await assert.rejects(store.importFrom(real, null), /Invalid/);
  });

  test("导入的两跳断链：真身被删后，scanStore 跳过 + skill-link 还在 → 落成 missing（回归钉）", async () => {
    const real = join(dir, "vanishing");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "SKILL.md"), SKILL("Vanishing", "会没的"), "utf8");
    await store.importFrom(real, { kind: "global" });
    // 真身被用户在访达里删掉
    await rm(real, { recursive: true, force: true });
    const gone = meta(await store.list(), "vanishing");
    assert.equal(gone.missing, true);
    assert.equal(gone.global, true);
  });
});

describe("removeWorkspace", () => {
  test("工作区移除时它的集合目录整个删掉——只删链接，不伤中心存储", async () => {
    await put("a", SKILL("a", "x"));
    await store.link("a", { kind: "workspace", workspaceId: "ws-1" });
    await store.link("a", { kind: "workspace", workspaceId: "ws-2" });
    await store.removeWorkspace("ws-1");
    const a = meta(await store.list(), "a");
    assert.deepEqual(a.workspaces, ["ws-2"]);
    // 中心存储无损
    assert.equal(await readFile(join(dir, "skills", "a", "SKILL.md"), "utf8"), SKILL("a", "x"));
  });

  test("不存在的 workspace 幂等（没有目录就是没有）", async () => {
    await store.removeWorkspace("never-was");
    assert.deepEqual(await store.list(), []);
  });
});

describe("linkDirs —— 开轮命令拿哪几个集合目录", () => {
  test("无工作区只有 global；有工作区是 global + 它自己", () => {
    assert.deepEqual(store.linkDirs(null), [join(dir, "skill-links", "global")]);
    assert.deepEqual(store.linkDirs("ws-7"), [
      join(dir, "skill-links", "global"),
      join(dir, "skill-links", "ws-7"),
    ]);
  });
});

describe("SkillStore.read / write", () => {
  test("读出来是拆好的三段，渲染层见不到原文", async () => {
    await put("alpha", SKILL("alpha", "一句描述", "# 标题\n\n正文两行。\n"));
    assert.deepEqual(await store.read("alpha"), {
      name: "alpha",
      description: "一句描述",
      body: "# 标题\n\n正文两行。\n",
    });
  });

  test("不存在返回 null（missing 的也 null——存储里没有它）", async () => {
    await putBrokenLink("global", "gone");
    assert.equal(await store.read("gone"), null);
    assert.equal(await store.read("nope"), null);
  });

  test("只改 description，name 与正文不动", async () => {
    await put("alpha", SKILL("alpha", "旧描述", "正文。\n"));
    await store.write("alpha", { description: "新描述" });
    assert.deepEqual(await store.read("alpha"), {
      name: "alpha",
      description: "新描述",
      body: "正文。\n",
    });
  });

  // 用户手写的字段不该因为我们不认识就被吃掉
  test("frontmatter 里其它键原样保留", async () => {
    await put(
      "alpha",
      `---\nname: alpha\ndescription: 旧\ndisable-model-invocation: true\nallowed-tools: [read]\n---\n正文。\n`,
    );
    await store.write("alpha", { description: "新" });
    const raw = await readFile(join(dir, "skills", "alpha", "SKILL.md"), "utf8");
    assert.match(raw, /disable-model-invocation: true/);
    assert.match(raw, /allowed-tools: \[read\]/);
    assert.match(raw, /description: 新/);
  });

  test("没有 frontmatter 时补一个头，不静静写不进去", async () => {
    await put("headless", "只有正文\n");
    await store.write("headless", { name: "headless", description: "补上的描述" });
    assert.deepEqual(await store.read("headless"), {
      name: "headless",
      description: "补上的描述",
      body: "只有正文\n",
    });
  });

  test("写不存在的 skill 报错，不静默建一个", async () => {
    await assert.rejects(store.write("nope", { description: "x" }), /Skill not found/);
  });
});

describe("parseSkillMd / rebuildSkillMd", () => {
  test("描述里的冒号不会把 YAML 拆坏", () => {
    const rebuilt = rebuildSkillMd(SKILL("a", "旧"), { description: "用法: 先读再写" });
    assert.equal(parseSkillMd(rebuilt).description, "用法: 先读再写");
  });

  test("描述里的换行折叠成空格，不破坏单行标量", () => {
    const rebuilt = rebuildSkillMd(SKILL("a", "旧"), { description: "第一行\n第二行" });
    assert.equal(parseSkillMd(rebuilt).description, "第一行 第二行");
  });

  test("BOM 不影响 frontmatter 匹配", () => {
    assert.equal(parseSkillMd(`\uFEFF${SKILL("a", "带 BOM")}`).description, "带 BOM");
  });

  test("CRLF 换行也能解出来", () => {
    const crlf = "---\r\nname: a\r\ndescription: 回车换行\r\n---\r\n正文\r\n";
    assert.equal(parseSkillMd(crlf).description, "回车换行");
  });

  test("整篇没有 frontmatter 时全当正文", () => {
    assert.deepEqual(parseSkillMd("就是一段话"), { name: null, description: null, body: "就是一段话" });
  });
});
