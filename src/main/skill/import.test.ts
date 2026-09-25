import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillScope } from "../../shared/skill.ts";
import { claudeCodeSkillDirs, importSkills, promaSkillDirs, scanSkillDirs, type SkillSourceDir } from "./import.ts";
import { SkillStore } from "./store.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-skill-import-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, slug: string, description = `about ${slug}`): Promise<string> {
  const path = join(dir, slug);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\nbody of ${slug}\n`);
  return path;
}

describe("scanSkillDirs", () => {
  test("先到先得：后面的同名标 duplicate；orbita 已有的标 in-orbita；Proma 自带的标 built-in；没有 SKILL.md 的目录与坏名字不算", async () => {
    const proma = join(root, "proma", "skills");
    const shared = join(root, "agents");
    await writeSkill(proma, "tdd");
    await writeSkill(proma, "docx");
    await writeSkill(proma, "archify", "diagrams");
    await mkdir(join(proma, "not-a-skill"), { recursive: true });
    await writeSkill(proma, "Bad Name");
    await writeSkill(shared, "archify");
    const tabbitReal = await writeSkill(join(root, "elsewhere"), "tabbit");
    await symlink(tabbitReal, join(shared, "tabbit"));
    const dirs: SkillSourceDir[] = [
      { source: "proma", name: "默认工作区", dir: proma },
      { source: "agent-skills", name: null, dir: shared },
      { source: "claude-code", name: null, dir: join(root, "missing") },
    ];
    const groups = await scanSkillDirs(dirs, new Set(["tdd"]), new Set(["docx"]));
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups[0]?.skills.map((skill) => [skill.slug, skill.status]),
      [
        ["archify", "new"],
        ["docx", "built-in"],
        ["tdd", "in-orbita"],
      ],
    );
    assert.equal(groups[0]?.skills[0]?.description, "diagrams");
    assert.deepEqual(
      groups[1]?.skills.map((skill) => [skill.slug, skill.status, skill.duplicateOf]),
      [
        ["archify", "duplicate", proma],
        ["tabbit", "new", null],
      ],
    );
    assert.deepEqual(groups[2]?.skills, []);
  });
});

describe("来源目录", () => {
  test("Proma：默认工作区排最前，名字取工作区表；Claude Code：synced 下每个账号一组", async () => {
    const promaRoot = join(root, "proma");
    await mkdir(join(promaRoot, "agent-workspaces", "orbita", "skills"), { recursive: true });
    await mkdir(join(promaRoot, "agent-workspaces", "default", "skills"), { recursive: true });
    await writeFile(
      join(promaRoot, "agent-workspaces.json"),
      JSON.stringify({ workspaces: [{ slug: "orbita", name: "orbita" }, { slug: "default", name: "默认工作区" }] }),
    );
    assert.deepEqual(
      (await promaSkillDirs(promaRoot)).map((dir) => [dir.name, dir.dir]),
      [
        ["默认工作区", join(promaRoot, "agent-workspaces", "default", "skills")],
        ["orbita", join(promaRoot, "agent-workspaces", "orbita", "skills")],
      ],
    );
    const claude = join(root, "claude-skills");
    await mkdir(join(claude, "synced", "acct_org"), { recursive: true });
    assert.deepEqual(
      (await claudeCodeSkillDirs(claude)).map((dir) => [dir.name, dir.dir]),
      [
        [null, claude],
        ["synced", join(claude, "synced", "acct_org")],
      ],
    );
  });
});

describe("importSkills + SkillStore", () => {
  test("复制：源改动不跟过来，symlink 源复制的是真身；链接：存储条目指向源；作用域按组，off 不建链", async () => {
    const source = join(root, "src");
    const real = await writeSkill(join(root, "real"), "linked-real");
    await writeSkill(source, "alpha");
    await writeSkill(source, "beta");
    await symlink(real, join(source, "linked-real"));
    const other = join(root, "other");
    await writeSkill(other, "gamma");
    const configDir = join(root, "orbita");
    const store = new SkillStore(configDir);
    const groups = await scanSkillDirs(
      [
        { source: "agent-skills", name: null, dir: source },
        { source: "claude-code", name: null, dir: other },
      ],
      new Set(),
      new Set(),
    );

    const copied = await importSkills(
      groups,
      {
        skills: new Set([join(source, "alpha"), join(source, "linked-real"), join(other, "gamma")]),
        mode: "copy",
        scopes: [{ dir: other, scope: { kind: "off" } }],
      },
      store,
      new Set(),
    );
    assert.deepEqual(copied, { imported: 3, failed: [] });
    await writeFile(join(source, "alpha", "SKILL.md"), "changed");
    assert.match(await readFile(join(configDir, "skills", "alpha", "SKILL.md"), "utf8"), /body of alpha/);
    assert.equal((await lstat(join(configDir, "skills", "linked-real"))).isSymbolicLink(), false);
    const list = await store.list();
    assert.deepEqual(
      list.map((skill) => [skill.slug, skill.global]),
      [
        ["alpha", true],
        ["gamma", false],
        ["linked-real", true],
      ],
    );

    const linked = await importSkills(
      groups,
      { skills: new Set([join(source, "beta"), join(source, "alpha")]), mode: "link", scopes: [] },
      store,
      new Set(),
    );
    // alpha 已在存储里（刚复制过）：拒绝覆盖，记进 failed，beta 照常
    assert.equal(linked.imported, 1);
    assert.deepEqual(linked.failed.map((item) => item.slug), ["alpha"]);
    assert.equal(await readlink(join(configDir, "skills", "beta")), join(source, "beta"));
  });

  test("只导 new / built-in；选中的工作区已不存在 → 这组失败，不替用户换成 global", async () => {
    const source = join(root, "src");
    await writeSkill(source, "alpha");
    await writeSkill(source, "taken");
    const groups = await scanSkillDirs([{ source: "proma", name: "w", dir: source }], new Set(["taken"]), new Set());
    const calls: [string, SkillScope | null][] = [];
    const target = {
      copyFrom: async (dir: string, scope: SkillScope | null) => {
        calls.push([dir, scope]);
        return "x";
      },
      importFrom: async () => "x",
    };
    const result = await importSkills(
      groups,
      {
        skills: new Set([join(source, "alpha"), join(source, "taken")]),
        mode: "copy",
        scopes: [{ dir: source, scope: { kind: "workspace", workspaceId: "gone" } }],
      },
      target,
      new Set(["w-1"]),
    );
    assert.equal(result.imported, 0);
    assert.deepEqual(result.failed.map((item) => item.slug), ["alpha"]);
    assert.deepEqual(calls, []);
    const ok = await importSkills(
      groups,
      { skills: new Set([join(source, "alpha")]), mode: "copy", scopes: [{ dir: source, scope: { kind: "workspace", workspaceId: "w-1" } }] },
      target,
      new Set(["w-1"]),
    );
    assert.equal(ok.imported, 1);
    assert.deepEqual(calls, [[join(source, "alpha"), { kind: "workspace", workspaceId: "w-1" }]]);
  });
});
