import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function put(root: string, slug: string, content: string): Promise<void> {
  await mkdir(join(dir, root, slug), { recursive: true });
  await writeFile(join(dir, root, slug, "SKILL.md"), content, "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-skill-"));
  store = new SkillStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SkillStore.list", () => {
  test("两个目录都没建时是空的，不抛", async () => {
    assert.deepEqual(await store.list(), []);
  });

  test("skills/ 的算启用，skills-inactive/ 的算停用", async () => {
    await put("skills", "alpha", SKILL("alpha", "启用的"));
    await put("skills-inactive", "beta", SKILL("beta", "停用的"));
    assert.deepEqual(
      (await store.list()).map((s) => [s.slug, s.enabled]),
      [["alpha", true], ["beta", false]],
    );
  });

  /**
   * 这条是缓存保险：skill 索引进 system prompt，是 provider 缓存的第一个断点。
   * 顺序一抖，内容没变缓存也会全废。pi 自己按 readdir 返回（实测是创建顺序）。
   */
  test("按 slug 排序，不跟 readdir 的创建顺序走", async () => {
    for (const slug of ["zebra", "alpha", "middle"]) {
      await put("skills", slug, SKILL(slug, `描述 ${slug}`));
    }
    assert.deepEqual((await store.list()).map((s) => s.slug), ["alpha", "middle", "zebra"]);
  });

  test("一条读坏跳过它，不挡住整张列表", async () => {
    await put("skills", "good", SKILL("good", "正常"));
    await mkdir(join(dir, "skills", "empty-dir"), { recursive: true });
    assert.deepEqual((await store.list()).map((s) => s.slug), ["good"]);
  });

  test("没有 frontmatter 时 name 退回目录名，不丢掉这条", async () => {
    await put("skills", "headless", "只有正文，没有头");
    assert.deepEqual(await store.list(), [
      { slug: "headless", name: "headless", description: "", enabled: true },
    ]);
  });

  // D-3 同款：把「读不出来」说成「一个都没有」，用户会以为 skill 丢了而去重装
  test("目录读不出来时抛错，不谎报「一个都没有」", { skip: skipChmod }, async () => {
    await put("skills", "alpha", SKILL("alpha", "在盘上好好的"));
    const skills = join(dir, "skills");
    await chmod(skills, 0o000);
    try {
      await assert.rejects(store.list(), /EACCES/);
    } finally {
      await chmod(skills, 0o700);
    }
  });
});

describe("SkillStore.setEnabled", () => {
  test("启用 = 从 skills-inactive/ 搬进 skills/", async () => {
    await put("skills-inactive", "beta", SKILL("beta", "停用的"));
    await store.setEnabled("beta", true);
    assert.deepEqual(await store.list(), [
      { slug: "beta", name: "beta", description: "停用的", enabled: true },
    ]);
    // 文件真的换了目录，不是只改了个标记
    assert.equal(typeof (await readFile(join(dir, "skills", "beta", "SKILL.md"), "utf8")), "string");
  });

  test("停用 = 搬回 skills-inactive/", async () => {
    await put("skills", "alpha", SKILL("alpha", "启用的"));
    await store.setEnabled("alpha", false);
    assert.deepEqual((await store.list()).map((s) => s.enabled), [false]);
  });

  // 覆盖会悄悄吃掉一份用户文件，宁可报错
  test("两边同名时拒绝搬，不覆盖", async () => {
    await put("skills", "dup", SKILL("dup", "启用的那份"));
    await put("skills-inactive", "dup", SKILL("dup", "停用的那份"));
    await assert.rejects(store.setEnabled("dup", true), /已存在同名/);
    assert.match(await readFile(join(dir, "skills", "dup", "SKILL.md"), "utf8"), /启用的那份/);
  });

  test("路径穿越的 slug 直接拒绝", async () => {
    await assert.rejects(store.setEnabled("../../etc", true), /非法/);
  });
});

describe("SkillStore.read / write", () => {
  test("读出来是拆好的三段，渲染层见不到原文", async () => {
    await put("skills", "alpha", SKILL("alpha", "一句描述", "# 标题\n\n正文两行。\n"));
    assert.deepEqual(await store.read("alpha"), {
      name: "alpha",
      description: "一句描述",
      body: "# 标题\n\n正文两行。\n",
    });
  });

  test("不存在返回 null", async () => {
    assert.equal(await store.read("nope"), null);
  });

  test("停用的也能读——详情页要能看停用的那些", async () => {
    await put("skills-inactive", "beta", SKILL("beta", "停用的"));
    assert.equal((await store.read("beta"))?.description, "停用的");
  });

  test("只改 description，name 与正文不动", async () => {
    await put("skills", "alpha", SKILL("alpha", "旧描述", "正文。\n"));
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
      "skills",
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
    await put("skills", "headless", "只有正文\n");
    await store.write("headless", { name: "headless", description: "补上的描述" });
    assert.deepEqual(await store.read("headless"), {
      name: "headless",
      description: "补上的描述",
      body: "只有正文\n",
    });
  });

  test("写不存在的 skill 报错，不静默建一个", async () => {
    await assert.rejects(store.write("nope", { description: "x" }), /不存在/);
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
