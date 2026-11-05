/**
 * agent 的 install_plugin / preview_plugin / list_plugins 在主进程的账：真 PluginStore（临时目录）+ 假端口。
 * 重点：路径越界、自己写错的东西先拦下、低风险直接装 / 需要看一眼只留一行不装、点那一行才装
 * （重开后、文件夹被改后）、草稿预览只扫描不装。没有任何一个请求会等用户。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import { parsePluginInstallRow, type PluginAgentInstallOutcome, type PluginInstallRow } from "../../shared/plugin.ts";
import type { SecretsPort } from "../provider/store.ts";
import { PluginAgentRequests, draftPanelFiles, fingerprintOf, locateInside, needsLook, type PluginDraftEvent } from "./agent-requests.ts";
import { PluginStore } from "./store.ts";

class FakeSecrets implements SecretsPort {
  readonly map = new Map<string, string>();
  async set(account: string, plaintext: string): Promise<void> {
    this.map.set(account, plaintext);
  }
  async get(account: string): Promise<string | null> {
    return this.map.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.map.delete(account);
  }
}

const SKILL = (name: string, description = "做一件事"): string => `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;

async function put(root: string, relative: string, content: string): Promise<void> {
  const file = join(root, ...relative.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content, "utf8");
}

let base = "";
let configDir = "";
let workspaceRoot = "";
let outside = "";
let userSkills: { slug: string; name: string }[];
let store: PluginStore;
let enabled = true;
let sessions: Map<string, { cwd: string; workspaceId: string | null }>;
let drafts: PluginDraftEvent[];
let installedCalls = 0;
let requests: PluginAgentRequests;

const S = "session-1";
const HOME_SESSION = "session-home";

function makeRequests(): PluginAgentRequests {
  return new PluginAgentRequests({
    plugins: store,
    enabled: async () => enabled,
    session: async (id) => sessions.get(id) ?? null,
    workspace: async (id) => (id === "ws-1" ? { name: "文献组", path: workspaceRoot } : null),
    draft: (event) => drafts.push(event),
    installed: () => {
      installedCalls += 1;
    },
  });
}

const request = (
  path: string,
  over: { scope?: "workspace" | "global" | null; sessionId?: string; mode?: PermissionMode; requestId?: string } = {},
): Extract<AgentEvent, { type: "pluginInstallRequest" }> => ({
  type: "pluginInstallRequest",
  requestId: over.requestId ?? "r1",
  sessionId: over.sessionId ?? S,
  path,
  scope: over.scope ?? null,
  mode: over.mode ?? "skip",
});

/** 在工作区里做一个好插件（一个技能、workflow 对得上；可带 MCP） */
async function makePlugin(name = "lit", over: { workflow?: unknown; skill?: string; mcp?: Record<string, unknown> } = {}): Promise<string> {
  const root = join(workspaceRoot, "plugins", name);
  const skill = over.skill ?? `${name}-scan`;
  await put(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name, description: "文献追踪", orbita: { workflow: over.workflow ?? [{ title: "扫", skill }] } }),
  );
  await put(root, `skills/${skill}/SKILL.md`, SKILL(skill));
  if (over.mcp !== undefined) await put(root, ".mcp.json", JSON.stringify({ mcpServers: over.mcp }));
  return root;
}

