import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCommand } from "../shared/agent-ipc.ts";
import { RequestBroker } from "./request-broker.ts";
import { createTurnTools, extraToolNames, turnToolFlags, type TurnInput } from "./turn-tools.ts";

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
    mode: "skip",
    thinkingLevel: "off",
    piSessionDir: "/tmp/pi",
    attachmentsDir: "/tmp/att",
    protectedPaths: [],
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
    currentMode: () => "skip",
    planOptions: { getMode: () => "skip", planFirst: false, branch: () => [], state: { stopping: false } },
    branch: () => [],
    attachedImages: () => [],
    memoryTurn: () => 1,
  }).map((tool) => tool.name);
}

const CHILD = { workbench: "/tmp/wb", attached: [], related: [{ sessionId: "p", relation: "parent" as const, label: "p", path: "/tmp/p" }] };

describe("turn-tools：两个内核共用的一轮工具装配", () => {
  it("根会话：记忆 / 自动化 / 插件按命令开关装，子会话一律不装", () => {
    const root = submit({ sessionMemory: true, automationTools: true, pluginTools: true });
    assert.deepEqual(turnToolFlags(root), { role: "root", memoryTools: true, automationTools: true, pluginTools: true });
    const child = submit({ sessionMemory: true, automationTools: true, pluginTools: true, directories: CHILD });
    assert.deepEqual(turnToolFlags(child), { role: "child", memoryTools: false, automationTools: false, pluginTools: false });
  });

  it("工具清单与顺序：根会话有 delegate 一组，子会话换成 report_to_parent；可选组接在最后", () => {
    const root = names(submit({ sessionMemory: true, automationTools: true, pluginTools: true }));
    const child = names(submit({ directories: CHILD }));
    assert.ok(root.includes("delegate") && !root.includes("report_to_parent"));
    assert.ok(child.includes("report_to_parent") && !child.includes("delegate"));
    assert.ok(root.indexOf("memory_search") > root.indexOf("delegate"));
    assert.equal(root.at(-1), "automation_update");
    assert.equal(new Set(root).size, root.length, "工具名不重复");
  });

  it("权限段的工具名单含 MCP 工具在前、与注册同一个开关", () => {
    const flags = turnToolFlags(submit({ directories: CHILD }));
    const extra = extraToolNames(["mcp__x__y"], flags);
    assert.equal(extra[0], "mcp__x__y");
    assert.ok(extra.includes("report_to_parent") && !extra.includes("delegate"));
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
  "automation_create", "automation_list", "automation_cancel", "automation_update",
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
