import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginView } from "../../../../shared/plugin.ts";
import { EMPTY_PLUGIN_IO } from "../../../../shared/plugin-board.ts";
import { changedSections, detailParts, sectionFilled, sectionSignatures, waitCount } from "./detail-sections.ts";

function view(over: Partial<PluginView> = {}): PluginView {
  return {
    id: "plugin:x",
    origin: "plugin",
    name: "x",
    description: "",
    author: null,
    version: null,
    license: null,
    scope: { kind: "off" },
    placement: null,
    contents: { skills: 0, mcp: 0, scripts: false },
    skills: [],
    workflow: [],
    io: EMPTY_PLUGIN_IO,
    external: [],
    board: null,
    tuned: false,
    mcp: [],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: null,
    location: null,
    ...over,
  };
}

const step = (wait: "board" | "chat" | null) => ({ title: "t", skill: null, skillSlug: null, detail: null, output: null, wait });
const board = { title: "t", spec: null, cards: [{ id: "a", title: "a", size: "1x1" as const, note: null, template: "./a.html", data: null, sample: null, repeat: null }] };

describe("sectionFilled", () => {
  test("空草稿：所有节都没写", () => {
    for (const section of ["abilities", "io", "workflow", "board", "config", "scope", "source"] as const) assert.equal(sectionFilled(view(), section), false, section);
  });

  test("各节各看各的字段：技能 / 外接 / 脚本都算「它能做什么」写过了", () => {
    assert.equal(sectionFilled(view({ skills: [{ slug: "a", name: "a", description: "" }] }), "abilities"), true);
    assert.equal(sectionFilled(view({ external: [{ name: "s", kind: "api", account: null, resident: null, note: null }] }), "abilities"), true);
    assert.equal(sectionFilled(view({ contents: { skills: 0, mcp: 0, scripts: true } }), "abilities"), true);
    assert.equal(sectionFilled(view({ io: { reads: [{ path: "a", note: null, when: null }], writes: [] } }), "io"), true);
    assert.equal(sectionFilled(view({ workflow: [step(null)] }), "workflow"), true);
    assert.equal(sectionFilled(view({ board }), "board"), true);
  });

  test("「要你填的」：有配置项算写了；没有配置项但技能已聊过也算（没有就是没有）；什么都没聊时是虚线", () => {
    assert.equal(sectionFilled(view(), "config"), false);
    assert.equal(sectionFilled(view({ skills: [{ slug: "a", name: "a", description: "" }] }), "config"), true);
  });

  test("装在哪 / 来源与版本：草稿恒为没有（装上时才定）", () => {
    const full = view({ skills: [{ slug: "a", name: "a", description: "" }], board });
    assert.equal(sectionFilled(full, "scope"), false);
    assert.equal(sectionFilled(full, "source"), false);
  });
});

describe("changedSections", () => {
  test("第一次读到（没有上一次）：没有变化，整页不全亮", () => {
    assert.deepEqual(changedSections(null, sectionSignatures(view({ board }))), []);
  });

  test("某一节从没写到写了 / 写了又改：只那一节变", () => {
    const empty = sectionSignatures(view());
    const withBoard = sectionSignatures(view({ board }));
    assert.deepEqual(changedSections(empty, withBoard), ["board"]);
    const edited = sectionSignatures(view({ board: { ...board, title: "改了" } }));
    assert.deepEqual(changedSections(withBoard, edited), ["board"]);
    assert.deepEqual(changedSections(edited, edited), []);
  });

  test("同时写了几节：都标出来；标题 / 描述变了不算任何一节", () => {
    const before = sectionSignatures(view());
    const after = sectionSignatures(view({ name: "改名", description: "新描述", workflow: [step(null)], io: { reads: [], writes: [{ path: "a", note: null, when: null }] } }));
    assert.deepEqual(changedSections(before, after), ["io", "workflow"]);
  });
});

describe("waitCount", () => {
  test("数 board / chat 的步骤", () => {
    assert.equal(waitCount([]), 0);
    assert.equal(waitCount([step(null), step("board"), step("chat"), step(null)]), 2);
  });
});

describe("detailParts：详情页按种类画哪几块", () => {
  const missingProblem = { kind: "skill-folder-missing" as const, detail: "gone" };

  test("你的技能：内容三格 + 在哪儿可用；没有状态 / 工具 / 命令，也没有三选一的「装在哪」与来源版本", () => {
    const parts = detailParts(view({ origin: "user-skill" }));
    assert.equal(parts.skillContent, true);
    assert.equal(parts.availability, true);
    assert.equal(parts.skillMissing, false);
    assert.deepEqual([parts.mcpStatus, parts.mcpSwitch, parts.mcpTools, parts.mcpCommand], [false, false, false, false]);
    assert.deepEqual([parts.pluginScope, parts.abilities, parts.source, parts.lead], [false, false, false, false]);
  });

  test("断链的技能：不给编辑也不给范围，只有清理断链的提示", () => {
    const parts = detailParts(view({ origin: "user-skill", problems: [missingProblem] }));
    assert.deepEqual([parts.skillContent, parts.availability, parts.skillMissing], [false, false, true]);
  });

  test("你的 MCP：状态（含启用开关）、工具、命令、在哪儿可用；没有技能内容", () => {
    const parts = detailParts(view({ origin: "user-mcp" }));
    assert.deepEqual([parts.mcpStatus, parts.mcpSwitch, parts.mcpTools, parts.mcpCommand, parts.availability], [true, true, true, true, true]);
    assert.deepEqual([parts.skillContent, parts.skillMissing, parts.pluginScope, parts.abilities, parts.source], [false, false, false, false, false]);
  });

  test("真插件：技能只读（没有内容编辑）、MCP 没有单独的启用开关；走「装在哪」三选一", () => {
    // 带着技能和 MCP 的插件：照样不出现技能编辑与 MCP 开关
    const parts = detailParts(view({ origin: "plugin", skills: [{ slug: "s", name: "s", description: "d" }], mcp: [{ name: "m", qualified: "plugin_x_m", transport: "stdio", commandLine: "npx m", problem: null }] }));
    assert.deepEqual([parts.skillContent, parts.skillMissing, parts.mcpSwitch, parts.availability], [false, false, false, false]);
    assert.deepEqual([parts.pluginScope, parts.abilities, parts.source, parts.lead], [true, true, true, true]);
  });
});