/** 成功的那几种结局取出行（installed / pending 必有行） */
function rowOf(outcome: PluginAgentInstallOutcome): PluginInstallRow {
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok && outcome.row !== null, "这一种结局应该带一行");
  return outcome.ok && outcome.row !== null ? outcome.row : (undefined as never);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "orbita-plugin-agent-"));
  configDir = join(base, "userData");
  workspaceRoot = join(base, "ws");
  outside = join(base, "elsewhere");
  await mkdir(configDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  userSkills = [];
  enabled = true;
  drafts = [];
  installedCalls = 0;
  sessions = new Map([
    [S, { cwd: workspaceRoot, workspaceId: "ws-1" }],
    [HOME_SESSION, { cwd: join(base, "home"), workspaceId: null }],
  ]);
  await mkdir(join(base, "home"), { recursive: true });
  store = new PluginStore({ configDir, secrets: new FakeSecrets(), userSkills: async () => userSkills });
  requests = makeRequests();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("install：直接拦下的（不装、也不留那一行）", () => {
  test("实验开关关着 / 会话不在了", async () => {
    const root = await makePlugin();
    enabled = false;
    const off = await requests.install(request(root));
    assert.equal(off.ok, false);
    assert.match(off.ok ? "" : off.error, /turned off/);
    enabled = true;
    const gone = await requests.install(request(root, { sessionId: "nope" }));
    assert.match(gone.ok ? "" : gone.error, /no longer exists/);
    assert.deepEqual(await store.records(), []);
  });

  test("路径在工作区之外：报清楚（讲出工作区在哪、该放哪）", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "x" }));
    const outcome = await requests.install(request(outside));
    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /outside this session's workspace/);
    assert.match(error, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(error, /plugins\/<name>/);
  });

  test("工作区里的符号链接指到外面：真实路径在外面，同样拒绝", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "sneaky" }));
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await symlink(outside, join(workspaceRoot, "plugins", "sneaky"));
    const outcome = await requests.install(request(join(workspaceRoot, "plugins", "sneaky")));
    assert.match(outcome.ok ? "" : outcome.error, /outside this session's workspace/);
  });

  test("`..` 绕出去：解析后在外面，拒绝", async () => {
    const outcome = await requests.install(request(join(workspaceRoot, "plugins", "..", "..", "elsewhere")));
    assert.match(outcome.ok ? "" : outcome.error, /outside this session's workspace/);
  });

  test("不存在 / 是文件 / 不像插件", async () => {
    const missing = await requests.install(request(join(workspaceRoot, "plugins", "nope")));
    assert.match(missing.ok ? "" : missing.error, /does not exist/);
    await put(workspaceRoot, "plugins/file.txt", "x");
    const file = await requests.install(request(join(workspaceRoot, "plugins", "file.txt")));
    assert.match(file.ok ? "" : file.error, /not a folder/);
    await mkdir(join(workspaceRoot, "plugins", "empty"), { recursive: true });
    const empty = await requests.install(request(join(workspaceRoot, "plugins", "empty")));
    assert.match(empty.ok ? "" : empty.error, /does not look like a plugin/);
  });

  test("相对路径按会话工作目录解", async () => {
    await makePlugin();
    const outcome = await requests.install(request("plugins/lit"));
    assert.equal(outcome.ok, true);
  });

  test("没有工作区的会话：scope workspace 报错并指路 global；缺省自动 global（再按「所有工作区」留一行）", async () => {
    const home = join(base, "home", "plugins", "hp");
    await put(home, "skills/hp-skill/SKILL.md", SKILL("hp-skill"));
    const bad = await requests.install(request(home, { scope: "workspace", sessionId: HOME_SESSION }));
    assert.match(bad.ok ? "" : bad.error, /scope "global"/);
    const outcome = await requests.install(request(home, { sessionId: HOME_SESSION }));
    assert.equal(outcome.ok && outcome.kind, "pending");
    assert.equal(rowOf(outcome).scope, "global");
    assert.equal(rowOf(outcome).reason, "global");
  });

  test("清单有问题（SKILL.md 没 description / workflow 点名不存在的技能）：连同清单一起退回，让 agent 先改", async () => {
    const root = await makePlugin("bad", { workflow: [{ title: "扫", skill: "ghost" }] });
    await put(root, "skills/nodesc/SKILL.md", "---\nname: nodesc\n---\n正文");
    const outcome = await requests.install(request(root));
    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /fix them and call install_plugin again/);
    assert.match(error, /skill-no-description/);
    assert.match(error, /workflow step "扫" names the skill "ghost"/);
    assert.match(error, /bad-scan/);
    assert.deepEqual(await store.records(), []);
  });

  test("重名：与用户自己的技能撞 / 与别处已装的同名插件撞，都给出怎么改", async () => {
    const root = await makePlugin();
    userSkills = [{ slug: "lit-scan", name: "lit-scan" }];
    const clash = await requests.install(request(root));
    assert.match(clash.ok ? "" : clash.error, /clashes with your own skill "lit-scan"/);
    userSkills = [];
    // 另一个文件夹里同名插件
    const other = join(base, "ws", "plugins", "other-folder");
    await put(other, ".claude-plugin/plugin.json", JSON.stringify({ name: "lit" }));
    await put(other, "skills/zzz/SKILL.md", SKILL("zzz"));
    assert.equal((await requests.install(request(root))).ok, true);
    const again = await requests.install(request(other, { requestId: "r2" }));
    assert.match(again.ok ? "" : again.error, /already installed \(from a different folder\)/);
  });
});

