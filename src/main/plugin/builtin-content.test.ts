/**
 * 随应用带的内置插件（resources/builtin-plugins/）本身的账：它是产品资源，不是代码，
 * 但它被 PluginStore 当真插件读——写坏了（技能没 description、workflow 点名不存在的技能、
 * 引用的参考文件不在）用户第一次点「和智能体一起做一个」就走偏。所以用真扫描器扫一遍。
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { BUILTIN_PLUGIN_NAMES } from "../../shared/plugin.ts";
import { scanPlugin } from "./manifest.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BUILTIN = join(REPO, "resources", "builtin-plugins");
const CREATOR = join(BUILTIN, "plugin-creator");

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe("内置插件 plugin-creator", () => {
  test("名字表里的每个内置插件都有内容目录，且能被扫描器当插件读（无问题、名字合法）", async () => {
    for (const name of BUILTIN_PLUGIN_NAMES) {
      const scanned = await scanPlugin(join(BUILTIN, name), name);
      assert.equal(scanned.name, name);
      assert.equal(scanned.nameValid, true);
      assert.deepEqual(scanned.problems, [], `${name} 的清单或技能有问题`);
      assert.deepEqual(scanned.unsupported, [], `${name} 带了 Orbita 不运行的组件`);
      assert.equal(scanned.description !== "", true);
    }
  });

  test("三条技能都在、各有 description；workflow 每一步点名的技能都对得上（详情页不出现「找不到这个技能」）", async () => {
    const scanned = await scanPlugin(CREATOR, "plugin-creator");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["find-existing", "panel-style", "plugin-creator"]);
    for (const skill of scanned.skills) assert.equal(skill.description.length > 40, true, `${skill.slug} 的 description 太短，模型想不起它`);
    assert.equal(scanned.workflow.length >= 5, true);
    for (const step of scanned.workflow) {
      if (step.skill !== null) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    }
    // 第 2 步与第 5 步分别指向专门的技能，不是都挤在主技能上
    assert.deepEqual(scanned.workflow.map((step) => step.skillSlug).filter((slug) => slug !== null && slug !== "plugin-creator"), ["find-existing", "panel-style"]);
  });

  test("SKILL.md 里引用的 references/ 与 assets/ 文件都真实存在（并且确实引用到了，不是空跑）", async () => {
    const scanned = await scanPlugin(CREATOR, "plugin-creator");
    let found = 0;
    for (const skill of scanned.skills) {
      const text = await readFile(skill.file, "utf8");
      const refs = [...text.matchAll(/(?<![A-Za-z0-9_.-])((?:references|assets)\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g)].map((match) => match[1] ?? "");
      for (const ref of refs) {
        found += 1;
        assert.equal(await exists(join(skill.dir, ref)), true, `${skill.slug} 引用了不存在的 ${ref}`);
      }
    }
    assert.equal(found >= 5, true, `只扫到 ${found} 处引用，正则可能失效`);
  });

  test("骨架：plugin.json 去掉占位后是合法 JSON，带 workflow 与 panel；示例技能有 description 占位", async () => {
    const skeleton = join(CREATOR, "skills", "plugin-creator", "assets", "plugin-skeleton");
    const manifest = JSON.parse(await readFile(join(skeleton, ".claude-plugin", "plugin.json"), "utf8")) as { orbita?: { workflow?: unknown[]; panel?: { template?: string; data?: string } } };
    assert.equal(Array.isArray(manifest.orbita?.workflow), true);
    assert.equal(manifest.orbita?.panel?.template, "./panel/index.html");
    assert.equal(manifest.orbita?.panel?.data, "${CLAUDE_PLUGIN_ROOT}/data/panel.json");
    assert.match(await readFile(join(skeleton, "skills", "__SKILL__", "SKILL.md"), "utf8"), /^---\nname: __SKILL__\ndescription: /);
  });

  test("面板模板骨架：按约定收 orbita:data、发 orbita:ready（带 emptyState）与 orbita:action、设主题变量、处理空态；不联网不引外部资源", async () => {
    const html = await readFile(join(CREATOR, "skills", "panel-style", "assets", "panel-template.html"), "utf8");
    assert.match(html, /"orbita:data"/);
    assert.match(html, /type: "orbita:ready", emptyState: true/);
    assert.match(html, /type: "orbita:action"/);
    assert.match(html, /state === "empty"/);
    assert.match(html, /style\.setProperty/);
    // 沙盒 CSP 不让联网和外部资源：模板里不能有 http 引用、外链脚本 / 样式 / fetch
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/);
    // 数据里的字符串不走 innerHTML
    assert.doesNotMatch(html, /innerHTML/);
  });

  test("NOTICE 保留 impeccable（Apache-2.0）与花叔 Design（MIT）的署名", async () => {
    const notice = await readFile(join(CREATOR, "NOTICE"), "utf8");
    assert.match(notice, /impeccable[\s\S]*Apache License 2\.0/);
    assert.match(notice, /huashu-design[\s\S]*MIT License/);
    assert.match(notice, /github\.com\/pbakaus\/impeccable/);
    assert.match(notice, /github\.com\/alchaincyf\/huashu-design/);
  });

  test("打包：package.json 的 extraResources 把 resources/builtin-plugins 放进安装包", async () => {
    const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { build: { extraResources: { from: string; to: string }[] } };
    assert.equal(pkg.build.extraResources.some((entry) => entry.from === "resources/builtin-plugins" && entry.to === "builtin-plugins"), true);
  });
});
