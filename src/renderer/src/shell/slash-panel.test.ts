import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SLASH_PANEL_DESC_MIN,
  SLASH_PANEL_WIDTH,
  moveSlashSelection,
  slashFirstRowOfSection,
  slashRowCount,
  slashSectionIndexOf,
  slashSections,
  slashPanelBox,
} from "./slash-panel.ts";
import type { SkillMeta } from "@shared/skill";

const skills: SkillMeta[] = [
  { slug: "review", name: "review", description: "审 diff", global: true, workspaces: [], linkedPath: "", missing: false },
  { slug: "release-notes", name: "release notes", description: "写发布说明", global: false, workspaces: ["w1"], linkedPath: "", missing: false },
  { slug: "broken", name: "broken", description: "断链", global: false, workspaces: [], linkedPath: "", missing: true },
];
const commands = [
  { kind: "compact" as const, name: "compact", description: "压缩" },
  { kind: "new" as const, name: "new", description: "新会话" },
];
const servers = [
  { name: "miyo", detail: "node mcp.js" },
  { name: "web-search", detail: "https://example.com" },
];

describe("slashSections —— 分节", () => {
  it("主模式：指令 → Skills → MCP；missing 的 skill 不列；空节剔除", () => {
    const sections = slashSections({ atMessageStart: true, query: "", commands, skills, servers });
    assert.deepEqual(
      sections.map((section) => [section.id, section.rows.length]),
      [["commands", 2], ["skills", 2], ["mcp", 2]],
    );
    assert.equal(sections[1]?.rows[0]?.name, "/skill:review");
  });

  it("补全模式（句中）：不列动作项，只 Skills + MCP", () => {
    const sections = slashSections({ atMessageStart: false, query: "", commands, skills, servers });
    assert.deepEqual(sections.map((section) => section.id), ["skills", "mcp"]);
  });

  it("查询词：指令与 MCP 按前缀，skill 主模式子串 / 补全模式严格前缀", () => {
    const main = slashSections({ atMessageStart: true, query: "re", commands, skills, servers });
    // compact / new 不中，review / release-notes 子串命中，server 无 re 前缀
    assert.deepEqual(main.map((section) => section.id), ["skills"]);
    const mid = slashSections({ atMessageStart: false, query: "re", commands, skills, servers });
    assert.deepEqual(mid.map((section) => [section.id, section.rows.length]), [["skills", 2], ]);
    const strict = slashSections({ atMessageStart: false, query: "rele", commands, skills, servers });
    assert.deepEqual(strict.map((section) => section.rows.map((row) => row.name)), [["/skill:release-notes"]]);
    const mcp = slashSections({ atMessageStart: false, query: "mi", commands, skills, servers });
    const row = mcp[0]?.rows[0];
    assert.equal(row !== undefined && row.kind === "mcp" ? row.server : null, "miyo");
  });

  it("三节全空返回空数组（补全模式无命中 → 面板不弹）", () => {
    assert.deepEqual(slashSections({ atMessageStart: false, query: "zzz", commands, skills, servers }), []);
  });
});

describe("导航 —— ↑↓ 跨节线性，←→ 跳节选首项", () => {
  // 2 指令 + 2 skills + 2 mcp = 6 行，三节
  const sections = slashSections({ atMessageStart: true, query: "", commands, skills, servers });

  it("行数与节定位", () => {
    assert.equal(slashRowCount(sections), 6);
    assert.equal(slashSectionIndexOf(sections, 0), 0);
    assert.equal(slashSectionIndexOf(sections, 1), 0);
    assert.equal(slashSectionIndexOf(sections, 2), 1);
    assert.equal(slashSectionIndexOf(sections, 5), 2);
    assert.equal(slashFirstRowOfSection(sections, 2), 4);
    assert.equal(slashFirstRowOfSection(sections, 9), null);
  });

  it("↓ 逐行跨节（1→2 跨到 skills），两端循环；无高亮时 ↓ 落首行、↑ 落末行", () => {
    assert.equal(moveSlashSelection(sections, 1, "down"), 2);
    assert.equal(moveSlashSelection(sections, 5, "down"), 0);
    assert.equal(moveSlashSelection(sections, 0, "up"), 5);
    assert.equal(moveSlashSelection(sections, -1, "down"), 0);
    assert.equal(moveSlashSelection(sections, -1, "up"), 5);
  });

  it("→ 从指令节跳 skills 节并选中第一项；← 从 skills 回指令；循环跨过头尾", () => {
    assert.equal(moveSlashSelection(sections, 0, "right"), 2);
    assert.equal(moveSlashSelection(sections, 2, "left"), 0);
    assert.equal(moveSlashSelection(sections, 4, "right"), 0); // mcp → 指令（循环）
    assert.equal(moveSlashSelection(sections, 0, "left"), 4); // 指令 → mcp（循环）
  });

  it("空面板（无节）原样返回，不动 -1", () => {
    assert.equal(moveSlashSelection([], -1, "down"), -1);
    assert.equal(moveSlashSelection([], 3, "right"), 3);
  });
});

describe("slashPanelBox —— 几何", () => {
  it("常规：宽 400，左缘对齐 /，顶缘在行下方，高 = 三行的量", () => {
    const box = slashPanelBox({ slashLeft: 120, lineBottom: 40, cardWidth: 640, cardBottom: 200 });
    assert.equal(box.left, 120);
    assert.equal(box.top, 44);
    assert.equal(box.width, SLASH_PANEL_WIDTH);
    assert.equal(box.maxHeight, 3 * 30 + 22 + 12);
    assert.equal(box.showDescription, true);
  });

  it("靠右放不下：向左平移，仍留在卡内", () => {
    const box = slashPanelBox({ slashLeft: 500, lineBottom: 40, cardWidth: 640, cardBottom: 200 });
    assert.equal(box.left, 640 - SLASH_PANEL_WIDTH - 4);
  });

  it("卡窄：宽收到卡内，说明隐藏（窄于 DESC_MIN）", () => {
    const box = slashPanelBox({ slashLeft: 10, lineBottom: 40, cardWidth: 300, cardBottom: 200 });
    assert.equal(box.width, 292);
    assert.equal(box.showDescription, false);
  });

  it("到底边不够三行：高度收到可用距离，但至少给一行多；够三行不多占", () => {
    const short = slashPanelBox({ slashLeft: 10, lineBottom: 40, cardWidth: 640, cardBottom: 100 });
    assert.equal(short.maxHeight, 56);
    const tall = slashPanelBox({ slashLeft: 10, lineBottom: 40, cardWidth: 640, cardBottom: 500 });
    assert.equal(tall.maxHeight, 3 * 30 + 22 + 12);
  });
});
