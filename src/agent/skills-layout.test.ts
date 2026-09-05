/**
 * 钉住「我们的目录布局」与「pi 的 skill 发现规则」对得上。
 *
 * 这一刀没有自己的加载代码——目录交给 pi，扫盘与拼 prompt 都是它做。
 * 那么唯一会坏的地方就是**约定漂移**：pi 换了发现规则，或者我们换了布局，
 * 而两边各自都还「正确」。这份测试就是那道对缝。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

let dir = "";

/** 一个 skill = 一个文件夹 + 一份 SKILL.md，frontmatter 里有 name 与 description */
async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文随便写点什么。\n`,
    "utf8",
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("skills 目录布局", () => {
  test("放进 skills/ 就能被认出来——这就是「放进目录就能用」", async () => {
    const skills = join(dir, "skills");
    await writeSkill(skills, "pdf-report", "把季度数据渲染成 PDF");
    const result = loadSkillsFromDir({ dir: skills, source: "user" });
    assert.deepEqual(result.skills.map((s) => s.name), ["pdf-report"]);
    assert.equal(result.skills[0]?.description, "把季度数据渲染成 PDF");
  });

  // 启停机制的全部实现就是这一条：换个目录，就不在加载路径上了
  test("移到 skills-inactive/ 就不生效——我们只把 skills/ 交给 pi", async () => {
    const skills = join(dir, "skills");
    await writeSkill(skills, "on", "启用中");
    await writeSkill(join(dir, "skills-inactive"), "off", "停用中");
    const result = loadSkillsFromDir({ dir: skills, source: "user" });
    assert.deepEqual(result.skills.map((s) => s.name), ["on"]);
  });

  test("目录不存在 = 一个都没装，不抛", () => {
    assert.deepEqual(loadSkillsFromDir({ dir: join(dir, "skills"), source: "user" }).skills, []);
  });

  test("空目录也是一个都没装", async () => {
    const skills = join(dir, "skills");
    await mkdir(skills, { recursive: true });
    assert.deepEqual(loadSkillsFromDir({ dir: skills, source: "user" }).skills, []);
  });

  /**
   * 装了就得真的进 prompt，否则「生效」只是句空话。
   *
   * 同时钉住 `<location>`：**skill 正文从来不进 prompt，进去的只有索引与路径**。
   * 这条是「热插拔是伪需求」的依据——中途要用一个没在索引里的 skill，
   * 把路径告诉 agent 让它 read 即可，和索引里那条走的是同一条路。
   */
  test("进 prompt 的是名字、描述与路径，不是正文", async () => {
    const skills = join(dir, "skills");
    await writeSkill(skills, "pdf-report", "把季度数据渲染成 PDF");
    const prompt = formatSkillsForPrompt(loadSkillsFromDir({ dir: skills, source: "user" }).skills);
    assert.match(prompt, /pdf-report/);
    assert.match(prompt, /把季度数据渲染成 PDF/);
    assert.match(prompt, /<location>.*SKILL\.md<\/location>/);
    assert.ok(!prompt.includes("正文随便写点什么"), "正文不该出现在 prompt 里");
  });

  test("一个坏的 skill 不挡住其它的", async () => {
    const skills = join(dir, "skills");
    await writeSkill(skills, "good", "正常的一个");
    const broken = join(skills, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "SKILL.md"), "没有 frontmatter，只有正文", "utf8");
    const result = loadSkillsFromDir({ dir: skills, source: "user" });
    assert.equal(result.skills.some((s) => s.name === "good"), true);
  });
});