describe("install：低风险直接装，立即回执", () => {
  test("skip 档 + 工作区 + 不带 MCP + 无冲突：链接安装、只在这个工作区、回一行「installed」", async () => {
    const root = await makePlugin();
    const outcome = await requests.install(request(root));
    assert.equal(outcome.ok && outcome.kind, "installed");
    assert.equal(outcome.ok && outcome.kind === "installed" ? outcome.dataDir : null, join(configDir, "plugin-data", "lit"));
    const row = rowOf(outcome);
    assert.equal(row.state, "installed");
    assert.equal(row.reason, null);
    assert.equal(row.name, "lit");
    assert.equal(row.path, await realpath(root));
    assert.equal(row.scope, "workspace");
    assert.equal(row.workspaceName, "文献组");
    assert.deepEqual(row.skills, ["lit-scan"]);
    assert.deepEqual(row.commands, []);
    const record = (await store.records())[0];
    assert.deepEqual(record?.source, { kind: "link", path: await realpath(root) });
    assert.deepEqual(record?.scope, { kind: "workspaces", ids: ["ws-1"] });
    assert.equal(installedCalls, 1);
  });

  test("行经 JSON 来回（落盘）后仍能被解析", async () => {
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root)));
    assert.deepEqual(parsePluginInstallRow({ pluginInstall: JSON.parse(JSON.stringify(row)) }), row);
  });

  test("同一文件夹已经链接装过：不装第二次、没有新的一行，回 already（改动下一轮自动生效）", async () => {
    const root = await makePlugin();
    await requests.install(request(root));
    const second = await requests.install(request(root, { requestId: "r2" }));
    assert.equal(second.ok && second.kind, "already");
    assert.equal(second.ok && second.row, null);
    assert.equal(installedCalls, 1);
  });

  test("已装过之后又改坏了清单：重装仍被拦下（already 不是免检）", async () => {
    const root = await makePlugin();
    await requests.install(request(root));
    await put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "lit", orbita: { workflow: [{ title: "扫", skill: "ghost" }] } }));
    const outcome = await requests.install(request(root, { requestId: "r2" }));
    assert.match(outcome.ok ? "" : outcome.error, /names the skill "ghost"/);
  });
});

describe("install：需要用户看一眼 → 不装，只留带「安装」的一行", () => {
  test("带 MCP：回 pending / reason mcp，行里有完整命令行；什么都没装", async () => {
    const root = await makePlugin("withmcp", { mcp: { srv: { command: "node", args: ["server.js", "--port", "9"] } } });
    const outcome = await requests.install(request(root));
    assert.equal(outcome.ok && outcome.kind, "pending");
    const row = rowOf(outcome);
    assert.equal(row.state, "pending");
    assert.equal(row.reason, "mcp");
    assert.equal(row.commands.length, 1);
    assert.match(row.commands[0] ?? "", /node .*server\.js.* --port 9/);
    assert.deepEqual(await store.records(), []);
    assert.equal(installedCalls, 0);
  });

  test("manual 档：低风险的也不直接装（那一行就是用户的点头）", async () => {
    const root = await makePlugin();
    const outcome = await requests.install(request(root, { mode: "manual" }));
    assert.equal(outcome.ok && outcome.kind, "pending");
    assert.equal(rowOf(outcome).reason, "manual");
    assert.deepEqual(await store.records(), []);
  });

  test("plan 档（权限层本来就拒，万一走到这里）也按保守处理，不装", async () => {
    const root = await makePlugin();
    const outcome = await requests.install(request(root, { mode: "plan" }));
    assert.equal(outcome.ok && outcome.kind, "pending");
    assert.deepEqual(await store.records(), []);
  });

  test("范围是所有工作区：skip 档也留一行，reason global", async () => {
    const root = await makePlugin();
    const outcome = await requests.install(request(root, { scope: "global" }));
    assert.equal(rowOf(outcome).reason, "global");
    assert.equal(rowOf(outcome).scope, "global");
    assert.equal(rowOf(outcome).workspaceName, null);
    assert.deepEqual(await store.records(), []);
  });

  test("多个原因同时成立：取最要紧的（mcp > global > manual）", () => {
    const withMcp = { mcp: [{ name: "s" }] } as never;
    const without = { mcp: [] } as never;
    assert.equal(needsLook(withMcp, "global", "manual"), "mcp");
    assert.equal(needsLook(without, "global", "manual"), "global");
    assert.equal(needsLook(without, "workspace", "manual"), "manual");
    assert.equal(needsLook(without, "workspace", "skip"), null);
  });

  test("不重复弹：这一行没点之前 agent 又调一次，仍是 pending（行是幂等的），不会装", async () => {
    const root = await makePlugin("withmcp", { mcp: { srv: { command: "node" } } });
    const first = await requests.install(request(root));
    const second = await requests.install(request(root, { requestId: "r2" }));
    assert.equal(first.ok && first.kind, "pending");
    assert.equal(second.ok && second.kind, "pending");
    assert.equal(rowOf(first).fingerprint, rowOf(second).fingerprint);
    assert.deepEqual(await store.records(), []);
  });
});

