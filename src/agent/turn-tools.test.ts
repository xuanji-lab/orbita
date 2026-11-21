import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCommand } from "../shared/agent-ipc.ts";
import { RequestBroker } from "./request-broker.ts";
import { CATALOG_BUDGET, formatCapabilityCatalog } from "./capability-catalog.ts";
import { createTurnTools, selectTurnTools, turnToolFlags, withheldToolReceipt, type TurnInput } from "./turn-tools.ts";

type Submit = Extract<AgentCommand, { type: "submit" }>;

function submit(overrides: Partial<Submit> = {}): TurnInput {
  return {
    type: "submit",
    sessionId: "s1",
    text: "hi",
    cwd: "/tmp/ws",
    workspaceId: null,
    provider: { id: "p", api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "k" } as Submit["provider"],
    modelId: "m",
    thinkingLevel: "off",
    piSessionDir: "/tmp/pi",
    attachmentsDir: "/tmp/att",
    protectedPaths: [],
    protectedFiles: [],
    skillsDirs: [],
    mcpServers: {},
    ...overrides,
  };
}

function names(command: TurnInput): string[] {
  const flags = turnToolFlags(command);
  return createTurnTools({
    command,
    flags,
    broker: new RequestBroker(() => undefined),
    mcpTools: [],
    planOptions: { branch: () => [], state: { stopping: false } },
    branch: () => [],
    attachedImages: () => [],
    memoryTurn: () => 1,
  }).map((tool) => tool.name);
}

const CHILD = { workbench: "/tmp/wb", attached: [], related: [{ sessionId: "p", relation: "parent" as const, label: "p", path: "/tmp/p" }] };

describe("turn-tools：两个内核共用的一轮工具装配", () => {
  it("根会话：记忆 / 自动化 / 插件按命令开关装，子会话一律不装", () => {
    const root = submit({ sessionMemory: true, automationTools: true, pluginTools: true });
    assert.deepEqual(turnToolFlags(root), { role: "root", memoryTools: true, automationTools: true, pluginTools: true, mainAgent: false });
    const child = submit({ sessionMemory: true, automationTools: true, pluginTools: true, directories: CHILD });
    assert.deepEqual(turnToolFlags(child), { role: "child", memoryTools: false, automationTools: false, pluginTools: false, mainAgent: false });
    // 主智能体标记只认根会话：带 mainAgent 的子会话（不该出现）也不讲主智能体那段
    assert.equal(turnToolFlags(submit({ mainAgent: true })).mainAgent, true);
    assert.equal(turnToolFlags(submit({ mainAgent: true, directories: CHILD })).mainAgent, false);
  });

  it("pause_subsession 只给主智能体：普通根会话与子会话的工具清单不变", () => {
    assert.ok(names(submit({ mainAgent: true })).includes("pause_subsession"));
    assert.ok(names(submit({ mainAgent: true })).includes("work_cards"));
    assert.ok(!names(submit({})).includes("work_cards"));
    assert.ok(!names(submit({})).includes("pause_subsession"));
    assert.ok(!names(submit({ mainAgent: true, directories: CHILD })).includes("pause_subsession"));
  });

  it("工具清单与顺序：根会话有 delegate 一组，子会话换成 report_to_parent；可选组接在最后", () => {
    const root = names(submit({ sessionMemory: true, automationTools: true, pluginTools: true }));
    const child = names(submit({ directories: CHILD }));
    assert.ok(root.includes("delegate") && !root.includes("report_to_parent"));
    assert.ok(child.includes("report_to_parent") && !child.includes("delegate"));
    assert.ok(root.indexOf("memory_search") > root.indexOf("delegate"));
    assert.equal(root.at(-1), "automation_cancel");
    assert.equal(new Set(root).size, root.length, "工具名不重复");
  });
});

/**
 * 工具名的全序是提示缓存前缀的一部分（两个内核发给模型的工具数组都从这张清单来）：
 * 顺序变了 = 每条会话的缓存从工具清单处失效一次。改顺序必须是有意的，连这张黄金名单一起改。
 */
