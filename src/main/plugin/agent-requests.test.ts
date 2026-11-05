/**
 * agent 的 install_plugin / list_plugins 在主进程的账：真 PluginStore（临时目录）+ 假端口。
 * 重点：路径越界、弹卡之前就拦下 agent 自己写错的东西、用户点了才装、拒绝 / 停轮 / 重复安装。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SecretsPort } from "../provider/store.ts";
import { PluginAgentRequests, locateInside, type PluginInstallAsk } from "./agent-requests.ts";
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
let asks: PluginInstallAsk[];
let installedCalls = 0;
let installedInfo: { name: string; sessionId: string } | null = null;
let requests: PluginAgentRequests;

const S = "session-1";
const HOME_SESSION = "session-home";

const request = (path: string, scope: "workspace" | "global" | null = null, sessionId = S, requestId = "r1"): Extract<AgentEvent, { type: "pluginInstallRequest" }> => ({
  type: "pluginInstallRequest",
  requestId,
  sessionId,
  path,
  scope,
});

/** 在工作区里做一个好插件（一个技能、workflow 对得上） */
async function makePlugin(name = "lit", over: { workflow?: unknown; skill?: string } = {}): Promise<string> {
  const root = join(workspaceRoot, "plugins", name);
  const skill = over.skill ?? `${name}-scan`;
  await put(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name, description: "文献追踪", orbita: { workflow: over.workflow ?? [{ title: "扫", skill }] } }),
  );
  await put(root, `skills/${skill}/SKILL.md`, SKILL(skill));
  return root;
}