describe("installFromRow：用户点那一行的「安装」", () => {
  const clickOf = (row: PluginInstallRow, over: Partial<{ sessionId: string; path: string; scope: "workspace" | "global"; fingerprint: string }> = {}) => ({
    sessionId: S,
    path: row.path,
    scope: row.scope,
    fingerprint: row.fingerprint,
    ...over,
  });

  test("点了才装：链接安装、范围随行；装好广播刷新", async () => {
    const root = await makePlugin("withmcp", { mcp: { srv: { command: "node" } } });
    const row = rowOf(await requests.install(request(root)));
    assert.deepEqual(await store.records(), []);
    const result = await requests.installFromRow(clickOf(row));
    assert.deepEqual(result, { ok: true, name: "withmcp" });
    const record = (await store.records())[0];
    assert.deepEqual(record?.source, { kind: "link", path: await realpath(root) });
    assert.deepEqual(record?.scope, { kind: "workspaces", ids: ["ws-1"] });
    assert.equal(installedCalls, 1);
  });

  test("落盘后重开仍可装：行经 JSON 来回、换一个全新的 PluginAgentRequests（模拟重启）照样装得上", async () => {
    const root = await makePlugin();
    const shown = rowOf(await requests.install(request(root, { mode: "manual" })));
    const reopened = parsePluginInstallRow({ pluginInstall: JSON.parse(JSON.stringify(shown)) });
    assert.ok(reopened !== null);
    const fresh = makeRequests();
    const result = await fresh.installFromRow(clickOf(reopened ?? shown));
    assert.equal(result.ok, true);
    assert.equal((await store.records()).length, 1);
  });

  test("已经装上（在别处装的 / 点了两次）：幂等，不再装第二次", async () => {
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root, { mode: "manual" })));
    assert.equal((await requests.installFromRow(clickOf(row))).ok, true);
    assert.equal((await requests.installFromRow(clickOf(row))).ok, true);
    assert.equal(installedCalls, 1);
  });

  test("看到这一行之后文件夹里要启动的命令被改了：拒装（changed），什么都没装", async () => {
    const root = await makePlugin("withmcp", { mcp: { srv: { command: "node", args: ["a.js"] } } });
    const row = rowOf(await requests.install(request(root)));
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { srv: { command: "curl", args: ["evil.sh"] } } }));
    const result = await requests.installFromRow(clickOf(row));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "changed");
    assert.deepEqual(await store.records(), []);
    assert.equal(installedCalls, 0);
  });

  test("renderer 传来的范围与行上的不一致（把工作区的行改成所有工作区）：指纹对不上，拒装", async () => {
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root, { mode: "manual" })));
    const result = await requests.installFromRow(clickOf(row, { scope: "global" }));
    assert.equal(!result.ok && result.reason, "changed");
    assert.deepEqual(await store.records(), []);
  });

  test("renderer 传来的路径在工作区之外：not-found，不装（路径不是它说了算）", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "x" }));
    await put(outside, "skills/x/SKILL.md", SKILL("x"));
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root, { mode: "manual" })));
    const result = await requests.installFromRow(clickOf(row, { path: outside }));
    assert.equal(!result.ok && result.reason, "not-found");
    assert.deepEqual(await store.records(), []);
  });

  test("文件夹被删了 / 会话不在了 / 开关被关了：各自回清楚的原因", async () => {
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root, { mode: "manual" })));
    enabled = false;
    const off = await requests.installFromRow(clickOf(row));
    assert.equal(!off.ok && off.reason, "disabled");
    enabled = true;
    await rm(root, { recursive: true, force: true });
    const gone = await requests.installFromRow(clickOf(row));
    assert.equal(!gone.ok && gone.reason, "not-found");
    const noSession = await requests.installFromRow(clickOf(row, { sessionId: "nope" }));
    assert.equal(!noSession.ok && noSession.reason, "no-session");
  });

  test("等的时候又冒出同名用户技能：点安装时权威复查，回 invalid，不装", async () => {
    const root = await makePlugin();
    const row = rowOf(await requests.install(request(root, { mode: "manual" })));
    userSkills = [{ slug: "lit-scan", name: "lit-scan" }];
    const result = await requests.installFromRow(clickOf(row));
    assert.equal(!result.ok && result.reason, "invalid");
    assert.match(!result.ok ? result.detail : "", /clashes with your own skill/);
    assert.deepEqual(await store.records(), []);
  });

  test("指纹随内容变：名字 / 范围 / 技能 / 命令任一变都不同，顺序不影响", async () => {
    const root = await makePlugin("fp", { mcp: { a: { command: "x" }, b: { command: "y" } } });
    const previewed = await store.preview({ source: { kind: "folder", path: root }, mode: "link" });
    assert.ok(previewed.ok);
    if (!previewed.ok) return;
    const base1 = fingerprintOf({ wanted: "workspace", preview: previewed.preview });
    assert.equal(fingerprintOf({ wanted: "global", preview: previewed.preview }) === base1, false);
    const reversed = { ...previewed.preview, mcp: [...previewed.preview.mcp].reverse() };
    assert.equal(fingerprintOf({ wanted: "workspace", preview: reversed }), base1);
    const edited = { ...previewed.preview, mcp: previewed.preview.mcp.map((server) => ({ ...server, commandLine: `${server.commandLine} --x` })) };
    assert.equal(fingerprintOf({ wanted: "workspace", preview: edited }) === base1, false);
  });
});

