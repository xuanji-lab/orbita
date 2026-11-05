import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SecretsPort } from "../provider/store.ts";
import { mergeMcpConfigs, resolveServersForWorkspace } from "../../shared/mcp.ts";
import type { PluginInstallResult, PluginPreview, PluginScope } from "../../shared/plugin.ts";
import { runGit, type GitRunner } from "./install.ts";
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

let base = "";
let configDir = "";
let secrets: FakeSecrets;
let userSkills: { slug: string; name: string }[];
let store: PluginStore;

const SKILL = (name: string, description = "做一件事"): string => `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;

async function put(root: string, relative: string, content: string): Promise<void> {
  const file = join(root, ...relative.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content, "utf8");
}

/** 造一个插件源目录：1 个技能 + 1 台 stdio MCP（用 ROOT 变量）+ 1 个敏感配置 + 1 个普通配置 */
async function makeSource(name = "demo", over: { skill?: string } = {}): Promise<string> {
  const root = join(base, "sources", name);
  await put(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name,
      displayName: `演示 ${name}`,
      version: "1.0.0",
      description: "演示",
      userConfig: {
        api_key: { type: "string", title: "Key", description: "令牌", sensitive: true, required: true },
        region: { type: "string", title: "Region", description: "区域", default: "cn" },
      },
      mcpServers: {
        srv: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--key", "${user_config.api_key}", "--region", "${user_config.region}"], env: { DATA: "${CLAUDE_PLUGIN_DATA}" } },
      },
    }),
  );
  await put(root, `skills/${over.skill ?? name + "-skill"}/SKILL.md`, SKILL(over.skill ?? `${name}-skill`));
  await put(root, "server.js", "// server");
  return root;
}

const GLOBAL: PluginScope = { kind: "global" };

async function installFolder(source: string, mode: "copy" | "link", scope: PluginScope = GLOBAL): Promise<{ result: PluginInstallResult; preview: PluginPreview }> {
  const previewed = await store.preview({ source: { kind: "folder", path: source }, mode });
  assert.equal(previewed.ok, true, JSON.stringify(previewed));
  if (!previewed.ok) throw new Error("unreachable");
  const result = await store.install({ preview: { source: { kind: "folder", path: source }, mode }, previewId: previewed.preview.previewId, scope });
  return { result, preview: previewed.preview };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "orbita-plugin-store-"));
  configDir = join(base, "userData");
  await mkdir(configDir, { recursive: true });
  secrets = new FakeSecrets();
  userSkills = [];
  store = new PluginStore({ configDir, secrets, userSkills: async () => userSkills });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("预览", () => {
  test("复制来源：先拷进暂存区，预览带出技能、MCP 完整命令行（变量已替换、敏感值掩码）、配置项", async () => {
    const source = await makeSource();
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const p = result.preview;
    assert.equal(p.name, "demo");
    assert.equal(p.displayName, "演示 demo");
    assert.equal(p.mode, "copy");
    assert.notEqual(p.previewId, null);
    assert.deepEqual(p.skills.map((s) => s.slug), ["demo-skill"]);
    // ${CLAUDE_PLUGIN_ROOT} 是装好后的位置（userData 里的副本），不是源目录也不是暂存目录
    assert.equal(p.root, join(configDir, "plugins", "demo"));
    const mcp = p.mcp[0];
    assert.equal(mcp?.qualified, "plugin_demo_srv");
    // api_key 必填没填：预览如实说配置没填，而不是塞掩码假装有值
    assert.deepEqual(mcp?.problem, { kind: "config-missing", key: "api_key" });
    assert.equal(mcp?.commandLine.includes(join(configDir, "plugins", "demo", "server.js")), true);
    assert.deepEqual(p.config.map((c) => c.key), ["api_key", "region"]);
    assert.equal((await readdir(join(configDir, "plugins-staging"))).length, 1);
  });

  test("链接来源：不暂存、不拷贝，root 就是源目录", async () => {
    const source = await makeSource();
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "link" });
    assert.equal(result.ok && result.preview.previewId, null);
    assert.equal(result.ok && result.preview.root, source);
    await assert.rejects(stat(join(configDir, "plugins-staging")));
  });

  test("discard 清暂存；重复 discard 与不认识的 id 静默", async () => {
    const source = await makeSource();
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(result.ok, true);
    if (!result.ok || result.preview.previewId === null) return;
    await store.discard(result.preview.previewId);
    await store.discard(result.preview.previewId);
    await store.discard("nope");
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
  });

  test("不是插件的目录（什么组件都没有）拒绝，且不留暂存", async () => {
    const empty = join(base, "sources", "empty");
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, "readme.txt"), "x");
    const result = await store.preview({ source: { kind: "folder", path: empty }, mode: "copy" });
    assert.deepEqual(result, { ok: false, error: { kind: "not-a-plugin" } });
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
  });

  test("名字不合法拒绝（清单里写了空格），不替用户改", async () => {
    const root = join(base, "sources", "bad");
    await put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "Bad Name" }));
    const result = await store.preview({ source: { kind: "folder", path: root }, mode: "link" });
    assert.deepEqual(result, { ok: false, error: { kind: "invalid-name", name: "Bad Name" } });
  });

  test("相对路径与不存在的目录：read-failed，不抛", async () => {
    const relative = await store.preview({ source: { kind: "folder", path: "relative/dir" }, mode: "copy" });
    assert.equal(!relative.ok && relative.error.kind, "read-failed");
    const missing = await store.preview({ source: { kind: "folder", path: join(base, "nope") }, mode: "copy" });
    assert.equal(!missing.ok && missing.error.kind, "read-failed");
  });
});

describe("复制时的符号链接与大小", () => {
  test("指到插件根之外的符号链接：拒绝复制并列出路径，不留暂存", async () => {
    const source = await makeSource();
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(source, "leak"));
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.deepEqual(result, { ok: false, error: { kind: "symlink-escape", paths: ["leak"] } });
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
  });

  test("绝对路径的符号链接即使指向根内也拒绝（副本里它仍指回源目录）", async () => {
    const source = await makeSource();
    await symlink(join(source, "server.js"), join(source, "abs-link"));
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(!result.ok && result.error.kind, "symlink-escape");
  });

  test("根内的相对符号链接保留为相对链接：副本与源脱钩", async () => {
    const source = await makeSource();
    await symlink("server.js", join(source, "alias.js"));
    const { result } = await installFolder(source, "copy");
    assert.equal(result.ok, true);
    const copy = join(configDir, "plugins", "demo");
    assert.equal((await readFile(join(copy, "alias.js"), "utf8")), "// server");
    await rm(source, { recursive: true });
    assert.equal((await readFile(join(copy, "alias.js"), "utf8")), "// server");
  });

  test("相对链接 ../ 逃出根也拒绝", async () => {
    const source = await makeSource();
    await symlink("../../outside-file", join(source, "up"));
    const result = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(!result.ok && result.error.kind, "symlink-escape");
  });

  test("目录太大（超条目上限）拒绝复制，不拷", async () => {
    const source = await makeSource();
    for (let i = 0; i < 12; i += 1) await put(source, `many/f${i}.txt`, "x");
    const { stageCopy } = await import("./install.ts");
    const staged = await stageCopy(source, join(base, "stage-x"), { entries: 5, bytes: 1_000_000 });
    assert.deepEqual(staged, { ok: false, error: { kind: "too-large" } });
    await assert.rejects(stat(join(base, "stage-x")));
  });

  test("复制不带 .git", async () => {
    const source = await makeSource();
    await put(source, ".git/HEAD", "ref: refs/heads/main");
    const { result } = await installFolder(source, "copy");
    assert.equal(result.ok, true);
    await assert.rejects(stat(join(configDir, "plugins", "demo", ".git")));
  });
});

describe("安装", () => {
  test("复制：暂存挪进 plugins/<name>，记录落盘，数据目录建好，暂存清空；源目录改了副本不变", async () => {
    const source = await makeSource();
    const { result } = await installFolder(source, "copy", { kind: "workspaces", ids: ["w1", "w1", "w2"] });
    assert.deepEqual(result, { ok: true, id: "plugin:demo" });
    assert.equal((await stat(join(configDir, "plugins", "demo", "skills", "demo-skill", "SKILL.md"))).isFile(), true);
    assert.equal((await stat(join(configDir, "plugin-data", "demo"))).isDirectory(), true);
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
    const file = JSON.parse(await readFile(join(configDir, "plugins.json"), "utf8"));
    const record = file.plugins.demo;
    assert.equal(file.version, 1);
    assert.deepEqual(record.source, { kind: "copy", from: source });
    assert.deepEqual(record.scope, { kind: "workspaces", ids: ["w1", "w2"] });
    assert.equal(record.version, "1.0.0");
    // 源目录事后被改：副本不受影响
    await writeFile(join(source, "server.js"), "// changed");
    assert.equal(await readFile(join(configDir, "plugins", "demo", "server.js"), "utf8"), "// server");
  });

  test("链接：只记源路径，不拷贝；改源目录立刻体现在装配里", async () => {
    const source = await makeSource();
    const { result } = await installFolder(source, "link");
    assert.equal(result.ok, true);
    await assert.rejects(stat(join(configDir, "plugins", "demo")));
    const record = JSON.parse(await readFile(join(configDir, "plugins.json"), "utf8")).plugins.demo;
    assert.deepEqual(record.source, { kind: "link", path: source });
    await put(source, "skills/added/SKILL.md", SKILL("added"));
    const assembled = await store.assemble(null);
    assert.deepEqual(assembled.skills.map((s) => s.slug), ["added", "demo-skill"]);
  });

  test("没有预览句柄 / 句柄对不上来源：stale-preview，不装", async () => {
    const source = await makeSource();
    const other = await makeSource("other");
    const previewed = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(previewed.ok, true);
    const noHandle = await store.install({ preview: { source: { kind: "folder", path: source }, mode: "copy" }, previewId: null, scope: GLOBAL });
    assert.deepEqual(noHandle, { ok: false, error: { kind: "stale-preview" } });
    const wrongSource = await store.install({
      preview: { source: { kind: "folder", path: other }, mode: "copy" },
      previewId: previewed.ok ? previewed.preview.previewId : null,
      scope: GLOBAL,
    });
    assert.deepEqual(wrongSource, { ok: false, error: { kind: "stale-preview" } });
    assert.deepEqual(await store.records(), []);
  });

  test("同名插件已装：预览就带 plugin-exists，安装拒绝", async () => {
    const source = await makeSource();
    assert.equal((await installFolder(source, "link")).result.ok, true);
    const again = await store.preview({ source: { kind: "folder", path: source }, mode: "link" });
    assert.equal(again.ok && again.preview.conflicts.some((c) => c.kind === "plugin-exists"), true);
    const result = await store.install({ preview: { source: { kind: "folder", path: source }, mode: "link" }, previewId: null, scope: GLOBAL });
    assert.equal(!result.ok && result.error.kind, "conflict");
  });

  test("上次卸载留下的孤儿目录（目录在、记录不在）：归档它再装，不覆盖不删", async () => {
    const source = await makeSource();
    await put(join(configDir, "plugins", "demo"), "old.txt", "孤儿");
    const { result } = await installFolder(source, "copy");
    assert.equal(result.ok, true);
    const archived = await readdir(join(configDir, "plugins-archive"));
    assert.equal(archived.some((name) => name.startsWith("demo-orphan")), true);
    assert.equal(await readFile(join(configDir, "plugins-archive", archived.find((n) => n.startsWith("demo-orphan")) ?? "", "old.txt"), "utf8"), "孤儿");
  });

  test("记录里不含任何路径之外的派生物：技能与 MCP 每次现读", async () => {
    const source = await makeSource();
    await installFolder(source, "link");
    const raw = await readFile(join(configDir, "plugins.json"), "utf8");
    assert.equal(raw.includes("demo-skill"), false);
    assert.equal(raw.includes("server.js"), false);
  });
});

describe("冲突：重名技能拒装", () => {
  test("与用户自己的技能重名（按 name）：预览与安装都拒", async () => {
    userSkills = [{ slug: "mine", name: "demo-skill" }];
    const source = await makeSource();
    const previewed = await store.preview({ source: { kind: "folder", path: source }, mode: "link" });
    assert.deepEqual(previewed.ok && previewed.preview.conflicts, [
      { kind: "skill-name", skill: "demo-skill", with: { origin: "user-skill", name: "demo-skill" } },
    ]);
    const result = await store.install({ preview: { source: { kind: "folder", path: source }, mode: "link" }, previewId: null, scope: GLOBAL });
    assert.equal(!result.ok && result.error.kind, "conflict");
    assert.deepEqual(await store.records(), []);
  });

  test("目录名撞上用户技能的 slug 也算（/skill:<slug> 点名会有歧义）", async () => {
    userSkills = [{ slug: "demo-skill", name: "完全不同的名字" }];
    const source = await makeSource();
    const previewed = await store.preview({ source: { kind: "folder", path: source }, mode: "link" });
    assert.equal(previewed.ok && previewed.preview.conflicts.length, 1);
  });

  test("与别的插件的技能重名：拒装并说是哪个插件", async () => {
    const a = await makeSource("alpha", { skill: "shared" });
    assert.equal((await installFolder(a, "link")).result.ok, true);
    const b = await makeSource("beta", { skill: "shared" });
    const previewed = await store.preview({ source: { kind: "folder", path: b }, mode: "link" });
    assert.deepEqual(previewed.ok && previewed.preview.conflicts, [
      { kind: "skill-name", skill: "shared", with: { origin: "plugin", name: "alpha" } },
    ]);
  });

  test("预览之后用户又建了同名技能：安装时的复查仍然拒装（暂存保留，对话框还能 discard）", async () => {
    const source = await makeSource();
    const previewed = await store.preview({ source: { kind: "folder", path: source }, mode: "copy" });
    assert.equal(previewed.ok, true);
    userSkills = [{ slug: "x", name: "demo-skill" }];
    const result = await store.install({
      preview: { source: { kind: "folder", path: source }, mode: "copy" },
      previewId: previewed.ok ? previewed.preview.previewId : null,
      scope: GLOBAL,
    });
    assert.equal(!result.ok && result.error.kind, "conflict");
    assert.deepEqual(await store.records(), []);
  });

  test("两个插件的 MCP 服务名规整后撞名（a.b 与 a_b）：拒装", async () => {
    const one = join(base, "sources", "a.b");
    await put(one, ".mcp.json", JSON.stringify({ mcpServers: { s: { command: "x" } } }));
    assert.equal((await installFolder(one, "link")).result.ok, true);
    const two = join(base, "sources", "a_b");
    await put(two, ".mcp.json", JSON.stringify({ mcpServers: { s: { command: "y" } } }));
    const previewed = await store.preview({ source: { kind: "folder", path: two }, mode: "link" });
    assert.equal(previewed.ok && previewed.preview.conflicts[0]?.kind, "mcp-name");
  });
});

describe("开轮装配", () => {
  async function installDemo(scope: PluginScope = GLOBAL): Promise<string> {
    const source = await makeSource();
    assert.equal((await installFolder(source, "link", scope)).result.ok, true);
    return source;
  }

  test("范围：global 覆盖所有会话（含 Home）；workspaces 只覆盖名单里的；off 谁也不叠", async () => {
    await installDemo({ kind: "workspaces", ids: ["w1"] });
    assert.equal((await store.assemble({ id: "w1", name: "n", path: "/p" })).skills.length, 1);
    assert.equal((await store.assemble({ id: "w2", name: "n", path: "/p" })).skills.length, 0);
    assert.equal((await store.assemble(null)).skills.length, 0);
    await store.setScope("demo", GLOBAL);
    assert.equal((await store.assemble(null)).skills.length, 1);
    await store.setScope("demo", { kind: "off" });
    assert.equal((await store.assemble(null)).skills.length, 0);
    assert.equal((await store.assemble({ id: "w1", name: "n", path: "/p" })).skills.length, 0);
  });

  test("技能：每条一个目录，按（插件名, slug）排序；目录是 pi 能当技能根的那一层", async () => {
    const a = await makeSource("bravo");
    await put(a, "skills/aaa/SKILL.md", SKILL("aaa"));
    await installFolder(a, "link");
    const b = await makeSource("alpha");
    await installFolder(b, "link");
    const assembled = await store.assemble(null);
    assert.deepEqual(assembled.skills.map((s) => `${s.plugin}/${s.slug}`), ["alpha/alpha-skill", "bravo/aaa", "bravo/bravo-skill"]);
    assert.deepEqual(assembled.skillDirs, assembled.skills.map((s) => join(s.file, "..")));
  });

  test("MCP：服务名 plugin_<插件>_<服务>，变量替换（根、数据目录、配置、密钥），并补上 CLAUDE_PLUGIN_* 环境变量", async () => {
    const source = await installDemo();
    await store.setConfig("demo", "api_key", "s3cr3t");
    const { mcpServers } = await store.assemble(null);
    assert.deepEqual(Object.keys(mcpServers), ["plugin_demo_srv"]);
    const server = mcpServers["plugin_demo_srv"];
    assert.deepEqual(server, {
      transport: "stdio",
      command: "node",
      args: [join(source, "server.js"), "--key", "s3cr3t", "--region", "cn"],
      env: { CLAUDE_PLUGIN_ROOT: source, CLAUDE_PLUGIN_DATA: join(configDir, "plugin-data", "demo"), DATA: join(configDir, "plugin-data", "demo") },
    });
    assert.equal((await stat(join(configDir, "plugin-data", "demo"))).isDirectory(), true);
  });

  test("引用项目根（CLAUDE_PROJECT_DIR）：装配给 ${workspaceFolder} 占位，再走现有解析——工作区里换成根，Home 会话里跳过；用户同名 server 赢", async () => {
    const root = join(base, "sources", "proj");
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { s: { command: "run", cwd: "${CLAUDE_PROJECT_DIR}", args: ["--root", "${CLAUDE_PROJECT_DIR}/x"] } } }));
    await installFolder(root, "link");
    const { mcpServers } = await store.assemble({ id: "w", name: "论文", path: "/papers" });
    assert.equal(mcpServers["plugin_proj_s"]?.transport, "stdio");
    const merged = (workspace: { id: string; name: string; path: string } | null, user: Record<string, never> = {}) =>
      resolveServersForWorkspace(mergeMcpConfigs(mcpServers, mergeMcpConfigs(user, {})), workspace);
    assert.deepEqual(merged({ id: "w", name: "论文", path: "/papers" })["plugin_proj_s"], {
      transport: "stdio",
      command: "run",
      cwd: "/papers",
      args: ["--root", "/papers/x"],
      env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: join(configDir, "plugin-data", "proj") },
    });
    assert.equal("plugin_proj_s" in merged(null), false);
    // 用户自己起了同名 server：垫在底下的插件版被它盖掉
    const overridden = resolveServersForWorkspace(
      mergeMcpConfigs(mcpServers, { plugin_proj_s: { transport: "stdio", command: "mine" } }),
      { id: "w", name: "论文", path: "/papers" },
    );
    assert.equal(overridden["plugin_proj_s"]?.transport === "stdio" && overridden["plugin_proj_s"].command, "mine");
  });

  test("必填配置没填：这台 MCP 不叠（不用空值硬起），技能照常", async () => {
    await installDemo();
    const assembled = await store.assemble(null);
    assert.deepEqual(assembled.mcpServers, {});
    assert.equal(assembled.skills.length, 1);
  });

  test("引用了不认识的变量（ZCODE_BASE_URL）：这台 MCP 不叠，详情里说明原因", async () => {
    const root = join(base, "sources", "zc");
    await put(root, ".mcp.json", JSON.stringify({ mcpServers: { img: { type: "http", url: "${ZCODE_BASE_URL}/mcp" } } }));
    await installFolder(root, "link");
    assert.deepEqual((await store.assemble(null)).mcpServers, {});
    const view = (await store.listViews())[0];
    assert.deepEqual(view?.mcp[0]?.problem, { kind: "unknown-variable", variable: "ZCODE_BASE_URL" });
  });

  test("用户技能和插件技能撞名（装好之后才建的）：用户的赢，插件那条不叠，视图里报冲突", async () => {
    await installDemo();
    userSkills = [{ slug: "later", name: "demo-skill" }];
    assert.equal((await store.assemble(null)).skills.length, 0);
    assert.equal((await store.skillMetas()).length, 0);
    assert.equal((await store.listViews())[0]?.conflicts.length, 1);
  });

  test("目录读不了（链接的源目录被删）：跳过这个插件，不拦其它", async () => {
    const gone = await makeSource("gone");
    await installFolder(gone, "link");
    const kept = await makeSource("kept");
    await installFolder(kept, "link");
    await rm(gone, { recursive: true });
    const assembled = await store.assemble(null);
    assert.deepEqual(assembled.skills.map((s) => s.plugin), ["kept"]);
    const views = await store.listViews();
    assert.equal(views.find((v) => v.id === "plugin:gone")?.problems[0]?.kind, "root-missing");
  });

  test("skillMetas：SkillMeta 形状，global / workspaces 跟着启用范围，isSkillAvailable 原样可用", async () => {
    await installDemo({ kind: "workspaces", ids: ["w2", "w1"] });
    const metas = await store.skillMetas();
    assert.deepEqual(metas, [
      { slug: "demo-skill", name: "demo-skill", description: "做一件事", global: false, workspaces: ["w1", "w2"], missing: false, linkedPath: null },
    ]);
  });
});

describe("配置与密钥", () => {
  async function installDemo(): Promise<void> {
    assert.equal((await installFolder(await makeSource(), "link")).result.ok, true);
  }

  test("敏感值进密钥库，plugins.json 里只有键名、没有值；非敏感值进记录", async () => {
    await installDemo();
    await store.setConfig("demo", "api_key", "TOP-SECRET");
    await store.setConfig("demo", "region", "us");
    assert.equal(secrets.map.get("plugin:demo:api_key"), "TOP-SECRET");
    const raw = await readFile(join(configDir, "plugins.json"), "utf8");
    assert.equal(raw.includes("TOP-SECRET"), false);
    const record = JSON.parse(raw).plugins.demo;
    assert.deepEqual(record.secretKeys, ["api_key"]);
    assert.deepEqual(record.config, { region: "us" });
  });

  test("视图里敏感项只说有没有填；命令行里它是掩码", async () => {
    await installDemo();
    await store.setConfig("demo", "api_key", "TOP-SECRET");
    const view = (await store.listViews())[0];
    const key = view?.config.find((c) => c.field.key === "api_key");
    assert.deepEqual([key?.value, key?.isSet], [null, true]);
    assert.equal(JSON.stringify(view).includes("TOP-SECRET"), false);
    assert.equal(view?.mcp[0]?.commandLine.includes("••••••"), true);
    assert.equal(view?.mcp[0]?.problem, null);
  });

  test("传 null 清除：敏感的从密钥库删，非敏感的从记录删", async () => {
    await installDemo();
    await store.setConfig("demo", "api_key", "k");
    await store.setConfig("demo", "region", "us");
    await store.setConfig("demo", "api_key", null);
    await store.setConfig("demo", "region", null);
    assert.equal(secrets.map.size, 0);
    const record = (await store.records())[0];
    assert.deepEqual([record?.config, record?.secretKeys], [{}, []]);
  });

  test("未声明的键、类型不对、超出范围、不在选项里：拒绝，不写盘", async () => {
    const root = join(base, "sources", "typed");
    await put(
      root,
      ".claude-plugin/plugin.json",
      JSON.stringify({
        name: "typed",
        userConfig: {
          n: { type: "number", min: 1, max: 10 },
          b: { type: "boolean" },
          o: { type: "string", options: ["x", "y"] },
        },
      }),
    );
    await put(root, "skills/t/SKILL.md", SKILL("t"));
    await installFolder(root, "link");
    await assert.rejects(store.setConfig("typed", "ghost", "v"), /Unknown config key/);
    await assert.rejects(store.setConfig("typed", "n", "5"), /must be a number/);
    await assert.rejects(store.setConfig("typed", "n", 11), /≤ 10/);
    await assert.rejects(store.setConfig("typed", "n", 0), /≥ 1/);
    await assert.rejects(store.setConfig("typed", "b", "true"), /boolean/);
    await assert.rejects(store.setConfig("typed", "o", "z"), /one of/);
    await store.setConfig("typed", "n", 5);
    await store.setConfig("typed", "b", false);
    await store.setConfig("typed", "o", "y");
    assert.deepEqual((await store.records())[0]?.config, { n: 5, b: false, o: "y" });
  });

  test("不存在的插件：抛", async () => {
    await assert.rejects(store.setConfig("nope", "k", "v"), /No such plugin/);
    await assert.rejects(store.setScope("nope", GLOBAL), /No such plugin/);
    await assert.rejects(store.uninstall("nope"), /No such plugin/);
  });
});

describe("启用范围", () => {
  test("停用不改位置记忆；再启用回到原位置；换范围就是新位置", async () => {
    await installFolder(await makeSource(), "link", { kind: "workspaces", ids: ["w1"] });
    await store.setScope("demo", { kind: "off" });
    let record = (await store.records())[0];
    assert.deepEqual([record?.scope, record?.placement], [{ kind: "off" }, { kind: "workspaces", ids: ["w1"] }]);
    await store.setScope("demo", { kind: "global" });
    record = (await store.records())[0];
    assert.deepEqual([record?.scope, record?.placement], [{ kind: "global" }, { kind: "global" }]);
  });

  test("形状不对的范围当停用：宁可不生效也不要意外全开", async () => {
    await installFolder(await makeSource(), "link");
    // @ts-expect-error 故意传坏形状
    await store.setScope("demo", { kind: "everything" });
    assert.deepEqual((await store.records())[0]?.scope, { kind: "off" });
  });
});

describe("工作区被移除", () => {
  test("从范围与位置里摘掉它；摘空的「只在这些」转停用，位置回到所有工作区", async () => {
    await installFolder(await makeSource("one"), "link", { kind: "workspaces", ids: ["w1", "w2"] });
    await installFolder(await makeSource("two"), "link", { kind: "workspaces", ids: ["w1"] });
    await installFolder(await makeSource("three"), "link", GLOBAL);
    await store.removeWorkspace("w1");
    const by = async (name: string) => (await store.records()).find((r) => r.name === name);
    assert.deepEqual((await by("one"))?.scope, { kind: "workspaces", ids: ["w2"] });
    assert.deepEqual([(await by("two"))?.scope, (await by("two"))?.placement], [{ kind: "off" }, { kind: "global" }]);
    assert.deepEqual((await by("three"))?.scope, GLOBAL);
  });

  test("停用的插件位置记忆里的工作区被移除：位置同样摘掉", async () => {
    await installFolder(await makeSource("one"), "link", { kind: "workspaces", ids: ["w1", "w2"] });
    await store.setScope("one", { kind: "off" });
    await store.removeWorkspace("w2");
    const record = (await store.records())[0];
    assert.deepEqual([record?.scope, record?.placement], [{ kind: "off" }, { kind: "workspaces", ids: ["w1"] }]);
  });
});

describe("卸载 = 归档不是删除", () => {
  test("复制安装：副本整个挪进 plugins-archive/<name>-<时间戳>/，记录与密钥清掉，数据目录留着", async () => {
    const source = await makeSource();
    await installFolder(source, "copy");
    await store.setConfig("demo", "api_key", "k");
    await put(join(configDir, "plugin-data", "demo"), "cache.db", "数据");
    await store.uninstall("demo");
    assert.deepEqual(await store.records(), []);
    await assert.rejects(stat(join(configDir, "plugins", "demo")));
    const archive = await readdir(join(configDir, "plugins-archive"));
    const folder = archive.find((name) => /^demo-\d{8}-\d{6}$/.test(name));
    assert.ok(folder !== undefined, archive.join(","));
    assert.equal(await readFile(join(configDir, "plugins-archive", folder, "server.js"), "utf8"), "// server");
    const recordFile = JSON.parse(await readFile(join(configDir, "plugins-archive", `${folder}.json`), "utf8"));
    assert.equal(recordFile.record.name, "demo");
    assert.equal(secrets.map.size, 0);
    assert.equal(await readFile(join(configDir, "plugin-data", "demo", "cache.db"), "utf8"), "数据");
    // 源目录没动
    assert.equal((await stat(join(source, "server.js"))).isFile(), true);
  });

  test("链接安装：只归档记录，绝不碰用户的源文件夹", async () => {
    const source = await makeSource();
    await installFolder(source, "link");
    await store.uninstall("demo");
    assert.deepEqual(await store.records(), []);
    assert.equal(await readFile(join(source, "server.js"), "utf8"), "// server");
    assert.equal((await stat(join(source, "skills", "demo-skill", "SKILL.md"))).isFile(), true);
    const archive = await readdir(join(configDir, "plugins-archive"));
    assert.equal(archive.length, 1);
    assert.match(archive[0] ?? "", /^demo-\d{8}-\d{6}\.json$/);
  });

  test("卸载后装配不再叠它；同名可以重新装", async () => {
    const source = await makeSource();
    await installFolder(source, "copy");
    await store.uninstall("demo");
    assert.equal((await store.assemble(null)).skills.length, 0);
    assert.equal((await installFolder(source, "copy")).result.ok, true);
    assert.equal((await store.assemble(null)).skills.length, 1);
  });
});

describe("并发", () => {
  test("两次并发改记录（范围 + 配置）都不丢", async () => {
    await installFolder(await makeSource(), "link");
    await Promise.all([store.setScope("demo", { kind: "workspaces", ids: ["w9"] }), store.setConfig("demo", "region", "eu")]);
    const record = (await store.records())[0];
    assert.deepEqual(record?.scope, { kind: "workspaces", ids: ["w9"] });
    assert.deepEqual(record?.config, { region: "eu" });
  });
});

describe("启动清理", () => {
  test("init 清掉上次没收尾的暂存", async () => {
    await put(join(configDir, "plugins-staging", "left-over"), "x.txt", "x");
    await store.init();
    await assert.rejects(stat(join(configDir, "plugins-staging")));
  });
});

describe("git 来源", () => {
  test("地址只收 https / ssh / scp 式；其余拒绝，且不会去跑 git", async () => {
    let called = false;
    const spy: GitRunner = async () => {
      called = true;
      return "";
    };
    const guarded = new PluginStore({ configDir, secrets, userSkills: async () => [], git: spy });
    for (const url of ["http://x/y.git", "git://x/y.git", "file:///tmp/repo", "ext::sh -c id", "--upload-pack=evil", "/local/path", "", "https://", "ssh://", "user@host"]) {
      const result = await guarded.preview({ source: { kind: "git", url }, mode: "copy" });
      assert.equal(!result.ok && result.error.kind, "git-url-rejected", url);
    }
    assert.equal(called, false);
  });

  test("用假 git 走全流程：克隆进暂存 → 预览 → 安装，记录里有地址与提交", async () => {
    const calls: string[][] = [];
    const fake: GitRunner = async (args, options) => {
      calls.push([...args]);
      if (args[0] === "clone") {
        const target = args[args.length - 1] ?? "";
        await put(target, "skills/g/SKILL.md", SKILL("g-skill"));
        await put(target, ".claude-plugin/plugin.json", JSON.stringify({ name: "from-git", version: "2.0.0" }));
        return "";
      }
      assert.equal(args[0], "rev-parse");
      assert.ok(options.cwd !== undefined);
      return "abc123def\n";
    };
    const gitStore = new PluginStore({ configDir, secrets, userSkills: async () => [], git: fake });
    const url = "https://example.com/owner/from-git.git";
    const previewed = await gitStore.preview({ source: { kind: "git", url }, mode: "copy" });
    assert.equal(previewed.ok, true);
    if (!previewed.ok) return;
    assert.equal(previewed.preview.mode, "git");
    assert.deepEqual(calls[0]?.slice(0, 4), ["clone", "--depth", "1", "--no-tags"]);
    assert.equal(calls[0]?.[4], "--");
    const result = await gitStore.install({ preview: { source: { kind: "git", url }, mode: "copy" }, previewId: previewed.preview.previewId, scope: GLOBAL });
    assert.deepEqual(result, { ok: true, id: "plugin:from-git" });
    const record = (await gitStore.records())[0];
    assert.deepEqual(record?.source, { kind: "git", url, commit: "abc123def" });
    assert.equal((await stat(join(configDir, "plugins", "from-git", "skills", "g", "SKILL.md"))).isFile(), true);
  });

  test("克隆失败 / 超时：git-failed，暂存清掉", async () => {
    const failing: GitRunner = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "fatal: repository not found\n" });
    };
    const gitStore = new PluginStore({ configDir, secrets, userSkills: async () => [], git: failing });
    const result = await gitStore.preview({ source: { kind: "git", url: "https://example.com/x/y.git" }, mode: "copy" });
    assert.deepEqual(result, { ok: false, error: { kind: "git-failed", message: "fatal: repository not found" } });
    const timedOut: GitRunner = async () => {
      throw Object.assign(new Error("timeout"), { killed: true });
    };
    const second = new PluginStore({ configDir, secrets, userSkills: async () => [], git: timedOut });
    const t = await second.preview({ source: { kind: "git", url: "https://example.com/x/y.git" }, mode: "copy" });
    assert.deepEqual(t, { ok: false, error: { kind: "git-failed", message: "timeout" } });
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
  });

  test("克隆下来的仓库里有指到根外的符号链接：拒绝", async () => {
    const fake: GitRunner = async (args) => {
      if (args[0] === "clone") {
        const target = args[args.length - 1] ?? "";
        await put(target, "skills/g/SKILL.md", SKILL("g-skill"));
        await symlink("/etc", join(target, "etc-link"));
        return "";
      }
      return "deadbeef\n";
    };
    const gitStore = new PluginStore({ configDir, secrets, userSkills: async () => [], git: fake });
    const result = await gitStore.preview({ source: { kind: "git", url: "https://example.com/o/repo.git" }, mode: "copy" });
    assert.deepEqual(result, { ok: false, error: { kind: "symlink-escape", paths: ["etc-link"] } });
  });

  let hasGit = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    hasGit = false;
  }
  async function makeRepo(): Promise<{ repo: string; head: string }> {
    const repo = join(base, "repo");
    await put(repo, "skills/r/SKILL.md", SKILL("r-skill"));
    await put(repo, ".claude-plugin/plugin.json", JSON.stringify({ name: "real-git" }));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env });
    return { repo, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env }).toString().trim() };
  }
  const url = "https://example.com/o/real-git.git";

  test("真 git：生产执行器的协议白名单（https:ssh）拦得住本地路径 / file 协议的克隆", { skip: hasGit ? false : "没有 git" }, async () => {
    const { repo } = await makeRepo();
    // 把测试地址改写成本地路径再交给**生产**的 runGit：GIT_ALLOW_PROTOCOL 不含 file，真 git 拒绝
    const rewriting: GitRunner = (args, options) => runGit(args.map((arg) => (arg === url ? repo : arg)), options);
    const gitStore = new PluginStore({ configDir, secrets, userSkills: async () => [], git: rewriting });
    const result = await gitStore.preview({ source: { kind: "git", url }, mode: "copy" });
    assert.equal(!result.ok && result.error.kind, "git-failed");
    assert.match(!result.ok && result.error.kind === "git-failed" ? result.error.message : "", /not allowed/);
    assert.deepEqual(await readdir(join(configDir, "plugins-staging")), []);
  });

  test("真 git：克隆参数合法、rev-parse 的提交写进记录（测试执行器只放开 file 协议以便本地仓库当远端）", { skip: hasGit ? false : "没有 git" }, async () => {
    const { repo, head } = await makeRepo();
    const relaxed: GitRunner = async (args, options) => {
      const rewritten = args.map((arg) => (arg === url ? `file://${repo}` : arg));
      return execFileSync("git", rewritten, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file:https:ssh" },
      }).toString();
    };
    const gitStore = new PluginStore({ configDir, secrets, userSkills: async () => [], git: relaxed });
    const previewed = await gitStore.preview({ source: { kind: "git", url }, mode: "copy" });
    assert.equal(previewed.ok, true, JSON.stringify(previewed));
    if (!previewed.ok) return;
    const result = await gitStore.install({ preview: { source: { kind: "git", url }, mode: "copy" }, previewId: previewed.preview.previewId, scope: GLOBAL });
    assert.equal(result.ok, true);
    assert.deepEqual((await gitStore.records())[0]?.source, { kind: "git", url, commit: head });
    assert.equal((await stat(join(configDir, "plugins", "real-git", ".git"))).isDirectory(), true);
  });
});
