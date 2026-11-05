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
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["board-style", "find-existing", "plugin-creator"]);
    for (const skill of scanned.skills) assert.equal(skill.description.length > 40, true, `${skill.slug} 的 description 太短，模型想不起它`);
    assert.equal(scanned.workflow.length >= 5, true);
    for (const step of scanned.workflow) {
      if (step.skill !== null) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    }
    // 找现成的与做看板卡片分别指向专门的技能，不是都挤在主技能上
    assert.deepEqual(scanned.workflow.map((step) => step.skillSlug).filter((slug) => slug !== null && slug !== "plugin-creator"), ["find-existing", "board-style"]);
    // 边聊边填：需求 → 技能/输入输出 → 工作流 → 看板 → 脚本 → 装，看板在写脚本之前
    const titles = scanned.workflow.map((step) => step.title);
    const indexOf = (needle: string): number => titles.findIndex((title) => title.includes(needle));
    assert.equal(indexOf("看板") >= 0 && indexOf("脚本") > indexOf("看板") && indexOf("装之前") > indexOf("脚本"), true, `workflow 的顺序要是：看板 → 脚本 → 装之前，实际 ${titles.join(" / ")}`);
    // wait（Human in the loop）在自己的 workflow 里也用上了：磨卡、装之前等用户
    const manifest = JSON.parse(await readFile(join(CREATOR, ".claude-plugin", "plugin.json"), "utf8")) as { orbita: { workflow: { title: string; wait?: string }[] } };
    const waits = manifest.orbita.workflow.filter((step) => step.wait !== undefined);
    assert.equal(waits.length >= 2, true, "至少两步标 wait（磨卡、装之前）");
    for (const step of waits) assert.ok(step.wait === "chat" || step.wait === "board", `wait 只能是 board/chat：${step.title}写了 ${step.wait}`);
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

  test("骨架（第 2 步用）：plugin.json 是合法 JSON，只写需求与 tuned，看板/工作流还没聊到不预写；技能骨架（第 5 步用）有 description 占位", async () => {
    const skeleton = join(CREATOR, "skills", "plugin-creator", "assets", "plugin-skeleton");
    const manifest = JSON.parse(await readFile(join(skeleton, ".claude-plugin", "plugin.json"), "utf8")) as { orbita?: Record<string, unknown> };
    // 边聊边填：骨架里不预写还没聊到的节（右栏画「还没聊到」），旧的 panel 更不能出现
    for (const key of ["workflow", "io", "external", "board", "panel"])
      assert.equal(manifest.orbita?.[key], undefined, `骨架不该预写 ${key}（还没聊到）`);
    assert.equal(manifest.orbita?.["tuned"], false, "tuned 初始 false，用户磨合好才改");
    assert.equal(await exists(join(skeleton, "taste.md")), true);
    // 第 2 步整份拷骨架：骨架里不能带技能与脚本（那是第 5 步的事），也不带卡片文件（那是看板那步）
    assert.equal(await exists(join(skeleton, "skills")), false);
    assert.equal(await exists(join(skeleton, "scripts")), false);
    assert.equal(await exists(join(skeleton, "board")), false);
    const skillSkeleton = join(CREATOR, "skills", "plugin-creator", "assets", "skill-skeleton");
    const skillText = await readFile(join(skillSkeleton, "skills", "__SKILL__", "SKILL.md"), "utf8");
    assert.match(skillText, /^---\nname: __SKILL__\ndescription: /);
    assert.match(skillText, /show_plugin_board/, "生成的技能跑完要把看板显示在对话里");
    assert.match(skillText, /tuned/, "生成的技能要按 tuned 决定说不说明");
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

  test("plugin-creator 技能是「边聊边填清单」的流程：需求→技能/输入输出→工作流（wait）→看板→脚本→装", async () => {
    const text = await readFile(join(CREATOR, "skills", "plugin-creator", "SKILL.md"), "utf8");
    // 新流程的几个关键动作都在
    assert.match(text, /preview_plugin/);
    assert.match(text, /调一次就够/);
    assert.match(text, /"wait": "board"/);
    assert.match(text, /"wait": "chat"/);
    assert.match(text, /show_plugin_board/);
    assert.match(text, /一张卡只说一件事/);
    assert.match(text, /1x1 \/ 2x1 \/ 1x2 \/ 2x2/);
    assert.match(text, /外框、圆角、卡片阴影是 Orbita 的/);
    assert.match(text, /可以装了吗/);
    assert.match(text, /不要在同一轮里调用 `install_plugin`/);
    assert.match(text, /taste\.md/);
    // tuned：初始 false，改 true 前先问一句
    assert.match(text, /`tuned` 初始是 `false`/);
    assert.match(text, /「以后这个插件跑完就只出卡、不加说明，可以吗？」/);
    // 每写一节右栏自己长出来：skill 只管写清单，界面是宿主的事
    assert.match(text, /右栏几秒内自己长/);
    // 步骤顺序：听需求 → 骨架 → 边聊边填 → 工作流+看板 → 脚本 → 装之前问一句 → 自动化
    const at = (needle: string): number => text.indexOf(needle);
    const order = ["### 1. 听需求", "### 2. 主动找现成的", "### 3. 边聊边填", "### 4. 工作流，和看板卡片", "### 5. 定稿之后", "### 6. 装之前问一句", "### 7. 问要不要定时跑"].map(at);
    assert.equal(order.every((index) => index >= 0), true, "七步标题缺了");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "步骤顺序不对");
    // 旧流程的残留：挂起的确认卡、试跑里把验收清单做完
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

  test("看板卡片：换风格是子流程（不是开场）且只出 2 个方向、局部意见不用它、方向用同一份样例数据渲染", async () => {
    const text = await readFile(join(CREATOR, "skills", "board-style", "SKILL.md"), "utf8");
    assert.match(text, /这是子流程，不是开场/);
    assert.match(text, /局部意见/);
    assert.match(text, /第一版从用户已有的品味出发/);
    assert.match(text, /同一份 sample/);
    assert.match(text, /2 个方向/);
    // 骰子 / 实物联想 / 三个方向 / 外观账本这套已删（2026-11-05 用户裁决：太自由）
    assert.doesNotMatch(text, /骰子|实物联想|七个候选|三个方向|三个完整|style-ledger/);
    // 卡的规矩：四档尺寸、外框是宿主的、不仿现成产品（含 Kimi 的看板）
    assert.match(text, /"1x1" \/ "2x1" \/ "1x2" \/ "2x2"/);
    assert.match(text, /模板里不画外框/);
    assert.match(text, /一张卡只说一件事/);
    assert.match(text, /Kimi 看板那一套/);
    assert.doesNotMatch(text, /第 4 步已经跑出真数据|没有真数据不开工/);
  });

  test("样例数据示例是合法 JSON，形状是单卡数据（对象，不是数组）", async () => {
    const sample = JSON.parse(await readFile(join(CREATOR, "skills", "board-style", "assets", "sample.example.json"), "utf8")) as Record<string, unknown>;
    assert.equal(typeof sample, "object");
    assert.ok(!Array.isArray(sample), "单卡模板收到的 data 是一个对象（repeat 卡才是数组里的项）");
    assert.equal(typeof sample["title"], "string");
  });

  test("卡模板骨架：按约定收 orbita:data（含 card / unit）、发 orbita:ready（带 emptyState）与 orbita:action、设主题变量、按 unit 等比取字号；不画外框、不联网不引外部资源", async () => {
    const html = await readFile(join(CREATOR, "skills", "board-style", "assets", "board-template.html"), "utf8");
    assert.match(html, /"orbita:data"/);
    assert.match(html, /type: "orbita:ready", emptyState: true/);
    assert.match(html, /type: "orbita:action"/);
    assert.match(html, /state === "empty"/);
    assert.match(html, /style\.setProperty/);
    // 单卡版：宿主下发的 card（哪张卡 / 第几项）与 unit（像素尺寸，字号按它等比）
    assert.match(html, /message\.card/);
    assert.match(html, /message\.unit/);
    assert.match(html, /applyUnit/);
    // 外框（圆角、裁切、边框）是宿主的：模板根元素不画外框也不投影
    const code = html.replace(/<!--[\s\S]*?-->/g, ""); // 开头的说明注释里会写到这些词
    assert.doesNotMatch(code, /body\s*\{[^}]*?(border-radius|box-shadow|border:)/);
    // 沙盒 CSP 不让联网和外部资源：不能有 http 引用、外链脚本 / 样式 / fetch
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/);
    // 数据里的字符串不走 innerHTML；卡的 CSP 不放行 eval / new Function
    assert.doesNotMatch(html, /innerHTML/);
    assert.doesNotMatch(code, /\beval\(|new Function/);
    // 实测出来的规则：color-scheme（否则玄主题下被刷成不透明白底）、只信宿主的消息
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
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
