/**
 * 随应用带的内置插件（resources/builtin-plugins/）本身的账：它是产品资源，不是代码，
 * 但它被 PluginStore 当真插件读——写坏了（技能没 description、workflow 点名不存在的技能、
 * 引用的参考文件不在）用户第一次点「和智能体一起做一个」就走偏。所以用真扫描器扫一遍。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { BUILTIN_PLUGIN_NAMES } from "../../shared/plugin.ts";
import { RequestBroker } from "../../agent/request-broker.ts";
import { createBrowserTools } from "../../agent/browser-tools.ts";
import { WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS } from "../../shared/browser-wait.ts";
import { BROWSER_DIAGNOSTICS_BUFFER_LIMIT, BROWSER_DIAGNOSTICS_DEFAULT_LIMIT } from "../../shared/browser.ts";
import { LAYOUT_GUIDE, LAYOUT_NAMES } from "../../shared/slides-layouts.ts";
import { DEFAULT_THEME_ID, THEME_BLURBS, THEME_IDS } from "../../shared/slides-theme.ts";
import { SLIDES_EXPORT_FORMATS } from "../../shared/slides-export.ts";
import { TERMINAL_READ_DEFAULT_LIMIT, TERMINAL_READ_MAX_LIMIT } from "../../shared/terminal.ts";
import { TERMINAL_TOOL_NAMES } from "../../agent/terminal-tools.ts";
import {
  AUTOMATION_AGENT_DEFAULT_MAX_RUNS,
  AUTOMATION_AGENT_MAX_RUNS_CAP,
  AUTOMATION_INTERVAL_MIN_MINUTES,
  AUTOMATION_INTERVAL_UNITS,
  AUTOMATION_MAX_ACTIVE_PER_SESSION,
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_MAX_RUNS_PER_DAY,
  AUTOMATION_MAX_UNFINISHED,
  AUTOMATION_MODES,
  AUTOMATION_PROMPT_MAX,
  AUTOMATION_STATUSES,
  AUTOMATION_TITLE_MAX,
} from "../../shared/automation.ts";
import { AUTOMATION_TOOL_NAMES, createAutomationTools } from "../../agent/automation-tools.ts";
import { QUOTE_MIN_CHARS } from "../../shared/pdf-quote.ts";
import {
  CITE_MAX_QUOTES,
  FIGURE_INDEX_MAX,
  PDF_IMAGE_HD_WIDTH,
  PDF_IMAGE_MAX_PAGES_PER_CALL,
  PDF_IMAGE_WIDTH,
  PDF_IMAGE_WIDTH_MAX,
  PDF_IMAGE_WIDTH_MIN,
  PDF_MAX_PAGES_PER_CALL,
  PDF_NO_TEXT_LAYER_MIN_CHARS,
  PDF_SPARSE_PAGE_CHARS,
} from "../../agent/pdf-tools.ts";
import { DOCX_IMAGE_MAX_COUNT, DOCX_MAX_CHARS_PER_CALL, DOCX_OUTLINE_MAX } from "../../agent/docx-tools.ts";
import type { SecretsPort } from "../provider/store.ts";
import { scanPlugin } from "./manifest.ts";
import { PluginStore } from "./store.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BUILTIN = join(REPO, "resources", "builtin-plugins");
const CREATOR = join(BUILTIN, "plugin-creator");

const SKILL_KIT = join(BUILTIN, "skill-kit");
const DOCS_SLIDES = join(BUILTIN, "docs-slides");
const TERMINAL = join(BUILTIN, "terminal");
const AUTOMATION = join(BUILTIN, "automation");
const READING = join(BUILTIN, "reading");
const BROWSER = join(BUILTIN, "browser");

class NoSecrets implements SecretsPort {
  async set(): Promise<void> {}
  async get(): Promise<string | null> {
    return null;
  }
  async delete(): Promise<void> {}
}

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

describe("内置插件的名字表与资源目录", () => {
  test("BUILTIN_PLUGIN_NAMES 与 resources/builtin-plugins 下的目录一一对应（多一个少一个都不行）", async () => {
    const dirs = (await readdir(BUILTIN, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.deepEqual([...dirs].sort(), [...BUILTIN_PLUGIN_NAMES].sort());
  });

  test("每个内置插件的每条技能：有 description（模型靠它想起技能）、目录名与 SKILL.md 的 name 一致、清单有中文名与作者", async () => {
    for (const name of BUILTIN_PLUGIN_NAMES) {
      const scanned = await scanPlugin(join(BUILTIN, name), name);
      assert.equal(scanned.skills.length >= 1, true, `${name} 没有技能`);
      assert.notEqual(scanned.displayName, name, `${name} 没写 displayName`);
      assert.notEqual(scanned.author, null, `${name} 没写 author`);
      for (const skill of scanned.skills) {
        assert.equal(skill.description.length > 40, true, `${name}/${skill.slug} 的 description 太短`);
        assert.equal(skill.name, skill.slug, `${name}/${skill.slug} 的 name 与目录名不一致`);
      }
    }
  });
});

describe("内置插件 skill-kit", () => {
  test("两条技能：find-skills 与 skill-creator；workflow 点名都对得上", async () => {
    const scanned = await scanPlugin(SKILL_KIT, "skill-kit");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["find-skills", "skill-creator"]);
    assert.equal(scanned.workflow.length >= 3, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能对不上`);
  });

  test("找技能只回应用户直接开口：不再写「创建插件前主动找」（那是 plugin-creator 里 find-existing 的事，两个都写会同时触发）", async () => {
    const find = await readFile(join(SKILL_KIT, "skills", "find-skills", "SKILL.md"), "utf8");
    const description = /^description: (.*)$/m.exec(find)?.[1] ?? "";
    assert.doesNotMatch(description, /PROACTIVELY|主动/);
    assert.doesNotMatch(find, /Orbita 插件功能开发中|插件功能上线后/);
    assert.match(find, /不要在做插件的流程里用它/);
    // 安装路径：单文件走 create_skill，多文件做成插件走 install_plugin；禁 -g；不写死 mac 路径、不让模型手工建符号链接
    assert.match(find, /create_skill/);
    assert.match(find, /install_plugin/);
    assert.match(find, /不要用 `npx skills add -g`/);
    assert.doesNotMatch(find, /npx skills add [^\n`]*-g -y/);
    assert.doesNotMatch(find, /Library\/Application Support/);
    // 反过来：find-existing 不再认领「用户单独问有没有技能」
    const existing = await readFile(join(CREATOR, "skills", "find-existing", "SKILL.md"), "utf8");
    const existingDescription = /^description: (.*)$/m.exec(existing)?.[1] ?? "";
    assert.doesNotMatch(existingDescription, /用户问“有没有现成的 XX 技能”/);
    assert.match(existingDescription, /find-skills/);
  });

  test("写技能：写入走 create_skill / 插件安装，不写死 mac 数据目录；版本带 -orbita 后缀", async () => {
    const text = await readFile(join(SKILL_KIT, "skills", "skill-creator", "SKILL.md"), "utf8");
    assert.match(text, /create_skill/);
    assert.match(text, /install_plugin/);
    assert.doesNotMatch(text, /Library\/Application Support|skill-links/);
    assert.match(text, /^version: "1\.1\.\d+-orbita"$/m);
    const find = await readFile(join(SKILL_KIT, "skills", "find-skills", "SKILL.md"), "utf8");
    assert.match(find, /^version: "1\.0\.\d+-orbita"$/m);
  });

  test("许可署名：skill-creator 原样带 Apache-2.0 的 LICENSE.txt；NOTICE 写明两个上游、作者、许可与改动", async () => {
    const license = await readFile(join(SKILL_KIT, "skills", "skill-creator", "LICENSE.txt"), "utf8");
    assert.match(license, /Apache License\s+Version 2\.0/);
    const notice = await readFile(join(SKILL_KIT, "NOTICE"), "utf8");
    assert.match(notice, /github\.com\/vercel-labs\/skills/);
    assert.match(notice, /Copyright \(c\) \d{4} Vercel, Inc\./);
    assert.match(notice, /MIT License/);
    assert.match(notice, /github\.com\/anthropics\/skills/);
    assert.match(notice, /Apache License 2\.0/);
    assert.match(notice, /我们改了什么/);
    // MIT 全文跟在后面（保留版权声明与许可声明的要求）
    assert.match(notice, /Permission is hereby granted, free of charge/);
  });

  test("skill-creator 带的脚本与参考文件都在，SKILL.md 引用的 scripts/ references/ agents/ 文件不悬空", async () => {
    const dir = join(SKILL_KIT, "skills", "skill-creator");
    const text = await readFile(join(dir, "SKILL.md"), "utf8");
    const refs = [...text.matchAll(/(?<![A-Za-z0-9_.-])((?:references|agents|scripts|assets|eval-viewer)\/[A-Za-z0-9_-]+\.[a-z]+)/g)].map((match) => match[1] ?? "");
    assert.equal(refs.length >= 5, true, `只扫到 ${refs.length} 处引用，正则可能失效`);
    for (const ref of new Set(refs)) assert.equal(await exists(join(dir, ref)), true, `skill-creator 引用了不存在的 ${ref}`);
  });
});

describe("内置插件 docs-slides", () => {
  test("两条技能 slides 与 docs；workflow 点名都对得上；description 写明何时用（模型靠它想起技能）", async () => {
    const scanned = await scanPlugin(DOCS_SLIDES, "docs-slides");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["docs", "slides"]);
    assert.equal(scanned.workflow.length >= 4, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    const slides = scanned.skills.find((skill) => skill.slug === "slides");
    assert.match(slides?.description ?? "", /BEFORE the first slides_create/);
    assert.match(slides?.description ?? "", /presentation|slides|deck|PPT/i);
    const docs = scanned.skills.find((skill) => skill.slug === "docs");
    assert.match(docs?.description ?? "", /BEFORE the first doc_open/);
  });

  // 版式清单与主题清单的真源在代码里（工具与版式生成都读它）；技能里是给模型读的那一份，两边不许分叉
  test("slides 技能与代码同源：每个版式的说明原文、每个主题「id — 说明」原文都在 SKILL.md 里；多一个少一个都不行", async () => {
    const text = await readFile(join(DOCS_SLIDES, "skills", "slides", "SKILL.md"), "utf8");
    for (const name of LAYOUT_NAMES) assert.equal(text.includes(`- ${LAYOUT_GUIDE[name]}`), true, `slides 技能缺版式 ${name} 的说明原文（与 LAYOUT_GUIDE 不一致）`);
    for (const id of THEME_IDS) assert.equal(text.includes(`- ${id} — ${THEME_BLURBS[id]?.en ?? "<无说明>"}`), true, `slides 技能缺主题 ${id} 的说明原文（与 THEME_BLURBS 不一致）`);
    // 反向：技能里列出的版式行 / 主题行，不能比代码多（删了版式忘了删技能里那行）
    const layoutSection = text.split("## Layouts")[1]?.split("## Themes")[0] ?? "";
    const layoutLines = layoutSection.split("\n").filter((line) => /^- [a-z-]+ — /.test(line));
    assert.deepEqual(layoutLines.map((line) => /^- ([a-z-]+) — /.exec(line)?.[1]), [...LAYOUT_NAMES]);
    const themeSection = text.split("## Themes")[1]?.split("## slides_edit operations")[0] ?? "";
    const themeLines = themeSection.split("\n").filter((line) => /^- [a-z]+ — /.test(line));
    assert.deepEqual(themeLines.map((line) => /^- ([a-z]+) — /.exec(line)?.[1]), [...THEME_IDS]);
    assert.match(text, new RegExp(`default ${DEFAULT_THEME_ID}\\b`), "默认主题与 DEFAULT_THEME_ID 不一致");
    // 导出格式一个不漏
    for (const format of SLIDES_EXPORT_FORMATS) assert.equal(text.includes(`\`${format}\``), true, `slides 技能没讲导出格式 ${format}`);
    // slides_edit 的七种操作都讲到
    for (const op of ["patch", "add", "delete", "set_slide", "delete_slide", "move_slide", "set_deck"]) assert.equal(text.includes(`op:"${op}"`), true, `slides 技能没讲 slides_edit 的 ${op}`);
  });

  test("docs 技能讲到三个工具、四种导出格式与「无该语法就写纯 md」的规矩", async () => {
    const text = await readFile(join(DOCS_SLIDES, "skills", "docs", "SKILL.md"), "utf8");
    for (const needle of ["doc_open", "doc_insert_image", "doc_export", "attachmentFolderPath", "attachments/", "md-plain", "`docx`", "`pdf`", "`md`", "[!warning]"]) assert.equal(text.includes(needle), true, `docs 技能缺 ${needle}`);
    assert.match(text, /Write plain markdown unless the user's notes already use that syntax/);
  });
});

describe("内置插件 terminal", () => {
  test("一条技能 terminal；workflow 点名对得上；description 写明何时读、何时不用（模型靠它想起技能）", async () => {
    const scanned = await scanPlugin(TERMINAL, "terminal");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["terminal"]);
    assert.equal(scanned.workflow.length >= 4, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    const skill = scanned.skills[0];
    assert.match(skill?.description ?? "", /BEFORE the first terminal_\* call/);
    assert.match(skill?.description ?? "", /watch/);
    assert.match(skill?.description ?? "", /use bash/);
  });

  // 工具名单与读取上限的真源在代码里（权限档描述认 TERMINAL_TOOL_NAMES；上限在 shared/terminal.ts）；技能里是给模型读的那一份，不许分叉
  test("terminal 技能与代码同源：六个工具各占表里一行且一个不多；读取默认 / 上限数字一致；红线与「没有退出码事件」原文在", async () => {
    const text = await readFile(join(TERMINAL, "skills", "terminal", "SKILL.md"), "utf8");
    const tableSection = text.split("## The six tools")[1]?.split("## Red line")[0] ?? "";
    const rows = tableSection.split("\n").filter((line) => /^\| `terminal_[a-z]+` \|/.test(line));
    assert.deepEqual(rows.map((line) => /^\| `(terminal_[a-z]+)` \|/.exec(line)?.[1]), [...TERMINAL_TOOL_NAMES]);
    const grouped = (value: number): string => value.toLocaleString("en-US");
    assert.equal(text.includes(`last ${grouped(TERMINAL_READ_DEFAULT_LIMIT)} characters`), true, "技能里的默认读取字符数与 TERMINAL_READ_DEFAULT_LIMIT 不一致");
    assert.equal(text.includes(`1–${grouped(TERMINAL_READ_MAX_LIMIT)}, default ${grouped(TERMINAL_READ_DEFAULT_LIMIT)}`), true, "技能里的 limit 范围与 TERMINAL_READ_MAX_LIMIT 不一致");
    assert.match(text, /Red line: never type into a busy terminal/);
    assert.match(text, /There is no exit-code event/);
    assert.match(text, /outputSharedWithAgent: false/);
  });
});

describe("内置插件 automation", () => {
  const readSkill = (): Promise<string> => readFile(join(AUTOMATION, "skills", "automation", "SKILL.md"), "utf8");

  test("一条技能 automation；workflow 点名对得上；description 写明何时读、何时用（模型靠它想起技能）", async () => {
    const scanned = await scanPlugin(AUTOMATION, "automation");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["automation"]);
    assert.equal(scanned.workflow.length >= 4, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    const description = scanned.skills[0]?.description ?? "";
    assert.match(description, /BEFORE the first automation_create/);
    for (const needle of ["every Friday", "remind me", "tell me when the build is done", "定时", "提醒"]) assert.equal(description.includes(needle), true, `技能 description 缺触发词 ${needle}`);
  });

  // 触发规则与取值的真源在代码里（工具的 schema 与主进程的 parseSchedule）；技能里是给模型读的那一份，两边不许分叉
  test("技能与代码同源：schedule 的 kind / unit / 字段、状态、权限档、四个工具名都在 SKILL.md 里；表里列的 kind 不能比 schema 多", async () => {
    const text = await readSkill();
    const create = createAutomationTools(new RequestBroker(() => {}), "S", () => "skip").find((tool) => tool.name === "automation_create");
    assert.ok(create);
    const properties = (create.parameters as unknown as { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> }).properties;
    const schedule = properties["schedule"]?.properties ?? {};
    const kinds = schedule["kind"]?.enum ?? [];
    assert.deepEqual(kinds, ["interval", "hourly", "daily", "monthly", "once"]);
    for (const kind of kinds) assert.equal(text.includes(`| \`${kind}\` |`), true, `技能的触发规则表缺 kind ${kind}`);
    const tableKinds = text.split("## Schedule format")[1]?.split("All clock times")[0]?.split("\n").map((line) => /^\| `([a-z]+)` \|/.exec(line)?.[1]).filter((kind) => kind !== undefined);
    assert.deepEqual([...(tableKinds ?? [])].sort(), [...kinds].sort(), "技能表里的 kind 与 schema 的 enum 不一致");
    assert.deepEqual(schedule["unit"]?.enum, [...AUTOMATION_INTERVAL_UNITS]);
    assert.equal(text.includes(AUTOMATION_INTERVAL_UNITS.map((unit) => `\`${unit}\``).join(" \\| ")), true, "技能没按 `minute` \\| `hour` \\| `day` 列 interval 的单位");
    for (const field of ["at", "every", "minute", "time", "weekdays", "day"]) assert.equal(text.includes(`\`${field}\``), true, `技能没讲 schedule 字段 ${field}`);
    assert.equal(text.includes("everyMinutes"), true, "技能没讲 everyMinutes 简写");
    for (const status of AUTOMATION_STATUSES) assert.equal(text.includes(status), true, `技能没提状态 ${status}`);
    for (const mode of AUTOMATION_MODES) assert.equal(text.includes(`"${mode}"`), true, `技能没提权限档 ${mode}`);
    for (const name of AUTOMATION_TOOL_NAMES) assert.equal(text.includes(`\`${name}\``), true, `技能没讲工具 ${name}`);
    for (const param of Object.keys(properties)) assert.equal(text.includes(`\`${param}\``), true, `技能没讲 automation_create 的参数 ${param}`);
  });

  test("技能里写的护栏数字与代码常量一致（间隔下限、每日次数、默认与上限次数、条数、连续失败、标题与指令长度）", async () => {
    const text = await readSkill();
    const expected = [
      `total ≥ ${AUTOMATION_INTERVAL_MIN_MINUTES} minutes`,
      `at least ${AUTOMATION_INTERVAL_MIN_MINUTES} minutes`,
      `at most ${AUTOMATION_MAX_RUNS_PER_DAY} real runs per rolling 24 hours`,
      `**${AUTOMATION_AGENT_DEFAULT_MAX_RUNS} runs**`,
      `(1–${AUTOMATION_AGENT_MAX_RUNS_CAP})`,
      `at most ${AUTOMATION_MAX_ACTIVE_PER_SESSION} active \`this_session\` tasks per conversation`,
      `at most ${AUTOMATION_MAX_UNFINISHED} unfinished automations`,
      `**${["Zero", "One", "Two", "Three"][AUTOMATION_MAX_CONSECUTIVE_FAILURES]} consecutive failed runs**`,
      `title at most ${AUTOMATION_TITLE_MAX} characters`,
      `instruction at most ${AUTOMATION_PROMPT_MAX.toLocaleString("en-US")} characters`,
    ];
    for (const needle of expected) assert.equal(text.includes(needle), true, `技能里缺「${needle}」（与代码常量不一致？）`);
  });
});

describe("内置插件 reading", () => {
  test("一条技能 reading；workflow 点名对得上；description 写明「读 PDF 用 read_pdf、读 docx 用 read_docx，不用 read」与何时读它（模型靠它想起技能）", async () => {
    const scanned = await scanPlugin(READING, "reading");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["reading"]);
    assert.equal(scanned.displayName, "读 PDF 与 Word");
    assert.equal(scanned.workflow.length >= 4, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    const description = scanned.skills[0]?.description ?? "";
    for (const needle of ["read_pdf", "cite_pdf", "read_docx", "never read", "figure", "scanned", "quote"]) assert.match(description, new RegExp(needle, "i"), `description 缺 ${needle}`);
  });

  // 上限与数字的真源在代码里（工具的分页、渲染、核验都读它）；技能里是给模型读的那一份，两边不许分叉
  test("reading 技能与代码同源：分页 / 页图 / 宽度 / 引文 / docx 的数字都与常量一致", async () => {
    const text = await readFile(join(READING, "skills", "reading", "SKILL.md"), "utf8");
    const fmt = (n: number): string => n.toLocaleString("en-US");
    const expected = [
      `pages 1–${PDF_MAX_PAGES_PER_CALL}`,
      `max ${PDF_MAX_PAGES_PER_CALL})`,
      `at most ${PDF_IMAGE_MAX_PAGES_PER_CALL} pages per call`,
      `capped at ${PDF_IMAGE_MAX_PAGES_PER_CALL} pages`,
      `(${PDF_IMAGE_MAX_PAGES_PER_CALL} pages per call, ${PDF_IMAGE_HD_WIDTH} px`,
      `rendered ${PDF_IMAGE_HD_WIDTH} px wide`,
      `${PDF_IMAGE_WIDTH_MIN}–${PDF_IMAGE_WIDTH_MAX}`,
      `(default ${PDF_IMAGE_WIDTH} px wide)`,
      `fewer than ${PDF_SPARSE_PAGE_CHARS} characters`,
      `under ${PDF_NO_TEXT_LAYER_MIN_CHARS} characters`,
      `at most ${FIGURE_INDEX_MAX} entries`,
      `up to ${CITE_MAX_QUOTES} quotes`,
      `at least ${QUOTE_MIN_CHARS} letters`,
      `at most ${DOCX_OUTLINE_MAX} headings`,
      `about ${fmt(DOCX_MAX_CHARS_PER_CALL)} characters`,
      `at most ${DOCX_IMAGE_MAX_COUNT} per call`,
    ];
    for (const needle of expected) assert.equal(text.includes(needle), true, `reading 技能缺「${needle}」（与代码常量不一致？）`);
  });

  test("reading 技能讲到三个工具的要害：不用 read、image_pages 与 crop 像素、offset+limit 省文字、cite_pdf 的编号与 NOT CITED、docx 块号 / 批注 / images", async () => {
    const text = await readFile(join(READING, "skills", "reading", "SKILL.md"), "utf8");
    for (const needle of ["`read_pdf`", "`cite_pdf`", "`read_docx`", "Never use `read`", "image_pages", "images: true", "crop", "pixels on the page image", "offset: 7, limit: 1", "no text layer", "NOT CITED", "[^c4k2]", "exactly as written", "block", "Sections:", "[Z1]", "[image N: alt text]"]) {
      assert.equal(text.includes(needle), true, `reading 技能缺 ${needle}`);
    }
  });
});

describe("内置插件 browser", () => {
  test("一条技能 browser；workflow 点名对得上；description 写明何时用（模型靠它想起技能）", async () => {
    const scanned = await scanPlugin(BROWSER, "browser");
    assert.deepEqual(scanned.skills.map((skill) => skill.slug), ["browser"]);
    assert.equal(scanned.workflow.length >= 4, true);
    for (const step of scanned.workflow) assert.notEqual(step.skillSlug, null, `workflow 步骤「${step.title}」点名的技能 ${step.skill} 对不上`);
    const skill = scanned.skills[0];
    assert.match(skill?.description ?? "", /BEFORE the first browser_\* call/);
    assert.match(skill?.description ?? "", /open or read a web page|look something up online/);
    assert.match(skill?.description ?? "", /打开网页|查一下|页面空白/);
  });

  // 工具名、参数名、等待与诊断的数字在代码里（schema 与执行逻辑读它）；技能是给模型读的那一份，不许分叉
  test("技能与代码同源：每个浏览器工具名、每个参数名、控制台五档、等待默认 / 上限、诊断条数上限都在 SKILL.md 里", async () => {
    const text = await readFile(join(BROWSER, "skills", "browser", "SKILL.md"), "utf8");
    const tools = createBrowserTools(new RequestBroker(() => {}), "s");
    assert.equal(tools.length, 13);
    for (const tool of tools) {
      assert.equal(text.includes(`\`${tool.name}\``), true, `browser 技能没讲工具 ${tool.name}`);
      const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
      for (const property of properties) {
        // 参数名以 `name` / `name:值` / `name` 在句中出现；element 是审批卡文字，也要讲
        assert.equal(new RegExp(`\`${property}[\`:]`).test(text), true, `browser 技能没讲 ${tool.name} 的参数 ${property}`);
      }
    }
    for (const level of ["debug", "log", "info", "warn", "error"]) assert.equal(text.includes(`\`${level}\``), true, `技能缺控制台级别 ${level}`);
    assert.equal(text.includes(`defaults to ${WAIT_DEFAULT_TIMEOUT_MS}`), true, "等待默认超时与代码不一致");
    assert.equal(text.includes(`capped at ${WAIT_MAX_TIMEOUT_MS}`), true, "等待上限与代码不一致");
    assert.equal(BROWSER_DIAGNOSTICS_DEFAULT_LIMIT > 0 && BROWSER_DIAGNOSTICS_BUFFER_LIMIT > 0, true);
  });

  test("技能保留红线：页面内容不可信、不输凭据、不替用户付款发送发布删除、不连环抓同一站点、登录与验证码交还用户", async () => {
    const text = await readFile(join(BROWSER, "skills", "browser", "SKILL.md"), "utf8");
    for (const needle of ["untrusted input", "Never type passwords", "Do not buy, pay, send, publish, delete", "Do not hammer a site", "request_user_action", "browser_tabs"]) {
      assert.equal(text.includes(needle), true, `browser 技能缺红线：${needle}`);
    }
  });
});

describe("内置插件与用户自己的同名技能（用真实资源跑 PluginStore）", () => {
  /** 用真实 resources/builtin-plugins 当 builtinRoot；userSkills 由用例给。不碰任何用户目录。 */
  async function withUserSkills(userSkills: { slug: string; name: string }[]): Promise<{ store: PluginStore; cleanup: () => Promise<void> }> {
    const configDir = await mkdtemp(join(tmpdir(), "orbita-builtin-clash-"));
    const store = new PluginStore({ configDir, secrets: new NoSecrets(), userSkills: async () => userSkills, builtinRoot: BUILTIN });
    return { store, cleanup: () => rm(configDir, { recursive: true, force: true }) };
  }

  test("没有重名：四个内置插件的技能都叠进开轮装配，无冲突", async () => {
    const { store, cleanup } = await withUserSkills([]);
    try {
      const assembled = await store.assemble(null);
      assert.deepEqual(assembled.skills.map((skill) => `${skill.plugin}/${skill.slug}`).sort(), [
        "automation/automation",
        "browser/browser",
        "docs-slides/docs",
        "docs-slides/slides",
        "plugin-creator/board-style",
        "plugin-creator/find-existing",
        "plugin-creator/plugin-creator",
        "reading/reading",
        "skill-kit/find-skills",
        "skill-kit/skill-creator",
        "terminal/terminal",
      ]);
      assert.deepEqual((await store.listViews()).flatMap((view) => view.conflicts), []);
    } finally {
      await cleanup();
    }
  });

  test("用户自己有同名的 find-skills 与 skill-creator：用户的赢，内置那两条不叠，插件页亮冲突；其它内置技能不受影响", async () => {
    const { store, cleanup } = await withUserSkills([
      { slug: "find-skills", name: "find-skills" },
      { slug: "skill-creator", name: "skill-creator" },
    ]);
    try {
      const assembled = await store.assemble(null);
      assert.deepEqual(assembled.skills.filter((skill) => skill.plugin === "skill-kit"), []);
      assert.equal(assembled.skills.filter((skill) => skill.plugin === "plugin-creator").length, 3);
      assert.equal((await store.skillMetas()).some((meta) => meta.slug === "find-skills"), false);
      const view = (await store.listViews()).find((each) => each.id === "plugin:skill-kit");
      assert.deepEqual(view?.conflicts.map((conflict) => conflict.kind), ["skill-name", "skill-name"]);
      // 冲突只是提示：插件仍是启用的内置插件，不被拆掉
      assert.deepEqual(view?.scope, { kind: "global" });
    } finally {
      await cleanup();
    }
  });

  test("只重名一条（用户只有自己的 find-skills）：另一条 skill-creator 照常加载，冲突只报一条", async () => {
    const { store, cleanup } = await withUserSkills([{ slug: "mine", name: "find-skills" }]);
    try {
      const assembled = await store.assemble(null);
      assert.deepEqual(assembled.skills.filter((skill) => skill.plugin === "skill-kit").map((skill) => skill.slug), ["skill-creator"]);
      const view = (await store.listViews()).find((each) => each.id === "plugin:skill-kit");
      assert.equal(view?.conflicts.length, 1);
    } finally {
      await cleanup();
    }
  });
});