describe("previewDraft：只扫描、不装；成功后让右栏打开「正在做」视图", () => {
  const preview = (path: string, sessionId = S) => requests.previewDraft({ type: "pluginPreviewRequest", requestId: "p1", sessionId, path });

  /** UI 先行的草稿：只有清单 + 面板三件套，还没有技能 */
  async function makeDraft(over: { spec?: boolean; template?: boolean } = {}): Promise<string> {
    const root = join(workspaceRoot, "plugins", "draft");
    await put(
      root,
      ".claude-plugin/plugin.json",
      JSON.stringify({
        name: "draft",
        description: "文献追踪",
        orbita: {
          workflow: [{ title: "每日扫", skill: "draft-scan" }],
          panel: { title: "文献追踪", template: "./panel/index.html", data: "${CLAUDE_PLUGIN_ROOT}/data/panel.json", spec: "./panel/spec.md", sample: "./panel/sample.json" },
        },
      }),
    );
    if (over.template !== false) await put(root, "panel/index.html", "<!doctype html><p>x</p>");
    if (over.spec !== false) await put(root, "panel/spec.md", "# 卡片\n字段：问题句");
    await put(root, "panel/sample.json", JSON.stringify({ items: [{ title: "x" }] }));
    return root;
  }

  test("正常：回名字 / 面板文件都在，发 pluginDraft（带真实路径），什么都没装；技能还没写只算提醒", async () => {
    const root = await makeDraft();
    const outcome = await preview(root);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.name, "draft");
    assert.equal(outcome.path, await realpath(root));
    assert.deepEqual(outcome.panelFiles.map((file) => [file.key, file.exists]), [["template", true], ["spec", true], ["sample", true], ["data", false]]);
    assert.equal(outcome.installed, false);
    assert.equal(outcome.issues.some((line) => /names the skill "draft-scan"/.test(line) && /must exist before install_plugin/.test(line)), true);
    assert.deepEqual(drafts, [{ type: "pluginDraft", sessionId: S, path: await realpath(root) }]);
    assert.deepEqual(await store.records(), []);
    assert.equal(installedCalls, 0);
  });

  test("面板文件缺了：issues 里点名缺的是哪个键，pluginDraft 照发（草稿没做完很正常）", async () => {
    const root = await makeDraft({ spec: false });
    const outcome = await preview(root);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.issues.some((line) => /orbita\.panel\.spec points at \.\/panel\/spec\.md, which does not exist/.test(line)), true);
    assert.equal(drafts.length, 1);
  });

  test("清单里没有 panel 块：提醒右栏没有东西可显示", async () => {
    const root = await makePlugin("nopanel");
    const outcome = await preview(root);
    assert.equal(outcome.ok && outcome.panelFiles.length, 0);
    assert.equal(outcome.ok && outcome.issues.some((line) => /no "orbita\.panel" block/.test(line)), true);
  });

  test("面板路径用 .. 逃出插件根：算不存在", async () => {
    const root = join(workspaceRoot, "plugins", "esc");
    await put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "esc", orbita: { panel: { template: "../../secret.html" } } }));
    await put(workspaceRoot, "secret.html", "x");
    const files = await draftPanelFiles(root, { manifestFile: ".claude-plugin/plugin.json" }, join(base, "d"));
    assert.deepEqual(files, [{ key: "template", path: "../../secret.html", exists: false }]);
  });

  test("路径在工作区之外 / 不是插件 / 开关关着 / 会话不在：报错，且不发 pluginDraft", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "x" }));
    const escaped = await preview(outside);
    assert.match(escaped.ok ? "" : escaped.error, /outside this session's workspace/);
    await mkdir(join(workspaceRoot, "plugins", "empty"), { recursive: true });
    assert.equal((await preview(join(workspaceRoot, "plugins", "empty"))).ok, false);
    const root = await makeDraft();
    enabled = false;
    assert.equal((await preview(root)).ok, false);
    enabled = true;
    assert.equal((await preview(root, "nope")).ok, false);
    assert.deepEqual(drafts, []);
  });

  test("同名插件已装（在改一个已装的）：installed 为 true，且这个文件夹自己的同名不算冲突", async () => {
    const root = await makePlugin("lit");
    await requests.install(request(root));
    const outcome = await preview(root);
    assert.equal(outcome.ok && outcome.installed, true);
    assert.equal(outcome.ok && outcome.issues.some((line) => /already installed/.test(line)), false);
  });
});

