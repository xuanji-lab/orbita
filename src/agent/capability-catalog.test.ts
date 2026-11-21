import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCapabilityCatalog, type CatalogGroup } from "./capability-catalog.ts";

const group = (id: string, tools: string[], extra: Partial<CatalogGroup> = {}): CatalogGroup => ({ id, when: `when ${id}`, tools, ...extra });

describe("capability-catalog：格式化", () => {
  it("没有分组 = 空串（这一段就不出现）", () => {
    assert.equal(formatCapabilityCatalog([], ["browser"]), "");
  });

  it("每组恰好一行：组 id、入口（第一个工具）与其余个数、何时用；不列组内全部工具名", () => {
    const text = formatCapabilityCatalog([group("browser", ["browser_navigate", "browser_click", "browser_type"]), group("image", ["show_image"])], []);
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(lines, ["- browser (browser_navigate +2): when browser", "- image (show_image): when image"]);
    assert.ok(!text.includes("browser_click"));
  });

  it("新工具进组自然出现：入口计数变，不需要改任何名单", () => {
    const before = formatCapabilityCatalog([group("terminal", ["terminal_open", "terminal_read"])], []);
    const after = formatCapabilityCatalog([group("terminal", ["terminal_open", "terminal_read", "terminal_new_tool"])], []);
    assert.match(before, /terminal \(terminal_open \+1\)/);
    assert.match(after, /terminal \(terminal_open \+2\)/);
  });

  it("skill 只在这一轮技能索引里真有它时才指过去；多个用复数", () => {
    const g = group("docs-slides", ["slides_create"], { skills: ["docs", "slides"] });
    assert.match(formatCapabilityCatalog([g], ["docs", "slides"]), /\(skills: docs, slides\)$/m);
    assert.match(formatCapabilityCatalog([g], ["slides"]), /\(skill: slides\)$/m);
    // 没有 skill 可指：一行也不带 skill 字样，连那句「先读 skill」的说明也不占字
    assert.doesNotMatch(formatCapabilityCatalog([g], []), /skill/);
    assert.match(formatCapabilityCatalog([g], ["docs"]), /A named skill has the full how-to/);
    // 目录只写 skill 名，不带正文
    assert.doesNotMatch(formatCapabilityCatalog([g], ["docs", "slides"]), /SKILL\.md/);
  });

  it("MCP 按服务名归纳成一行：去重、按字典序、不出现 125 个工具名", () => {
    const tools = [
      ...Array.from({ length: 125 }, (_, i) => `mcp__qgis__tool_${i}`),
      "mcp__zotero__search",
      "mcp__zotero__add",
      "mcp__alpha__x",
    ];
    const text = formatCapabilityCatalog([group("mcp", tools)], []);
    assert.match(text, /- mcp \(servers: alpha, qgis, zotero\): when mcp/);
    assert.ok(!text.includes("tool_1"));
  });

  it("服务很多时 MCP 行用「+N more」收口，不随服务数无限变长", () => {
    const few = formatCapabilityCatalog([group("mcp", ["mcp__a__t", "mcp__b__t"])], []);
    const many = formatCapabilityCatalog([group("mcp", Array.from({ length: 200 }, (_, i) => `mcp__server${String(i).padStart(3, "0")}__t`))], []);
    assert.match(many, /\+\d+ more\)/);
    assert.ok(many.length < few.length + 120, `${many.length} vs ${few.length}`);
  });

  it("同样的输入逐字节相同", () => {
    const groups = [group("mcp", ["mcp__b__x", "mcp__a__y"]), group("plan", ["update_plan"])];
    assert.equal(formatCapabilityCatalog(groups, ["x"]), formatCapabilityCatalog(structuredClone(groups), ["x"]));
  });
});
