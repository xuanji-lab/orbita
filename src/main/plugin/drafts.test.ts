/**
 * 「正在做」列表的扫描：真目录（临时工作区）+ 假端口。
 * 重点：有清单才列、已装的（链接 / 拷贝）不列、越界（符号链接指到工作区外）不列、坏清单照列并标出、
 * 多工作区、会话记录带出来、最近改动时间。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PluginRecord } from "./records.ts";
import { latestChange, scanDrafts, type DraftScanDeps } from "./drafts.ts";

let base = "";
let wsA = "";
let wsB = "";
let outside = "";
let records: PluginRecord[];
let sessionsByPath: Map<string, { sessionId: string; title: string }>;

async function put(root: string, relative: string, content: string): Promise<void> {
  const file = join(root, ...relative.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content, "utf8");
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, description: `${name} 说明`, ...extra });

function record(name: string, source: PluginRecord["source"]): PluginRecord {
  return { name, source, version: null, installedAt: 1, updatedAt: 1, scope: { kind: "global" }, placement: { kind: "global" } as PluginRecord["placement"], config: {}, secretKeys: [] };
}

const deps = (): DraftScanDeps => ({
  workspaces: async () => [
    { id: "wa", path: wsA },
    { id: "wb", path: wsB },
  ],
  records: async () => records,
  sessionOf: async (path) => sessionsByPath.get(path) ?? null,
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "drafts-")));
  wsA = join(base, "a");
  wsB = join(base, "b");
  outside = join(base, "outside");
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  await mkdir(outside, { recursive: true });
  records = [];
  sessionsByPath = new Map();
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("scanDrafts", () => {
  test("有清单、没装的列出：名字 / 显示名 / 描述 / 真实路径 / 所属工作区", async () => {
    await put(wsA, "plugins/lit/.claude-plugin/plugin.json", manifest("lit", { displayName: "文献追踪" }));
    const [entry, ...rest] = await scanDrafts(deps());
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { workspaceId: entry?.workspaceId, path: entry?.path, name: entry?.name, displayName: entry?.displayName, description: entry?.description, sessionId: entry?.sessionId, sessionTitle: entry?.sessionTitle, manifestProblem: entry?.manifestProblem },
      { workspaceId: "wa", path: join(wsA, "plugins", "lit"), name: "lit", displayName: "文献追踪", description: "lit 说明", sessionId: null, sessionTitle: null, manifestProblem: null },
    );
  });

  test("没有 plugins/ 目录 / 空文件夹（没清单）/ 非目录的文件 / 点开头的：都不列", async () => {
    await mkdir(join(wsB, "other"), { recursive: true });
    await mkdir(join(wsA, "plugins", "empty"), { recursive: true });
    await put(wsA, "plugins/skills-only/skills/x/SKILL.md", "---\nname: x\ndescription: d\n---\n");
    await writeFile(join(wsA, "plugins", "note.txt"), "x", "utf8");
    await put(wsA, "plugins/.hidden/.claude-plugin/plugin.json", manifest("hidden"));
    assert.deepEqual(await scanDrafts(deps()), []);
  });

  test("已装的不列：链接装指向同一文件夹（含符号链接到它）、拷贝装且来源是它；同名但来自别处的仍列", async () => {
    await put(wsA, "plugins/linked/.claude-plugin/plugin.json", manifest("linked"));
    await put(wsA, "plugins/copied/.claude-plugin/plugin.json", manifest("copied"));
    await put(wsA, "plugins/draft/.claude-plugin/plugin.json", manifest("draft"));
    await put(wsA, "plugins/same-name/.claude-plugin/plugin.json", manifest("elsewhere"));
    await symlink(join(wsA, "plugins", "linked"), join(base, "alias"));
    records = [
      record("linked", { kind: "link", path: join(base, "alias") }),
      record("copied", { kind: "copy", from: join(wsA, "plugins", "copied") }),
      record("elsewhere", { kind: "link", path: join(outside, "elsewhere") }),
      record("builtin-one", { kind: "builtin" }),
    ];
    const names = (await scanDrafts(deps())).map((entry) => entry.name).sort();
    assert.deepEqual(names, ["draft", "elsewhere"]);
  });

  test("越界：plugins/x 是指到工作区外的符号链接 → 不列（不泄露外部文件夹）；plugins 本身是指到外面的链接同理", async () => {
    await put(outside, "evil/.claude-plugin/plugin.json", manifest("evil"));
    await mkdir(join(wsA, "plugins"), { recursive: true });
    await symlink(join(outside, "evil"), join(wsA, "plugins", "evil"));
    await symlink(outside, join(wsB, "plugins"));
    await put(outside, "evil2/.claude-plugin/plugin.json", manifest("evil2"));
    assert.deepEqual(await scanDrafts(deps()), []);
  });

  test("坏清单（写坏的 JSON）照列，标出原文；没写 name 退回文件夹名", async () => {
    await put(wsA, "plugins/Half/.claude-plugin/plugin.json", "{ \"name\": ");
    await put(wsA, "plugins/anon/.claude-plugin/plugin.json", JSON.stringify({ description: "没名字" }));
    const entries = await scanDrafts(deps());
    const half = entries.find((entry) => entry.path.endsWith("Half"));
    assert.ok(half);
    assert.match(half.manifestProblem ?? "", /plugin\.json/);
    assert.equal(half.name, "half");
    assert.equal(entries.find((entry) => entry.path.endsWith("anon"))?.name, "anon");
  });

  test("多个工作区都扫；会话记录带出来（标题空串当没有标题）；按最近改动倒序", async () => {
    await put(wsA, "plugins/old/.claude-plugin/plugin.json", manifest("old"));
    await put(wsB, "plugins/new/.claude-plugin/plugin.json", manifest("new"));
    await put(wsB, "plugins/untitled/.claude-plugin/plugin.json", manifest("untitled"));
    const old = new Date(1_600_000_000_000);
    for (const dir of [join(wsA, "plugins", "old"), join(wsA, "plugins", "old", ".claude-plugin"), join(wsA, "plugins", "old", ".claude-plugin", "plugin.json")]) await utimes(dir, old, old);
    sessionsByPath.set(join(wsB, "plugins", "new"), { sessionId: "s1", title: "做个推荐算法插件" });
    sessionsByPath.set(join(wsB, "plugins", "untitled"), { sessionId: "s2", title: "" });
    const entries = await scanDrafts(deps());
    assert.deepEqual(entries.map((entry) => entry.name).at(-1), "old");
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("old")?.workspaceId, "wa");
    assert.equal(byName.get("old")?.updatedAt, old.getTime());
    assert.deepEqual([byName.get("new")?.sessionId, byName.get("new")?.sessionTitle], ["s1", "做个推荐算法插件"]);
    assert.deepEqual([byName.get("untitled")?.sessionId, byName.get("untitled")?.sessionTitle], ["s2", null]);
  });

  test("工作区根已经不存在：跳过，不抛", async () => {
    await put(wsA, "plugins/lit/.claude-plugin/plugin.json", manifest("lit"));
    const gone = { ...deps(), workspaces: async () => [{ id: "gone", path: join(base, "nope") }, { id: "wa", path: wsA }] };
    assert.deepEqual((await scanDrafts(gone)).map((entry) => entry.workspaceId), ["wa"]);
  });
});

describe("latestChange", () => {
  test("取深处文件的 mtime；跳过 node_modules", async () => {
    const root = join(base, "p");
    await put(root, "skills/x/SKILL.md", "x");
    await put(root, "node_modules/big/index.js", "x");
    const past = new Date(1_500_000_000_000);
    const future = new Date(1_900_000_000_000);
    await utimes(join(root, "node_modules", "big", "index.js"), future, future);
    await utimes(join(root, "node_modules", "big"), future, future);
    for (const path of [join(root, "skills", "x", "SKILL.md"), join(root, "skills", "x"), join(root, "skills"), root]) await utimes(path, past, past);
    const deepNew = new Date(1_700_000_000_000);
    await utimes(join(root, "skills", "x", "SKILL.md"), deepNew, deepNew);
    assert.equal(await latestChange(root), deepNew.getTime());
  });
});