describe("list", () => {
  test("只列这条会话的工作区里生效的真插件（含 workflow 步骤标题与根目录）；别的工作区的不列；开关关着报错", async () => {
    const root = await makePlugin("lit");
    await requests.install(request(root));
    const listed = await requests.list({ type: "pluginListRequest", requestId: "l1", sessionId: S });
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.plugins.length, 1);
      assert.equal(listed.plugins[0]?.name, "lit");
      assert.equal(listed.plugins[0]?.origin, "plugin");
      assert.deepEqual(listed.plugins[0]?.workflow, ["扫"]);
      assert.deepEqual(listed.plugins[0]?.skills, ["lit-scan"]);
      assert.equal(listed.plugins[0]?.dataDir, join(configDir, "plugin-data", "lit"));
      assert.equal(listed.plugins[0]?.description, "文献追踪");
    }
    // Home 会话：只对 ws-1 启用的不在
    const home = await requests.list({ type: "pluginListRequest", requestId: "l2", sessionId: HOME_SESSION });
    assert.deepEqual(home.ok && home.plugins, []);
    enabled = false;
    assert.equal((await requests.list({ type: "pluginListRequest", requestId: "l3", sessionId: S })).ok, false);
  });
});

describe("locateInside", () => {
  test("根本身算在里面；相对路径按 cwd；根之外与不存在的拒绝", async () => {
    const real = await locateInside(workspaceRoot, workspaceRoot, [workspaceRoot]);
    assert.equal(real.ok, true);
    await mkdir(join(workspaceRoot, "a"), { recursive: true });
    const rel = await locateInside("a", workspaceRoot, [workspaceRoot]);
    assert.equal(rel.ok, true);
    assert.equal((await locateInside(outside, workspaceRoot, [workspaceRoot])).ok, false);
    assert.equal((await locateInside("nope", workspaceRoot, [workspaceRoot])).ok, false);
  });

  test("前缀相同的兄弟目录（ws 与 ws-evil）不算在里面", async () => {
    const sibling = `${workspaceRoot}-evil`;
    await mkdir(sibling, { recursive: true });
    assert.equal((await locateInside(sibling, workspaceRoot, [workspaceRoot])).ok, false);
  });
});

test("（读盘）安装后 plugins.json 里是链接记录且没有任何副本目录", async () => {
  const root = await makePlugin();
  await requests.install(request(root));
  const raw = JSON.parse(await readFile(join(configDir, "plugins.json"), "utf8")) as { plugins: Record<string, { source: { kind: string } }> };
  assert.equal(raw.plugins["lit"]?.source.kind, "link");
  await assert.rejects(readFile(join(configDir, "plugins", "lit", ".claude-plugin", "plugin.json")));
});
