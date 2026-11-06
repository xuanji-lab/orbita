import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { McpStore } from "../mcp/store.ts";
import { SkillStore } from "../skill/store.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { applyMcpScope, applySkillScope, mcpViews, skillViews } from "./legacy.ts";

let dir = "";
let skills: SkillStore;
let mcp: McpStore;

const ws = (id: string, name: string): Workspace => ({ id, name, path: `/w/${name}`, createdAt: 0, attachedDirs: [] });
const WORKSPACES = [ws("id-a", "论文"), ws("id-b", "orbita")];

async function putSkill(slug: string, name = slug): Promise<void> {
  await mkdir(join(dir, "skills", slug), { recursive: true });
  await writeFile(join(dir, "skills", slug, "SKILL.md"), `---\nname: ${name}\ndescription: 描述 ${slug}\n---\n正文\n`, "utf8");
}

async function writeMcp(servers: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

const listSkillViews = async () => skillViews(await skills.list(), skills.storeRoot());
const listMcpViews = async () => mcpViews(await mcp.read(), WORKSPACES);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-plugin-legacy-"));
  skills = new SkillStore(dir);
  mcp = new McpStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("旧技能 → 一样东西的插件", () => {
  test("global 链 → 所有工作区；链在某些工作区 → 那些；哪里都没链 → 停用且没有位置", async () => {
    await putSkill("g");
    await putSkill("w");
    await putSkill("none");
    await skills.link("g", { kind: "global" });
    await skills.link("w", { kind: "workspace", workspaceId: "id-a" });
    await skills.link("w", { kind: "workspace", workspaceId: "id-b" });
    const views = await listSkillViews();
    const by = (slug: string) => views.find((v) => v.id === `skill:${slug}`);
    assert.deepEqual([by("g")?.scope, by("g")?.placement], [{ kind: "global" }, { kind: "global" }]);
    assert.deepEqual(by("w")?.scope, { kind: "workspaces", ids: ["id-a", "id-b"] });
    assert.deepEqual([by("none")?.scope, by("none")?.placement], [{ kind: "off" }, null]);
    assert.deepEqual(by("g")?.contents, { skills: 1, mcp: 0, scripts: false });
    assert.equal(by("g")?.origin, "user-skill");
    assert.equal(by("g")?.location, join(dir, "skills", "g"));
  });

  test("显示名是 SKILL.md 的 name，不是目录名；断链的也列出来：停用、没有位置、带断链问题（清理入口靠它）", async () => {
    await putSkill("dir-name", "显示名");
    await skills.link("dir-name", { kind: "global" });
    await mkdir(join(dir, "skill-links", "global"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(dir, "skills", "ghost"), join(dir, "skill-links", "global", "ghost"));
    const views = await listSkillViews();
    assert.deepEqual(views.map((v) => v.id), ["skill:dir-name", "skill:ghost"]);
    assert.equal(views[0]?.name, "显示名");
    assert.deepEqual(views[0]?.problems, []);
    const ghost = views[1];
    // 链接还在（global），但真身没了：不能算「在全局生效」，也不能当作有位置
    assert.deepEqual([ghost?.scope, ghost?.placement], [{ kind: "off" }, null]);
    assert.deepEqual(ghost?.problems, [{ kind: "skill-folder-missing", detail: "ghost" }]);
  });

  test("写路径：off 把 global 与各工作区的链都移出；中心存储文件不动", async () => {
    await putSkill("a");
    await skills.link("a", { kind: "workspace", workspaceId: "id-a" });
    await skills.link("a", { kind: "workspace", workspaceId: "id-b" });
    const meta = (await skills.list())[0];
    assert.ok(meta !== undefined);
    await applySkillScope(skills, meta, { kind: "off" });
    const after = (await skills.list())[0];
    assert.deepEqual([after?.global, after?.workspaces], [false, []]);
    assert.equal(await readFile(join(dir, "skills", "a", "SKILL.md"), "utf8").then((t) => t.includes("正文")), true);
  });

  test("写路径：global 与 workspaces 互斥由 SkillStore 执行；换名单时多出的工作区被移出", async () => {
    await putSkill("a");
    const meta = async () => (await skills.list())[0] ?? assert.fail("没有 a");
    await applySkillScope(skills, await meta(), { kind: "global" });
    assert.equal((await meta()).global, true);
    await applySkillScope(skills, await meta(), { kind: "workspaces", ids: ["id-a", "id-b"] });
    assert.deepEqual([(await meta()).global, (await meta()).workspaces], [false, ["id-a", "id-b"]]);
    await applySkillScope(skills, await meta(), { kind: "workspaces", ids: ["id-b"] });
    assert.deepEqual((await meta()).workspaces, ["id-b"]);
    await applySkillScope(skills, await meta(), { kind: "workspaces", ids: [] });
    assert.deepEqual([(await meta()).global, (await meta()).workspaces], [false, []]);
  });
});

describe("旧 MCP → 一样东西的插件", () => {
  test("白名单为空 → 所有工作区；disabled → 停用但位置仍记着", async () => {
    await writeMcp({ on: { command: "x" }, off: { command: "y", disabled: true } });
    const views = await listMcpViews();
    const on = views.find((v) => v.id === "mcp:on");
    const off = views.find((v) => v.id === "mcp:off");
    assert.deepEqual([on?.scope, on?.placement], [{ kind: "global" }, { kind: "global" }]);
    assert.deepEqual([off?.scope, off?.placement], [{ kind: "off" }, { kind: "global" }]);
    assert.deepEqual(on?.contents, { skills: 0, mcp: 1, scripts: false });
    assert.equal(on?.mcp[0]?.commandLine, "x");
    assert.equal(on?.location, null);
  });

  test("白名单写的是工作区名或 id 都翻成 id；翻不到的丢掉；全翻不到则没有位置、不生效", async () => {
    await writeMcp({
      byName: { command: "x", workspaces: ["论文"] },
      byId: { command: "x", workspaces: ["id-b", "id-a", "gone"] },
      dangling: { command: "x", workspaces: ["gone"] },
    });
    const views = await listMcpViews();
    const by = (name: string) => views.find((v) => v.id === `mcp:${name}`);
    assert.deepEqual(by("byName")?.scope, { kind: "workspaces", ids: ["id-a"] });
    assert.deepEqual(by("byId")?.scope, { kind: "workspaces", ids: ["id-b", "id-a"] });
    assert.deepEqual([by("dangling")?.scope, by("dangling")?.placement], [{ kind: "off" }, null]);
  });

  test("http 与 stdio 都显示一行给人看的描述", async () => {
    await writeMcp({ remote: { type: "http", url: "https://x/mcp" } });
    const view = (await listMcpViews())[0];
    assert.equal(view?.mcp[0]?.transport, "http");
    assert.equal(view?.description, "https://x/mcp");
  });

  test("写路径：off 只设 disabled、白名单保留；global 清白名单并启用；workspaces 写 id；空名单当停用", async () => {
    await writeMcp({ s: { command: "x", workspaces: ["id-a"] } });
    const read = async () => JSON.parse(await readFile(join(dir, "mcp.json"), "utf8")).mcpServers.s;
    await applyMcpScope(mcp, "s", { kind: "off" });
    assert.deepEqual(await read(), { command: "x", workspaces: ["id-a"], disabled: true });
    await applyMcpScope(mcp, "s", { kind: "global" });
    assert.deepEqual(await read(), { command: "x" });
    await applyMcpScope(mcp, "s", { kind: "workspaces", ids: ["id-a", "id-b"] });
    assert.deepEqual(await read(), { command: "x", workspaces: ["id-a", "id-b"] });
    await applyMcpScope(mcp, "s", { kind: "workspaces", ids: [] });
    assert.equal((await read()).disabled, true);
  });

  test("写完再读：视图与写入的范围一致（插件页与旧面板是同一份状态）", async () => {
    await writeMcp({ s: { command: "x" } });
    await applyMcpScope(mcp, "s", { kind: "workspaces", ids: ["id-b"] });
    assert.deepEqual((await listMcpViews())[0]?.scope, { kind: "workspaces", ids: ["id-b"] });
    await applyMcpScope(mcp, "s", { kind: "off" });
    const view = (await listMcpViews())[0];
    assert.deepEqual([view?.scope, view?.placement], [{ kind: "off" }, { kind: "workspaces", ids: ["id-b"] }]);
  });
});