/** 发请求，等到弹卡（或请求直接有了结果）再返回；`done` 是最终回执，要等用户应答才落定。 */
async function startInstall(event: ReturnType<typeof request>): Promise<{ done: Promise<Awaited<ReturnType<PluginAgentRequests["install"]>>> }> {
  const before = asks.length;
  let settled = false;
  const done = requests.install(event);
  void done.then(() => {
    settled = true;
  });
  const deadline = Date.now() + 5000;
  while (asks.length === before && !settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  return { done };
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
  asks = [];
  installedCalls = 0;
  installedInfo = null;
  sessions = new Map([
    [S, { cwd: workspaceRoot, workspaceId: "ws-1" }],
    [HOME_SESSION, { cwd: join(base, "home"), workspaceId: null }],
  ]);
  await mkdir(join(base, "home"), { recursive: true });
  store = new PluginStore({ configDir, secrets: new FakeSecrets(), userSkills: async () => userSkills });
  requests = new PluginAgentRequests({
    plugins: store,
    enabled: async () => enabled,
    session: async (id) => sessions.get(id) ?? null,
    workspace: async (id) => (id === "ws-1" ? { name: "文献组", path: workspaceRoot } : null),
    ask: (event) => asks.push(event),
    installed: (info) => {
      installedCalls += 1;
      installedInfo = info;
    },
  });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("install：弹卡之前就拦下的", () => {
  test("实验开关关着 / 会话不在了", async () => {
    const root = await makePlugin();
    enabled = false;
    const off = await requests.install(request(root));
    assert.equal(off.ok, false);
    assert.match(off.ok ? "" : off.error, /turned off/);
    enabled = true;
    const gone = await requests.install(request(root, null, "nope"));
    assert.match(gone.ok ? "" : gone.error, /no longer exists/);
    assert.equal(asks.length, 0);
  });

  test("路径在工作区之外：报清楚（讲出工作区在哪、该放哪），不弹卡", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "x" }));
    const outcome = await requests.install(request(outside));
    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /outside this session's workspace/);
    assert.match(error, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(error, /plugins\/<name>/);
    assert.equal(asks.length, 0);
  });

  test("工作区里的符号链接指到外面：真实路径在外面，同样拒绝", async () => {
    await put(outside, ".claude-plugin/plugin.json", JSON.stringify({ name: "sneaky" }));
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await symlink(outside, join(workspaceRoot, "plugins", "sneaky"));
    const outcome = await requests.install(request(join(workspaceRoot, "plugins", "sneaky")));
    assert.match(outcome.ok ? "" : outcome.error, /outside this session's workspace/);
    assert.equal(asks.length, 0);
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
    assert.equal(asks.length, 0);
  });

  test("相对路径按会话工作目录解", async () => {
    await makePlugin();
    const { done } = await startInstall(request("plugins/lit"));
    assert.equal(asks.length, 1);
    await requests.answer("r1", false);
    await done;
  });

  test("没有工作区的会话：scope workspace 报错并指路 global；缺省自动 global", async () => {
    const home = join(base, "home", "plugins", "hp");
    await put(home, "skills/hp-skill/SKILL.md", SKILL("hp-skill"));
    const bad = await requests.install(request(home, "workspace", HOME_SESSION));
    assert.match(bad.ok ? "" : bad.error, /scope "global"/);
    const { done } = await startInstall(request(home, null, HOME_SESSION, "r2"));
    assert.equal(asks[0]?.scope, "global");
    await requests.answer("r2", false);
    await done;
  });

  test("清单有问题（SKILL.md 没 description / workflow 点名不存在的技能）：连同清单一起退回，说明用户还没被问", async () => {
    const root = await makePlugin("bad", { workflow: [{ title: "扫", skill: "ghost" }] });
    await put(root, "skills/nodesc/SKILL.md", "---\nname: nodesc\n---\n正文");
    const outcome = await requests.install(request(root));
    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /user has not been asked yet/);
    assert.match(error, /skill-no-description/);
    assert.match(error, /workflow step "扫" names the skill "ghost"/);
    assert.match(error, /bad-scan/);
    assert.equal(asks.length, 0);
  });

  test("重名：与用户自己的技能撞 / 与别处已装的同名插件撞，都给出怎么改", async () => {
    const root = await makePlugin();
    userSkills = [{ slug: "lit-scan", name: "lit-scan" }];
    const clash = await requests.install(request(root));
    assert.match(clash.ok ? "" : clash.error, /clashes with your own skill "lit-scan"/);
    userSkills = [];
    // 另一个文件夹里同名插件已经装过
    const other = join(base, "ws", "plugins", "other-folder");
    await put(other, ".claude-plugin/plugin.json", JSON.stringify({ name: "lit" }));
    await put(other, "skills/zzz/SKILL.md", SKILL("zzz"));
    const { done } = await startInstall(request(root));
    await requests.answer("r1", true);
    assert.equal((await done).ok, true);
    const again = await requests.install(request(other, null, S, "r2"));
    assert.match(again.ok ? "" : again.error, /already installed \(from a different folder\)/);
  });
});

