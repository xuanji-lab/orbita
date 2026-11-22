import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { CONNECTORS } from "../../../../shared/connectors.ts";
import {
  ICON_KEYWORDS,
  ICON_TONES,
  VENDORS,
  abilityIconOf,
  connectorOf,
  keywordIcon,
  kindFallbackIcon,
  toneOf,
  tokensOf,
  vendorOf,
  type AbilityIdentity,
} from "./ability-icon.ts";

const id = (origin: AbilityIdentity["origin"], key: string, name = key, description = ""): AbilityIdentity => ({ origin, key, name, description });

describe("关键词表：按名字、再按描述挑一枚 lucide", () => {
  test("论文 / 数据 / 演示 / 图像 / 代码 / 浏览器 / 日程 / 终端", () => {
    assert.equal(keywordIcon("paper-explainer", ""), "book-open");
    assert.equal(keywordIcon("论文讲解", ""), "book-open");
    assert.equal(keywordIcon("vitality-indicator-table", ""), "table");
    assert.equal(keywordIcon("docs-slides", "做演示文稿"), "presentation");
    assert.equal(keywordIcon("演示文稿", ""), "presentation");
    assert.equal(keywordIcon("图像生成", ""), "image");
    assert.equal(keywordIcon("code-review-helper", ""), "code");
    assert.equal(keywordIcon("browser", ""), "globe");
    assert.equal(keywordIcon("日程安排", ""), "calendar");
    assert.equal(keywordIcon("terminal", ""), "terminal");
  });
  test("名字优先于描述；名字没中才看描述", () => {
    assert.equal(keywordIcon("paper-explainer", "mentions video and audio"), "book-open");
    assert.equal(keywordIcon("helper", "把论文讲给你听"), "book-open");
  });
  test("名字里最靠前的词赢；括号里的补充排在后面（「贾维斯路线图（……语音线……）」不是语音）", () => {
    assert.equal(keywordIcon("贾维斯路线图（基础设施优先，语音线最后）", ""), "workflow");
    assert.equal(keywordIcon("paper-reading-session", ""), "book-open");
  });
  test("短词整词才算：client 不是 cli、docker 不是 doc、example 不是 exa", () => {
    assert.equal(keywordIcon("client-tools", ""), "wrench");
    assert.notEqual(keywordIcon("docker-helper", ""), "file-text");
    assert.equal(keywordIcon("cli", ""), "terminal");
    assert.equal(vendorOf({ key: "example-server", name: "example-server" }), undefined);
  });
  test("没有线索返回 undefined；种类兜底：技能 / MCP / 插件各一枚中性的", () => {
    assert.equal(keywordIcon("zzz", "qqq"), undefined);
    assert.equal(kindFallbackIcon("user-skill"), "scroll-text");
    assert.equal(kindFallbackIcon("user-mcp"), "plug");
    assert.equal(kindFallbackIcon("plugin"), "blocks");
  });
  test("表里每个图标都是 Icon.tsx 登记过的（挑了却画不出来就是空方块）", () => {
    const registry = readFileSync(new URL("../../shell/Icon.tsx", import.meta.url), "utf8");
    const names = new Set(ICON_KEYWORDS.map((entry) => entry.icon));
    for (const icon of [...names, "scroll-text", "plug", "blocks"]) {
      assert.ok(registry.includes(`"${icon}"`) || new RegExp(`^  ${icon.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())},$`, "m").test(registry) || registry.includes(`  ${icon},`), `${icon} 没在 Icon.tsx 登记`);
    }
  });
  test("每一行都至少有一个词（空行永远命中不了）", () => {
    for (const entry of ICON_KEYWORDS) assert.ok(entry.en.length + entry.zh.length > 0, entry.icon);
  });
});