const ROOT_ORDER = [
  "read_pdf", "read_docx", "show_image", "update_plan", "update_goal", "create_skill", "add_mcp_server",
  "install_plugin", "preview_plugin", "list_plugins", "show_plugin_board", "read_task",
  "browser_navigate", "browser_observe", "browser_extract", "browser_wait_for", "browser_console_messages",
  "browser_network_requests", "browser_screenshot", "browser_tabs", "browser_scroll", "browser_click", "browser_type",
  "browser_press", "request_user_action",
  "slides_create", "slides_read", "slides_write", "slides_edit", "slides_insert_image", "slides_export",
  "doc_open", "doc_insert_image", "doc_export",
  "terminal_open", "terminal_execute", "terminal_read", "terminal_list", "terminal_interrupt", "terminal_close",
  "delegate", "reply_subsession", "model_costs", "memory_search", "memory_revise", "memory_retire",
  "automation_create", "automation_list", "automation_cancel",
];

describe("turn-tools：工具名全序（黄金名单）", () => {
  it("根会话（插件 / 记忆 / 自动化全开）", () => {
    assert.deepEqual(names(submit({ sessionMemory: true, automationTools: true, pluginTools: true })), ROOT_ORDER);
  });

  it("子会话：没有插件 / 记忆 / 自动化，通道工具换成 report_to_parent", () => {
    const childOrder = ROOT_ORDER.filter(
      (name) => !/^(install_plugin|preview_plugin|list_plugins|show_plugin_board|delegate|reply_subsession|model_costs|memory_|automation_)/.test(name),
    );
    assert.deepEqual(names(submit({ sessionMemory: true, automationTools: true, pluginTools: true, directories: CHILD })), [...childOrder, "report_to_parent"]);
  });
});

function selection(command: TurnInput, mcpTools: { name: string }[] = []) {
  return selectTurnTools({
    command,
    flags: turnToolFlags(command),
    broker: new RequestBroker(() => undefined),
    mcpTools: mcpTools.map((tool) => ({ name: tool.name, label: tool.name, description: "d", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [], details: {} }) })),
    planOptions: { branch: () => [], state: { stopping: false } },
    branch: () => [],
    attachedImages: () => [],
    memoryTurn: () => 1,
  });
}

describe("turn-tools：按能力集挑工具", () => {
  const MCP = [{ name: "mcp__zotero__search" }, { name: "mcp__qgis__render" }];

  it("缺席 = 全带：与能力集之前同一份清单、同一顺序，没有被收掉的", () => {
    const child = submit({ directories: CHILD });
    const full = selection(child, MCP);
    assert.deepEqual(full.tools.map((tool) => tool.name), ["mcp__zotero__search", "mcp__qgis__render", ...names(child)]);
    assert.equal(full.withheld.size, 0);
  });

  it("[] = 只带基础：计划、目标、report_to_parent；浏览器 / 幻灯片 / 终端 / MCP 都收掉并记下属于什么", () => {
    const base = selection(submit({ directories: CHILD, capabilities: [] }), MCP);
    assert.deepEqual(base.tools.map((tool) => tool.name), ["update_plan", "update_goal", "report_to_parent"]);
    assert.match(base.withheld.get("browser_navigate") ?? "", /^the browser module: /);
    assert.match(base.withheld.get("slides_write") ?? "", /^the docs-slides module/);
    assert.equal(base.withheld.get("mcp__qgis__render"), 'the MCP server "qgis"');
  });

  it("只读调研：带 browser + pdf-docx + 点名一台 MCP，其余收掉；工具顺序仍是全带时的相对顺序", () => {
    const command = submit({ directories: CHILD, capabilities: ["pdf-docx", "browser", "mcp:zotero"] });
    const picked = selection(command, MCP).tools.map((tool) => tool.name);
    const full = selection(submit({ directories: CHILD }), MCP).tools.map((tool) => tool.name);
    assert.ok(picked.includes("read_pdf") && picked.includes("browser_navigate") && picked.includes("mcp__zotero__search"));
    assert.ok(!picked.includes("mcp__qgis__render") && !picked.includes("terminal_open") && !picked.includes("slides_write"));
    assert.deepEqual(picked, full.filter((name) => picked.includes(name)));
  });

  it('["none"] = 纯聊天：一个工具都不带（连 report_to_parent 也没有，结果由主进程交回）', () => {
    const chat = selection(submit({ directories: CHILD, capabilities: ["none"] }), MCP);
    assert.deepEqual(chat.tools, []);
    assert.equal(chat.withheld.get("report_to_parent"), "any tools (it is chat only)");
  });

  it("缺模块回执：说清这件活没带什么、要用找谁；纯聊天的回执让它在回答里说", () => {
    assert.match(withheldToolReceipt("browser_navigate", "the browser module: x", false), /handed out without the browser module.*report_to_parent \(kind "question"\).*do not report it as failed/);
    assert.match(withheldToolReceipt("read", "any tools (it is chat only)", true), /chat only.*say so in your answer/);
  });
});

