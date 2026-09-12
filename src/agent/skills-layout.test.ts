/**
 * 钉住「我们的目录布局」与「pi 的 skill 发现规则」对得上。
 *
 * 这一刀没有自己的加载代码——集合目录交给 pi，扫盘与拼 prompt 都是它做。
 * 那么唯一会坏的地方就是**约定漂移**：pi 换了发现规则，或者我们换了布局，
 * 而两边各自都还「正确」。这份测试就是那道对缝。
 *
 * 2-1 起布局是中心存储 + symlink 集合（见 main/skill/store.ts）：
 * 这里专门钉 pi 侧的三条假设——跟符号链接、断链跳过、同名会重复出现
 * （互斥规则存在的理由）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

let dir = "";

/** 一个 skill = 中心存储里的一个文件夹 + SKILL.md，frontmatter 里有 name 与 description */
async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文随便写点什么。\n`,
    "utf8",
  );
}

/** 按新模型造一条归属：中心存储里写真身，集合目录里放指向它的 symlink */
async function writeSet(
  storeDir: string,
  setDir: string,
  name: string,
  description: string,
): Promise<void> {
  await writeSkill(storeDir, name, description);
  await mkdir(setDir, { recursive: true });
  await symlink(join(storeDir, name), join(setDir, name), "junction");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("skills 目录布局（中心存储 + symlink 集合）", () => {
  test("链进集合目录就能被认出来——pi 跟符号链接，这就是「链上就能用」", async () => {
    const storeDir = join(dir, "skills");
    const global = join(dir, "skill-links", "global");
    await writeSet(storeDir, global, "pdf-report", "把季度数据渲染成 PDF");
    const result = loadSkillsFromDir({ dir: global, source: "user" });
    assert.deepEqual(result.skills.map((s) => s.name), ["pdf-report"]);
    assert.equal(result.skills[0]?.description, "把季度数据渲染成 PDF");
  });

  // 停用机制的全部实现就是这一条：没链进任何拿给 pi 的目录，就不在加载路径上
  test("只在中心存储、没链任何集合 = 不生效", async () => {
    await writeSkill(join(dir, "skills"), "unlinked", "存着但没链");
    const global = join(dir, "skill-links", "global");
    await mkdir(global, { recursive: true });
    const result = loadSkillsFromDir({ dir: global, source: "user" });
    assert.deepEqual(result.skills.map((s) => s.name), []);
  });

  // 互斥规则（store 层执行）存在的理由：pi 会把两条同名 skill 都拼进 prompt
  test("同一 slug 链进两个集合，pi 看到两条——互斥必须由我们保证", async () => {
    const storeDir = join(dir, "skills");
    await writeSet(storeDir, join(dir, "skill-links", "global"), "both", "同名第一条");
    await mkdir(join(dir, "skill-links", "ws-1"), { recursive: true });
    await symlink(
      join(storeDir, "both"),
      join(dir, "skill-links", "ws-1", "both"),
      "junction",
    );
    const names = [
      ...loadSkillsFromDir({ dir: join(dir, "skill-links", "global"), source: "user" }).skills,
      ...loadSkillsFromDir({ dir: join(dir, "skill-links", "ws-1"), source: "user" }).skills,
    ].map((s) => s.name);
    assert.deepEqual(names, ["both", "both"]);
  });

  test("断链（目标文件夹没了）跳过，不抛", async () => {
    const global = join(dir, "skill-links", "global");
    await mkdir(global, { recursive: true });
    await symlink(join(dir, "skills", "gone"), join(global, "gone"), "junction");
    const result = loadSkillsFromDir({ dir: global, source: "user" });
    assert.deepEqual(result.skills, []);
  });

  test("目录不存在 = 一个都没装，不抛", () => {
    assert.deepEqual(loadSkillsFromDir({ dir: join(dir, "skill-links", "global"), source: "user" }).skills, []);
  });

  test("空目录也是一个都没装", async () => {
    const global = join(dir, "skill-links", "global");
    await mkdir(global, { recursive: true });
    assert.deepEqual(loadSkillsFromDir({ dir: global, source: "user" }).skills, []);
  });

  /**
   * 装了就得真的进 prompt，否则「生效」只是句空话。
   *
   * 同时钉住 `<location>`：**skill 正文从来不进 prompt，进去的只有索引与路径**。
   * 这条是「热插拔是伪需求」的依据——中途要用一个没在索引里的 skill，
   * 把路径告诉 agent 让它 read 即可，和索引里那条走的是同一条路。
   */
  test("进 prompt 的是名字、描述与路径，不是正文", async () => {
    const storeDir = join(dir, "skills");
    const global = join(dir, "skill-links", "global");
    await writeSet(storeDir, global, "pdf-report", "把季度数据渲染成 PDF");
    const prompt = formatSkillsForPrompt(loadSkillsFromDir({ dir: global, source: "user" }).skills);
    assert.match(prompt, /pdf-report/);
    assert.match(prompt, /把季度数据渲染成 PDF/);
    assert.match(prompt, /<location>.*SKILL\.md<\/location>/);
    assert.ok(!prompt.includes("正文随便写点什么"), "正文不该出现在 prompt 里");
  });

  test("一个坏的 skill 不挡住其它的", async () => {
    const storeDir = join(dir, "skills");
    const global = join(dir, "skill-links", "global");
    await writeSet(storeDir, global, "good", "正常的一个");
    await writeSkill(storeDir, "broken", "坏的那个");
    await symlink(join(storeDir, "broken"), join(global, "broken"), "junction");
    await writeFile(join(storeDir, "broken", "SKILL.md"), "没有 frontmatter，只有正文", "utf8");
    const result = loadSkillsFromDir({ dir: global, source: "user" });
    assert.equal(result.skills.some((s) => s.name === "good"), true);
  });
});
