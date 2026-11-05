/**
 * 插件工具（实验功能 plugins）的账：参数校验、参数翻成 pluginInstallRequest / pluginPreviewRequest / pluginListRequest、
 * 回执翻成工具结果（含那一行的 details）、这一轮被停掉就放手。落地在主进程（main/plugin/agent-requests.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import type { PermissionMode } from "../shared/permission.ts";
import type { PluginInstallRow } from "../shared/plugin.ts";
import type { PluginBoardResult } from "../shared/plugin-board.ts";
import { createPluginTools, describeBoard, describeInstalled, describePlugins, describePreview, PLUGIN_TOOL_NAMES } from "./plugin-tools.ts";

const setup = (mode: PermissionMode = "skip"): { tools: ReturnType<typeof createPluginTools>; sent: Record<string, unknown>[]; broker: RequestBroker } => {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => {
    sent.push(event as Record<string, unknown>);
  });
  return { tools: createPluginTools(broker, "session-1", () => mode), sent, broker };
};

const ROW: PluginInstallRow = {
  state: "installed",
  reason: null,
  name: "lit",
  displayName: "文献追踪",
  path: "/ws/plugins/lit",
  scope: "workspace",
  workspaceName: "文献组",
  skills: ["lit-scan"],
  commands: [],
  fingerprint: "abc",
};

const preview = (tools: ReturnType<typeof createPluginTools>) => {
  const tool = tools.find((each) => each.name === "preview_plugin");
  assert.ok(tool !== undefined);
  return tool;
};

const install = (tools: ReturnType<typeof createPluginTools>) => {
  const tool = tools.find((each) => each.name === "install_plugin");
  assert.ok(tool !== undefined);
  return tool;
};

describe("install_plugin", () => {
  test("工具名与权限名单对得上", () => {
    const { tools } = setup();
    assert.deepEqual(tools.map((tool) => tool.name), [...PLUGIN_TOOL_NAMES]);
  });

  test("参数翻成 pluginInstallRequest（带 sessionId 与此刻的权限档）；回执 installed → 告诉模型已装、范围、技能，那一行进 details", async () => {
    const { tools, sent, broker } = setup("skip");
    const pending = install(tools).execute("c1", { path: "  /ws/plugins/lit  ", scope: "workspace" }, undefined, undefined, undefined as never);
    const request = sent[0];
    assert.equal(request?.["type"], "pluginInstallRequest");
    assert.equal(request?.["sessionId"], "session-1");
    assert.equal(request?.["path"], "/ws/plugins/lit");
    assert.equal(request?.["scope"], "workspace");
    assert.equal(request?.["mode"], "skip");
    broker.resolve(String(request?.["requestId"]), { ok: true, kind: "installed", name: "lit", scope: "workspace", skills: ["lit-scan"], mcp: [], dataDir: "/u/plugin-data/lit", row: ROW });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Installed plugin "lit" for this workspace/);
    assert.match(text, /skills: lit-scan/);
    assert.match(text, /next turn/);
    assert.match(text, /Plugin data folder: \/u\/plugin-data\/lit .*actions\.jsonl/);
    assert.deepEqual(result.details, { pluginInstall: ROW });
  });

  test("权限档每次现读：会话中途切到 manual，下一次请求带的就是 manual", () => {
    let mode: PermissionMode = "skip";
    const sent: Record<string, unknown>[] = [];
    const broker = new RequestBroker((event) => {
      sent.push(event as Record<string, unknown>);
    });
    const tools = createPluginTools(broker, "s", () => mode);
    void install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    mode = "manual";
    void install(tools).execute("c2", { path: "/p" }, undefined, undefined, undefined as never);
    assert.deepEqual(sent.map((event) => event["mode"]), ["skip", "manual"]);
  });

  test("回执 pending：不说「装好了」，告诉模型没装、为什么、结束这一轮、别再调；那一行进 details", async () => {
    const { tools, sent, broker } = setup("skip");
    const pending = install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    const row: PluginInstallRow = { ...ROW, state: "pending", reason: "mcp", commands: ["node server.js"] };
    broker.resolve(String(sent[0]?.["requestId"]), { ok: true, kind: "pending", name: "lit", scope: "workspace", skills: ["lit-scan"], mcp: ["srv"], row });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Not installed yet/);
    assert.match(text, /was NOT installed because it starts an MCP server/);
    assert.match(text, /\[Install\] and \[Details\]/);
    assert.match(text, /End your turn now/);
    assert.match(text, /Do not repeat the command or the reason/);
    assert.match(text, /do not call install_plugin again/);
    assert.doesNotMatch(text, /^Installed plugin/);
    assert.deepEqual(result.details, { pluginInstall: row });
  });

  test("回执 already：没有那一行（details 为空），话里说明没有新东西", async () => {
    const { tools, sent, broker } = setup();
    const pending = install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: true, kind: "already", name: "lit", scope: "workspace", skills: ["lit-scan"], mcp: [], dataDir: "/d", row: null });
    const result = await pending;
    assert.equal(result.details, undefined);
    assert.match((result.content[0] as { text: string }).text, /already installed/);
  });

  test("scope 省略 → 请求里为 null（由主进程按会话归属定默认）", () => {
    const { tools, sent } = setup();
    void install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    assert.equal(sent[0]?.["scope"], null);
  });

  test("回执失败（越界 / 清单有问题）→ 抛错，原因原样给模型", async () => {
    const { tools, sent, broker } = setup();
    const pending = install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: false, error: "The plugin folder has problems" });
    await assert.rejects(pending, /has problems/);
  });

  test("参数校验：缺 path / 空 path / 非法 scope 直接报，不发请求", async () => {
    const { tools, sent } = setup();
    await assert.rejects(install(tools).execute("c1", {}, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: "   " }, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: 5 }, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: "/p", scope: "everywhere" }, undefined, undefined, undefined as never), /scope must be/);
    assert.equal(sent.length, 0);
  });

  test("这一轮被停掉：立刻放手（Stopped），不挂着", async () => {
    const { tools } = setup();
    const controller = new AbortController();
    const pending = install(tools).execute("c1", { path: "/p" }, controller.signal, undefined, undefined as never);
    controller.abort();
    await assert.rejects(pending, /Stopped/);
    // 已经停了再调：不发请求
    const { tools: again, sent } = setup();
    await assert.rejects(install(again).execute("c2", { path: "/p" }, controller.signal, undefined, undefined as never), /Stopped/);
    assert.equal(sent.length, 0);
  });

  test("不再挂起等用户：请求不带 15 分钟超时（走 broker 的默认兜底），说明里没有「等用户点」", () => {
    const { tools } = setup();
    const description = install(tools).description;
    assert.doesNotMatch(description, /waits until they press/);
    assert.doesNotMatch(description, /confirmation card/);
    assert.match(description, /returns immediately; it never waits for the user/);
  });

  test("说明里讲了先在对话里问一句、两种结局、链接安装、范围、路径", () => {
    const { tools } = setup();
    const description = install(tools).description;
    assert.match(description, /FIRST ask the user, in one plain sentence/);
    assert.match(description, /"Installed"/);
    assert.match(description, /"Not installed yet"/);
    assert.match(description, /Manual permission mode/);
    assert.match(description, /LINK/);
    assert.match(description, /<workspace>\/plugins\/<name>\//);
  });
});

describe("preview_plugin", () => {
  test("参数翻成 pluginPreviewRequest；回执 → 告诉模型右栏现在显示草稿、之后自己刷新别再调、要修的东西", async () => {
    const { tools, sent, broker } = setup();
    const pending = preview(tools).execute("c1", { path: " /ws/plugins/lit " }, undefined, undefined, undefined as never);
    assert.equal(sent[0]?.["type"], "pluginPreviewRequest");
    assert.equal(sent[0]?.["sessionId"], "session-1");
    assert.equal(sent[0]?.["path"], "/ws/plugins/lit");
    broker.resolve(String(sent[0]?.["requestId"]), {
      ok: true,
      name: "lit",
      path: "/ws/plugins/lit",
      skills: [],
      workflow: ["扫"],
      boardFiles: [{ card: "today", key: "template", path: "./board/today.html", exists: true }, { card: null, key: "spec", path: "./board/spec.md", exists: false }],
      issues: ["orbita.board.spec points at ./board/spec.md, which does not exist"],
      installed: false,
    });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /right pane now shows the draft "lit"/);
    assert.match(text, /do not need to call preview_plugin again/);
    assert.match(text, /skills: none yet/);
    assert.match(text, /today\.template \.\/board\/today\.html; spec \.\/board\/spec\.md \(MISSING\)/);
    assert.match(text, /Things to fix/);
    assert.equal(result.details, undefined);
  });

  test("失败回执（越界 / 不是插件）→ 抛错；缺 path 不发请求", async () => {
    const { tools, sent, broker } = setup();
    const pending = preview(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: false, error: "outside this session's workspace" });
    await assert.rejects(pending, /outside this session's workspace/);
    await assert.rejects(preview(tools).execute("c2", {}, undefined, undefined, undefined as never), /non-empty path/);
    assert.equal(sent.length, 1);
  });

  test("说明里讲了「只显示不安装」「调一次、之后自己刷新」，看板口径（board）不是 panel", () => {
    const { tools } = setup();
    const description = preview(tools).description;
    assert.match(description, /WITHOUT installing it/);
    assert.match(description, /do NOT call it again after each edit/);
    assert.match(description, /board files/);
    assert.doesNotMatch(description, /panel/);
  });
});

describe("list_plugins", () => {
  test("发 pluginListRequest，回执翻成可读清单", async () => {
    const { tools, sent, broker } = setup();
    const tool = tools.find((each) => each.name === "list_plugins");
    assert.ok(tool !== undefined);
    const pending = tool.execute("c1", {}, undefined, undefined, undefined as never);
    assert.equal(sent[0]?.["type"], "pluginListRequest");
    broker.resolve(String(sent[0]?.["requestId"]), {
      ok: true,
      plugins: [{ name: "plugin-creator", description: "做插件", origin: "builtin", skills: ["plugin-creator"], mcp: [], workflow: ["找现成的", "装上"], root: "/r/plugin-creator", dataDir: "/d/plugin-creator" }],
    });
    const text = ((await pending).content[0] as { text: string }).text;
    assert.match(text, /plugin-creator \(built into Orbita\): 做插件/);
    assert.match(text, /workflow: 1\. 找现成的 → 2\. 装上/);
    assert.match(text, /folder: \/r\/plugin-creator/);
    assert.match(text, /data folder: \/d\/plugin-creator/);
  });

  test("失败回执抛错", async () => {
    const { tools, sent, broker } = setup();
    const tool = tools.find((each) => each.name === "list_plugins");
    assert.ok(tool !== undefined);
    const pending = tool.execute("c1", {}, undefined, undefined, undefined as never);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: false, error: "turned off" });
    await assert.rejects(pending, /turned off/);
  });
});

const BOARD: PluginBoardResult = {
  plugin: "lit",
  displayName: "文献追踪",
  title: "今日文献",
  source: "installed",
  draftPath: null,
  at: 1,
  tuned: false,
  cards: [{ id: "today", title: "今日一篇", size: "1x1", index: 0, template: "a".repeat(64), data: { t: 1 }, state: "ready", usingSample: true, updatedAt: null }],
  skipped: [{ id: "big", reason: "too-large", detail: "0: 300000 bytes" }],
};

describe("show_plugin_board", () => {
  test("发 pluginBoardRequest（cards 缺席 = null），回执的看板原样放进 details.pluginBoard", async () => {
    const { tools, sent, broker } = setup();
    const tool = tools.find((each) => each.name === "show_plugin_board");
    assert.ok(tool !== undefined);
    const pending = tool.execute("c1", { plugin: " lit " }, undefined, undefined, undefined as never);
    assert.deepEqual({ ...sent[0], requestId: "" }, { type: "pluginBoardRequest", sessionId: "session-1", plugin: "lit", cards: null, requestId: "" });
    broker.resolve(String(sent[0]?.["requestId"]), { ok: true, board: BOARD });
    const result = await pending;
    assert.deepEqual(result.details, { pluginBoard: BOARD });
    assert.match((result.content[0] as { text: string }).text, /Shown 1 card of "文献追踪"/);
  });

  test("cards 透传；参数不对 / 失败回执抛错", async () => {
    const { tools, sent, broker } = setup();
    const tool = tools.find((each) => each.name === "show_plugin_board");
    assert.ok(tool !== undefined);
    await assert.rejects(tool.execute("c0", { plugin: "" }, undefined, undefined, undefined as never), /non-empty/);
    await assert.rejects(tool.execute("c0", { plugin: "lit", cards: "today" }, undefined, undefined, undefined as never), /array/);
    const pending = tool.execute("c1", { plugin: "lit", cards: ["today"] }, undefined, undefined, undefined as never);
    assert.deepEqual(sent[0]?.["cards"], ["today"]);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: false, error: "not installed" });
    await assert.rejects(pending, /not installed/);
  });

  test("describeBoard：tuned 两种话术；样例与没放进来的卡都告诉模型", () => {
    const loose = describeBoard(BOARD);
    assert.match(loose, /tuned=false/);
    assert.match(loose, /say what you did, and ask the user to point out anything wrong/);
    assert.doesNotMatch(loose, /Do not explain/);
    assert.match(loose, /SAMPLE data.*today/);
    assert.match(loose, /big: too-large \(0: 300000 bytes\)/);
    const tuned = describeBoard({ ...BOARD, tuned: true, skipped: [], cards: [] });
    assert.match(tuned, /Shown 0 cards/);
    assert.match(tuned, /Do not explain them again unless the user asks/);
    assert.doesNotMatch(tuned, /point out anything wrong/);
    assert.doesNotMatch(tuned, /Not shown/);
  });
});

describe("回给模型的话", () => {
  test("describeInstalled：global 说所有工作区；带 MCP；already 说没有新东西；pending 说没装", () => {
    const global = describeInstalled({ ok: true, kind: "installed", name: "x", scope: "global", skills: [], mcp: ["srv"], dataDir: "", row: { ...ROW, scope: "global" } });
    assert.match(global, /for all workspaces \(MCP servers: srv\)/);
    const already = describeInstalled({ ok: true, kind: "already", name: "x", scope: "workspace", skills: ["a", "b"], mcp: [], dataDir: "/d", row: null });
    assert.match(already, /already installed/);
    assert.match(already, /nothing new was shown/);
    const manual = describeInstalled({ ok: true, kind: "pending", name: "x", scope: "workspace", skills: [], mcp: [], row: { ...ROW, state: "pending", reason: "manual" } });
    assert.match(manual, /Manual permission mode/);
    const everywhere = describeInstalled({ ok: true, kind: "pending", name: "x", scope: "global", skills: [], mcp: [], row: { ...ROW, state: "pending", reason: "global", scope: "global" } });
    assert.match(everywhere, /enabled for all workspaces/);
  });

  test("describePreview：已装同名时提醒；没有 issues 就没有「Things to fix」", () => {
    const text = describePreview({ ok: true, name: "lit", path: "/p", skills: ["a"], workflow: [], boardFiles: [], issues: [], installed: true });
    assert.match(text, /already installed/);
    assert.match(text, /workflow: not written yet/);
    assert.match(text, /board files: none declared/);
    assert.doesNotMatch(text, /Things to fix/);
  });

  test("describePlugins：空清单有话说；没描述写占位", () => {
    assert.equal(describePlugins({ ok: true, plugins: [] }), "No plugins are enabled in this workspace.");
    assert.match(describePlugins({ ok: true, plugins: [{ name: "a", description: "", origin: "plugin", skills: [], mcp: [], workflow: [], root: "/a", dataDir: "" }] }), /\(no description\)/);
  });
});