describe("turn-tools：能力目录的原料（选择后的非空分组）", () => {
  const ALL_ON = { sessionMemory: true, automationTools: true, pluginTools: true } as const;
  const ids = (command: TurnInput, mcp: { name: string }[] = []) => selection(command, mcp).groups.map((group) => group.id);

  it("分组与 tools 是同一批工具的划分：每个被选中的工具恰在一组里，组序即 tools 先后；不论能力集怎么挑", () => {
    const MCP = [{ name: "mcp__zotero__search" }, { name: "mcp__qgis__render" }];
    for (const command of [
      submit({ ...ALL_ON }),
      submit({ ...ALL_ON, mainAgent: true }),
      submit({ ...ALL_ON, directories: CHILD }),
      submit({ directories: CHILD, capabilities: [] }),
      submit({ directories: CHILD, capabilities: ["pdf-docx", "browser", "mcp:zotero"] }),
      submit({ directories: CHILD, capabilities: ["none"] }),
    ]) {
      const picked = selection(command, MCP);
      assert.deepEqual(picked.groups.flatMap((group) => group.tools), picked.tools.map((tool) => tool.name));
      assert.ok(picked.groups.every((group) => group.tools.length > 0 && group.when !== ""), "没有空组、每组都有何时用");
      assert.equal(new Set(picked.groups.map((group) => group.id)).size, picked.groups.length, "组 id 不重复");
    }
  });

  it("延迟的组：只有浏览器 / 文档幻灯片 / 终端 / 自动化 / 插件 / store / MCP 七组；核心组（读写改跑命令之外的计划、通道、记忆、读任务、PDF / Word、看图）常驻", () => {
    const picked = selection(submit({ ...ALL_ON }), [{ name: "mcp__zotero__search" }]);
    assert.deepEqual(picked.groups.filter((group) => group.deferred === true).map((group) => group.id), ["mcp", "store", "plugins", "browser", "docs-slides", "terminal", "automation"]);
    assert.deepEqual(picked.groups.filter((group) => group.deferred !== true).map((group) => group.id), ["pdf-docx", "image", "plan", "tasks", "channel", "memory"]);
    // deferred 工具名集合 == 延迟组里被选中的全部工具，且是 tools 的子集
    assert.deepEqual([...picked.deferred].sort(), picked.groups.filter((group) => group.deferred === true).flatMap((group) => group.tools).sort());
    assert.ok([...picked.deferred].every((name) => picked.tools.some((tool) => tool.name === name)));
    for (const name of ["update_plan", "update_goal", "delegate", "memory_search", "read_task", "read_pdf", "read_docx", "show_image"]) assert.ok(!picked.deferred.has(name), name);
  });

  it("能力集挑过之后才算延迟：['browser'] 只有浏览器；[] 与纯聊天没有延迟的工具（tool_search 也就不会装）", () => {
    assert.deepEqual([...selection(submit({ directories: CHILD, capabilities: ["browser"] }), [{ name: "mcp__a__b" }]).deferred].every((name) => name.startsWith("browser_") || name === "request_user_action"), true);
    assert.equal(selection(submit({ directories: CHILD, capabilities: [] }), [{ name: "mcp__a__b" }]).deferred.size, 0);
    assert.equal(selection(submit({ directories: CHILD, capabilities: ["none"] }), [{ name: "mcp__a__b" }]).deferred.size, 0);
    assert.equal(selection(submit({ directories: CHILD, capabilities: ["pdf-docx", "image", "tasks"] })).deferred.size, 0);
  });

  it("根会话全开：base 里的计划 / 插件 / 通道 / 记忆 / 自动化各是一组，MCP 单独一组", () => {
    assert.deepEqual(ids(submit({ ...ALL_ON }), [{ name: "mcp__zotero__search" }]), [
      "mcp", "pdf-docx", "image", "plan", "store", "plugins", "tasks", "browser", "docs-slides", "terminal", "channel", "memory", "automation",
    ]);
  });

  it("子会话不含没注册的插件 / 记忆 / 自动化；通道一组讲的是向上汇报", () => {
    const child = selection(submit({ ...ALL_ON, directories: CHILD }));
    const got = child.groups.map((group) => group.id);
    for (const absent of ["plugins", "memory", "automation", "mcp"]) assert.ok(!got.includes(absent), absent);
    const channel = child.groups.find((group) => group.id === "channel");
    assert.deepEqual(channel?.tools, ["report_to_parent"]);
    assert.match(channel?.when ?? "", /handed you this work/);
  });

  it("普通根会话与主智能体：通道一组的说法不同，主智能体多了查看 / 暂停的工具", () => {
    const plain = selection(submit({})).groups.find((group) => group.id === "channel");
    const main = selection(submit({ mainAgent: true })).groups.find((group) => group.id === "channel");
    assert.ok(main !== undefined && plain !== undefined);
    assert.ok(main.tools.includes("work_cards") && main.tools.includes("pause_subsession") && !plain.tools.includes("work_cards"));
    assert.notEqual(main.when, plain.when);
  });

  it('["none"] 没有任何分组；[] 只有基础那几组；["browser"] 只有浏览器加基础，没有幻灯片 / 终端 / MCP', () => {
    assert.deepEqual(ids(submit({ directories: CHILD, capabilities: ["none"] }), [{ name: "mcp__qgis__render" }]), []);
    assert.deepEqual(ids(submit({ directories: CHILD, capabilities: [] }), [{ name: "mcp__qgis__render" }]), ["plan", "channel"]);
    assert.deepEqual(ids(submit({ directories: CHILD, capabilities: ["browser"] }), [{ name: "mcp__qgis__render" }]), ["plan", "browser", "channel"]);
  });

  it("MCP 一组只含能力集点名的服务的工具", () => {
    const picked = selection(submit({ directories: CHILD, capabilities: ["mcp:zotero"] }), [{ name: "mcp__zotero__search" }, { name: "mcp__qgis__render" }]);
    assert.deepEqual(picked.groups.find((group) => group.id === "mcp")?.tools, ["mcp__zotero__search"]);
  });

  it("新增 MCP 服务 / 新工具自然出现在目录里，不用改名单", () => {
    const one = formatCapabilityCatalog(selection(submit({}), [{ name: "mcp__zotero__search" }]).groups, []);
    const two = formatCapabilityCatalog(selection(submit({}), [{ name: "mcp__zotero__search" }, { name: "mcp__newserver__go" }]).groups, []);
    assert.match(one, /servers: zotero\)/);
    assert.match(two, /servers: newserver, zotero\)/);
  });

  it("最坏情形的真实目录（主智能体、全开、四十台名字很长的 MCP、skill 都在）不超目录预算（1800 字符），关键 Orbita 自有组一个不少", () => {
    const mcp = Array.from({ length: 40 }, (_, i) => ({ name: `mcp__${"s".repeat(55)}${String(i).padStart(2, "0")}__t` }));
    const skills = ["reading", "browser", "docs", "slides", "terminal", "plugin-creator", "automation", "skill-creator"];
    const picked = selection(submit({ ...ALL_ON, mainAgent: true }), mcp);
    const text = formatCapabilityCatalog(picked.groups, skills);
    assert.ok(text.length <= CATALOG_BUDGET, `${text.length}`);
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, picked.groups.length);
    for (const id of ["plan", "plugins", "channel", "memory", "automation", "store"]) assert.ok(text.includes(`- ${id} (`), id);
  });
});
