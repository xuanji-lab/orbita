/**
 * 插件工具（实验功能 plugins）的账：参数校验、参数翻成 pluginInstallRequest / pluginListRequest、
 * 回执翻成工具结果、这一轮被停掉就放手。落地在主进程（main/plugin/agent-requests.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createPluginTools, describeInstalled, describePlugins, PLUGIN_TOOL_NAMES } from "./plugin-tools.ts";

const setup = (): { tools: ReturnType<typeof createPluginTools>; sent: Record<string, unknown>[]; broker: RequestBroker } => {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => {
    sent.push(event as Record<string, unknown>);
  });
  return { tools: createPluginTools(broker, "session-1"), sent, broker };
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

  test("参数翻成 pluginInstallRequest（带 sessionId）；回执 ok → 告诉模型已装、范围、技能；链接所以改动下一轮生效", async () => {
    const { tools, sent, broker } = setup();
    const pending = install(tools).execute("c1", { path: "  /ws/plugins/lit  ", scope: "workspace" }, undefined, undefined, undefined as never);
    const request = sent[0];
    assert.equal(request?.["type"], "pluginInstallRequest");
    assert.equal(request?.["sessionId"], "session-1");
    assert.equal(request?.["path"], "/ws/plugins/lit");
    assert.equal(request?.["scope"], "workspace");
    broker.resolve(String(request?.["requestId"]), { ok: true, name: "lit", scope: "workspace", already: false, skills: ["lit-scan"], mcp: [], dataDir: "/u/plugin-data/lit" });
    const result = await pending;
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Installed plugin "lit" for this workspace/);
    assert.match(text, /skills: lit-scan/);
    assert.match(text, /next turn/);
    assert.match(text, /Plugin data folder: \/u\/plugin-data\/lit .*actions\.jsonl/);
  });

  test("scope 省略 → 请求里为 null（由主进程按会话归属定默认）", () => {
    const { tools, sent } = setup();
    void install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    assert.equal(sent[0]?.["scope"], null);
  });

  test("回执失败（拒绝 / 越界 / 清单有问题）→ 抛错，原因原样给模型", async () => {
    const { tools, sent, broker } = setup();
    const pending = install(tools).execute("c1", { path: "/p" }, undefined, undefined, undefined as never);
    broker.resolve(String(sent[0]?.["requestId"]), { ok: false, error: "The user declined to install the plugin." });
    await assert.rejects(pending, /The user declined/);
  });

  test("参数校验：缺 path / 空 path / 非法 scope 直接报，不发请求", async () => {
    const { tools, sent } = setup();
    await assert.rejects(install(tools).execute("c1", {}, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: "   " }, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: 5 }, undefined, undefined, undefined as never), /non-empty path/);
    await assert.rejects(install(tools).execute("c1", { path: "/p", scope: "everywhere" }, undefined, undefined, undefined as never), /scope must be/);
    assert.equal(sent.length, 0);
  });

  test("等用户点卡的时候这一轮被停掉：立刻放手（Stopped），不挂着", async () => {
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

  test("说明里讲了会弹确认卡、链接安装、先在弹卡前报错", () => {
    const { tools } = setup();
    const description = install(tools).description;
    assert.match(description, /confirmation card/);
    assert.match(description, /LINK/);
    assert.match(description, /BEFORE the card/);
    assert.match(description, /<workspace>\/plugins\/<name>\//);
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

describe("回给模型的话", () => {
  test("describeInstalled：already 不说「装好了」而说没弹卡；global 说所有工作区；带 MCP", () => {
    assert.match(describeInstalled({ ok: true, name: "x", scope: "global", already: false, skills: [], mcp: ["srv"], dataDir: "" }), /for all workspaces \(MCP servers: srv\)/);
    const already = describeInstalled({ ok: true, name: "x", scope: "workspace", already: true, skills: ["a", "b"], mcp: [], dataDir: "/d" });
    assert.match(already, /already installed/);
    assert.match(already, /no card was shown/);
  });

  test("describePlugins：空清单有话说；没描述写占位", () => {
    assert.equal(describePlugins({ ok: true, plugins: [] }), "No plugins are enabled in this workspace.");
    assert.match(describePlugins({ ok: true, plugins: [{ name: "a", description: "", origin: "plugin", skills: [], mcp: [], workflow: [], root: "/a", dataDir: "" }] }), /\(no description\)/);
  });
});