describe("install：用户点了才装", () => {
  test("弹卡带着预览、范围与工作区名；点「安装」→ 链接安装、范围只在这个工作区、回执带技能名", async () => {
    const root = await makePlugin();
    const { done } = await startInstall(request(root));
    assert.equal(asks.length, 1);
    const ask = asks[0];
    assert.equal(ask?.sessionId, S);
    assert.equal(ask?.scope, "workspace");
    assert.equal(ask?.workspaceName, "文献组");
    assert.equal(ask?.preview.name, "lit");
    assert.equal(ask?.preview.mode, "link");
    assert.deepEqual(ask?.preview.skills.map((skill) => skill.slug), ["lit-scan"]);
    assert.deepEqual(ask?.preview.workflow.map((step) => step.skillSlug), ["lit-scan"]);
    // 点之前什么都没装
    assert.deepEqual(await store.records(), []);
    await requests.answer("r1", true);
    const outcome = await done;
    assert.deepEqual(outcome, { ok: true, name: "lit", scope: "workspace", already: false, skills: ["lit-scan"], mcp: [], dataDir: join(configDir, "plugin-data", "lit") });
    const record = (await store.records())[0];
    assert.deepEqual(record?.source, { kind: "link", path: await realpath(root) });
    assert.deepEqual(record?.scope, { kind: "workspaces", ids: ["ws-1"] });
    assert.equal(installedCalls, 1);
    // renderer 靠它把装插件的那条会话的右栏切到这个插件的面板
    assert.equal(installedInfo?.name, "lit");
    assert.equal(installedInfo?.sessionId, S);
  });

  test("scope global：对所有工作区", async () => {
    const root = await makePlugin();
    const { done } = await startInstall(request(root, "global"));
    assert.equal(asks[0]?.scope, "global");
    assert.equal(asks[0]?.workspaceName, null);
    await requests.answer("r1", true);
    assert.equal((await done).ok, true);
    assert.deepEqual((await store.records())[0]?.scope, { kind: "global" });
  });

  test("点「不装」：回执讲清楚被拒绝、别自己重试；什么都没装", async () => {
    const root = await makePlugin();
    const { done } = await startInstall(request(root));
    await requests.answer("r1", false);
    const outcome = await done;
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /declined/);
    assert.match(outcome.ok ? "" : outcome.error, /Do not retry/);
    assert.deepEqual(await store.records(), []);
    assert.equal(installedCalls, 0);
  });

  test("这一轮停了（cancelSession）：没应答的卡按取消结掉；别的会话的不动；之后迟到的应答静默", async () => {
    const root = await makePlugin();
    const { done } = await startInstall(request(root));
    requests.cancelSession("someone-else");
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    requests.cancelSession(S);
    const outcome = await done;
    assert.match(outcome.ok ? "" : outcome.error, /turn ended/);
    await requests.answer("r1", true);
    assert.deepEqual(await store.records(), []);
  });

  test("不认识的 requestId 应答：静默不抛", async () => {
    await requests.answer("never-asked", true);
  });

  test("用户等卡的时候又冒出同名用户技能：点安装时权威复查，回执讲冲突，不装", async () => {
    const root = await makePlugin();
    const { done } = await startInstall(request(root));
    userSkills = [{ slug: "lit-scan", name: "lit-scan" }];
    await requests.answer("r1", true);
    const outcome = await done;
    assert.match(outcome.ok ? "" : outcome.error, /clashes with your own skill/);
    assert.deepEqual(await store.records(), []);
    assert.equal(installedCalls, 0);
  });

  test("同一文件夹已经链接装过：不再弹卡，回执 already（改动下一轮自动生效）", async () => {
    const root = await makePlugin();
    const first = await startInstall(request(root));
    await requests.answer("r1", true);
    await first.done;
    asks.length = 0;
    const second = await requests.install(request(root, null, S, "r2"));
    assert.deepEqual(second, { ok: true, name: "lit", scope: "workspace", already: true, skills: ["lit-scan"], mcp: [], dataDir: join(configDir, "plugin-data", "lit") });
    assert.equal(asks.length, 0);
  });

  test("已装过之后又改坏了清单：重装仍在弹卡前拦下（already 不是免检）", async () => {
    const root = await makePlugin();
    const first = await startInstall(request(root));
    await requests.answer("r1", true);
    await first.done;
    await put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "lit", orbita: { workflow: [{ title: "扫", skill: "ghost" }] } }));
    const outcome = await requests.install(request(root, null, S, "r2"));
    assert.match(outcome.ok ? "" : outcome.error, /names the skill "ghost"/);
  });
});

describe("list", () => {
  test("只列这条会话的工作区里生效的真插件（含 workflow 步骤标题与根目录）；别的工作区的不列；开关关着报错", async () => {
    const root = await makePlugin("lit");
    const first = await startInstall(request(root));
    await requests.answer("r1", true);
    await first.done;
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
  const { done } = await startInstall(request(root));
  await requests.answer("r1", true);
  await done;
  const raw = JSON.parse(await readFile(join(configDir, "plugins.json"), "utf8")) as { plugins: Record<string, { source: { kind: string } }> };
  assert.equal(raw.plugins["lit"]?.source.kind, "link");
  await assert.rejects(readFile(join(configDir, "plugins", "lit", ".claude-plugin", "plugin.json")));
});