describe("连接器：认得出目录里的品牌就用品牌标", () => {
  test("MCP 服务名等于目录写进 mcp.json 的名字", () => {
    assert.equal(connectorOf(id("user-mcp", "github"))?.id, "github");
    assert.equal(connectorOf(id("user-mcp", "tencent-docs"))?.id, "tencent-docs");
    assert.equal(connectorOf(id("user-mcp", "qgis")), undefined);
  });
  test("技能 / 插件名里有品牌词也算；中文名也认", () => {
    assert.equal(connectorOf(id("user-skill", "feishu-doc"))?.id, "feishu");
    assert.equal(connectorOf(id("plugin", "x", "钉钉助手"))?.id, "dingtalk");
    assert.equal(connectorOf(id("plugin", "x", "百度网盘同步"))?.id, "baidu-netdisk");
  });
  test("目录里的每一家都认得出自己的 id", () => {
    for (const entry of CONNECTORS) assert.equal(connectorOf(id("user-skill", `${entry.id}-x`, entry.id))?.id, entry.id, entry.id);
  });
  test("连接器优先于厂商：notion / github 用目录里配好的标", () => {
    const spec = abilityIconOf(id("user-mcp", "notion"));
    assert.equal(spec.kind, "connector");
  });
});

describe("厂商标：只看名字，不看描述", () => {
  test("figma / google-calendar / qwen-image-trx40 / obsidian-markdown 认得出", () => {
    assert.equal(vendorOf({ key: "figma", name: "figma" }), "figma");
    assert.equal(vendorOf({ key: "google-calendar", name: "google-calendar" }), "google");
    assert.equal(vendorOf({ key: "qwen-image-trx40", name: "qwen-image-trx40" }), "qwen");
    assert.equal(vendorOf({ key: "obsidian-markdown", name: "obsidian-markdown" }), "obsidian");
    assert.equal(vendorOf({ key: "capcut-autoedit", name: "AI 剪 CapCut" }), "capcut");
  });
  test("描述里随口提到厂商的技能不顶着它的标", () => {
    const spec = abilityIconOf({ origin: "user-skill", key: "daily-notes", name: "daily-notes", description: "sync notes to Notion and Google Docs" });
    assert.equal(spec.kind, "lucide");
  });
  test("每个登记的厂商都有 SVG 文件，AbilityMark 都导入了", () => {
    const dir = new URL("../../../../../design-system/assets/vendor-logos/", import.meta.url);
    const mark = readFileSync(new URL("./AbilityMark.tsx", import.meta.url), "utf8");
    for (const vendor of VENDORS) {
      assert.ok(existsSync(new URL(`${vendor}.svg`, dir)), `${vendor}.svg 不在 vendor-logos`);
      assert.ok(mark.includes(`vendor-logos/${vendor}.svg?raw`), `${vendor} 没在 AbilityMark 导入`);
    }
    assert.ok(readdirSync(dir).length >= VENDORS.length);
  });
});

describe("淡底色：按名字稳定取自现有的类别色", () => {
  test("同一个名字永远同一色（忽略大小写与首尾空白）；取值只在四档里", () => {
    for (const name of ["paper-explainer", "godot", "qgis", "ORBITA：PR 验收"]) {
      const tone = toneOf(name);
      assert.ok(ICON_TONES.includes(tone));
      assert.equal(toneOf(`  ${name.toUpperCase()} `), toneOf(name.toLowerCase()));
      assert.equal(toneOf(name), tone);
    }
  });
  test("不同名字会分散到几档里（不是全落一色）", () => {
    const names = ["academic-section-flow", "aesthetic-library", "anatomy", "card-styles", "citation-generator", "find-skills", "lit-intake", "skill-creator", "godot", "blender", "miyo", "qgis"];
    const tones = new Set(names.map(toneOf));
    assert.ok(tones.size >= 3, [...tones].join());
  });
  test("lucide 图标的色取自 key（目录名）：改了显示名颜色不跳", () => {
    const a = abilityIconOf({ origin: "user-skill", key: "my-skill", name: "名字一", description: "" });
    const b = abilityIconOf({ origin: "user-skill", key: "my-skill", name: "名字二", description: "" });
    assert.equal(a.kind === "lucide" && b.kind === "lucide" && a.tone === b.tone, true);
  });
});

describe("切词", () => {
  test("英文按非字母数字切、中文连续段保留", () => {
    assert.deepEqual(tokensOf("qwen-image_trx40 论文讲解 v2"), ["qwen", "image", "trx40", "论文讲解", "v2"]);
  });
});
