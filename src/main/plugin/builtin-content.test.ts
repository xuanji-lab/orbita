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
    // 找现成的与磨卡片（换风格）分别指向专门的技能，不是都挤在主技能上
    assert.deepEqual(scanned.workflow.map((step) => step.skillSlug).filter((slug) => slug !== null && slug !== "plugin-creator"), ["find-existing", "panel-style"]);
    // UI 先行：摆出第一版卡片、磨卡片都在写脚本之前
    const titles = scanned.workflow.map((step) => step.title);
    const indexOf = (needle: string): number => titles.findIndex((title) => title.includes(needle));
    assert.equal(indexOf("样例") >= 0 && indexOf("磨卡片") > indexOf("样例") && indexOf("脚本") > indexOf("磨卡片"), true, `workflow 的顺序要是：样例 → 磨卡片 → 脚本，实际 ${titles.join(" / ")}`);
    assert.equal(indexOf("装之前") > indexOf("脚本"), true);
  });

  test("SKILL.md 里引用的 references/ 与 assets/ 文件都真实存在（并且确实引用到了，不是空跑）", async () => {
    const scanned = await scanPlugin(CREATOR, "plugin-creator");
    let found = 0;
    for (const skill of scanned.skills) {
      const text = await readFile(skill.file, "utf8");
      // 允许 `../<别的技能>/assets/…` 这种跨技能引用：整段（含 ../x/ 前缀）一起按本技能目录解析
      const refs = [...text.matchAll(/(?<![A-Za-z0-9_.-])((?:\.\.\/[a-z-]+\/)?(?:references|assets)\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g)].map((match) => match[1] ?? "");
      for (const ref of refs) {
        found += 1;
        assert.equal(await exists(join(skill.dir, ref)), true, `${skill.slug} 引用了不存在的 ${ref}`);
      }
    }
    assert.equal(found >= 5, true, `只扫到 ${found} 处引用，正则可能失效`);
  });

  test("骨架（第 3 步用）：plugin.json 是合法 JSON，面板块带 spec 与 sample，不预先写 workflow；样例是合法 JSON；spec 有三个小节；技能骨架（第 5 步用）有 description 占位", async () => {
    const skeleton = join(CREATOR, "skills", "plugin-creator", "assets", "plugin-skeleton");
    const manifest = JSON.parse(await readFile(join(skeleton, ".claude-plugin", "plugin.json"), "utf8")) as { orbita?: { workflow?: unknown; panel?: Record<string, string> } };
    assert.equal(manifest.orbita?.workflow, undefined, "UI 先行：技能还没写，骨架里不写 workflow");
    assert.deepEqual(manifest.orbita?.panel, {
      title: "__面板标题__",
      template: "./panel/index.html",
      data: "${CLAUDE_PLUGIN_ROOT}/data/panel.json",
      spec: "./panel/spec.md",
      sample: "./panel/sample.json",
    });
    const sample = JSON.parse(await readFile(join(skeleton, "panel", "sample.json"), "utf8")) as { items?: unknown[] };
    assert.equal(Array.isArray(sample.items), true);
    const spec = await readFile(join(skeleton, "panel", "spec.md"), "utf8");
    for (const heading of ["显示哪些字段", "怎么排", "数据从哪来"]) assert.match(spec, new RegExp(`## ${heading}`));
    // 第 3 步整份拷骨架：骨架里不能带技能与脚本（那是第 5 步的事）
    assert.equal(await exists(join(skeleton, "skills")), false);
    assert.equal(await exists(join(skeleton, "scripts")), false);
    const skillSkeleton = join(CREATOR, "skills", "plugin-creator", "assets", "skill-skeleton");
    assert.match(await readFile(join(skillSkeleton, "skills", "__SKILL__", "SKILL.md"), "utf8"), /^---\nname: __SKILL__\ndescription: /);
    assert.equal(await exists(join(skillSkeleton, "scripts", "example.py")), true);
  });

  test("三条技能都写了：用用户自己写的文字的语言回复，不被英文系统包装带偏", async () => {
    const scanned = await scanPlugin(CREATOR, "plugin-creator");
    for (const skill of scanned.skills) {
      const text = await readFile(skill.file, "utf8");
      assert.match(text, /用户自己写的文字的语言/, `${skill.slug} 缺语言规则`);
      assert.match(text, /系统包装/, `${skill.slug} 没点明英文系统包装不算用户的话`);
    }
  });

  test("plugin-creator 技能是 UI 先行的流程，不再是先写脚本、弹卡、试跑里验收", async () => {
    const text = await readFile(join(CREATOR, "skills", "plugin-creator", "SKILL.md"), "utf8");
    // 新流程的几个关键动作都在
    assert.match(text, /preview_plugin/);
    assert.match(text, /panel\/sample\.json/);
    assert.match(text, /panel\/spec\.md/);
    assert.match(text, /一次改一处/);
    assert.match(text, /可以装了吗/);
    assert.match(text, /不要在同一轮里调用 `install_plugin`/);
    assert.match(text, /taste\.md/);
    // 步骤顺序：样例/第一版卡片 → 磨卡片 → 才写脚本 → 装之前问一句 → 自动化
    const at = (needle: string): number => text.indexOf(needle);
    const order = ["### 3. 搭骨架，用一篇样例摆出第一版卡片", "### 4. 和用户磨卡片", "### 5. 定稿之后：写技能和脚本", "### 6. 装之前问一句", "### 7. 问要不要自动化"].map(at);
    assert.equal(order.every((index) => index >= 0), true, "七步标题缺了");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "步骤顺序不对");
    // 旧流程的残留：挂起的确认卡、15 分钟、试跑里把验收清单做完
    assert.doesNotMatch(text, /确认卡|弹一张|点“安装”才装|点「安装」才装/);
    assert.doesNotMatch(text, /没过就改脚本再跑|不要带着没过的清单进下一步/);
  });

  test("找现成的：只在真有取舍时停；点名了底子就直接用；不在不冲突的候选之间硬停", async () => {
    const text = await readFile(join(CREATOR, "skills", "find-existing", "SKILL.md"), "utf8");
    assert.match(text, /只在有真取舍时停下来问用户/);
    for (const tradeoff of ["放弃他已有的方案", "许可证受限", "候选互斥"]) assert.match(text, new RegExp(tradeoff));
    assert.match(text, /点名了底子/);
    assert.match(text, /不要\*\*在两个不冲突的候选之间停下/);
    assert.doesNotMatch(text, /\*\*然后停下来，等他选\*\*（或说“从头写”）/);
  });

  test("面板风格：换风格是子流程（不是开场）、局部意见不用它、方向用同一篇样例渲染", async () => {
    const text = await readFile(join(CREATOR, "skills", "panel-style", "SKILL.md"), "utf8");
    assert.match(text, /这是子流程，不是开场/);
    assert.match(text, /局部意见/);
    assert.match(text, /第一版从用户已有的品味出发/);
    assert.match(text, /同一篇样例/);
    assert.match(text, /panel\/sample\.json/);
    assert.doesNotMatch(text, /第 4 步已经跑出真数据|没有真数据不开工/);
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
    // 数据里的字符串不走 innerHTML；面板的 CSP 不放行 eval / new Function
    assert.doesNotMatch(html, /innerHTML/);
    const code = html.replace(/<!--[\s\S]*?-->/g, ""); // 开头的说明注释里会写到这两个词
    assert.doesNotMatch(code, /\beval\(|new Function/);
    // 面板那头实测出来的规则：透明底 + color-scheme（否则深色主题下被刷成不透明白底）、只信宿主的消息
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /html, body \{[^}]*background: transparent/);
    assert.match(html, /event\.source !== parent/);
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
