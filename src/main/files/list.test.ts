/** listDirectory 的账：白名单两道、排序、symlink 不跟、dir 回 realpath 后的路径。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory } from "./list.ts";
import type { FileListRequest, FileRoot } from "../../shared/files.ts";

let dir = "";
let rootDir = "";
let roots: FileRoot[];

const req = (root: string, dirTo: string): FileListRequest => ({
  sessionId: "11111111-2222-3333-4444-555555555555",
  workspaceId: null,
  root,
  dir: dirTo,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-files-list-"));
  rootDir = join(dir, "root");
  await mkdir(rootDir);
  await mkdir(join(rootDir, "beta-dir"));
  await mkdir(join(rootDir, "alpha-dir"));
  await writeFile(join(rootDir, "b.txt"), "hello", "utf8");
  await writeFile(join(rootDir, "A.md"), "12345", "utf8");
  // 链接指向目录：仍标 symlink 不跟——跟的话链接环转不出来。
  // 用 junction 而不是真 symlink：Windows 上建真 symlink 要特权（未开开发者模式的机器一律
  // EPERM），junction 是同一件事的免特权形态（lstat 仍 isSymbolicLink、readlink/realpath 行为
  // 一致）；POSIX 上 type 参数被忽略，照旧是真 symlink——同 agent/skills-layout.test.ts。
  await symlink(join(rootDir, "alpha-dir"), join(rootDir, "z-link"), "junction");
  roots = [{ kind: "attached", label: "root", path: rootDir, exists: true }];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listDirectory", () => {
  test("目录在前、同类按名字（大小写不敏感），dir 回 realpath 后的路径", async () => {
    const result = await listDirectory(roots, req(rootDir, rootDir));
    assert.equal(result.dir, await realpath(rootDir));
    assert.deepEqual(
      result.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["alpha-dir", "directory"],
        ["beta-dir", "directory"],
        ["A.md", "file"], // a < b，大小写不敏感
        ["b.txt", "file"],
        ["z-link", "symlink"], // symlink 与 file 同组按名字排
      ],
    );
  });

  test("file 带 size 与 mtime；目录 / 链接不带 size", async () => {
    const result = await listDirectory(roots, req(rootDir, rootDir));
    const a = result.entries.find((entry) => entry.name === "A.md");
    assert.equal(a?.size, 5);
    assert.equal(typeof a?.modifiedAt, "number");
    assert.equal(result.entries.find((entry) => entry.name === "alpha-dir")?.size, undefined);
    assert.equal(result.entries.find((entry) => entry.name === "z-link")?.size, undefined);
  });

  test("symlink 指向目录也标 symlink，不跟进去", async () => {
    const result = await listDirectory(roots, req(rootDir, rootDir));
    assert.equal(result.entries.find((entry) => entry.name === "z-link")?.kind, "symlink");
  });

  test("子目录照列（dir 在 root 之内）", async () => {
    await writeFile(join(rootDir, "alpha-dir", "inner.txt"), "x", "utf8");
    const result = await listDirectory(roots, req(rootDir, join(rootDir, "alpha-dir")));
    assert.deepEqual(result.entries.map((entry) => entry.name), ["inner.txt"]);
  });

  test("dir 越出 root（兄弟目录）抛错", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await assert.rejects(() => listDirectory(roots, req(rootDir, outside)), /不在允许的根之内/);
  });

  test("root 里的链接指向 root 外：realpath 解析后落在根外，拒绝（symlink 跳板）", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(rootDir, "escape"), "junction");
    await assert.rejects(
      () => listDirectory(roots, req(rootDir, join(rootDir, "escape"))),
      /不在允许的根之内/,
    );
  });

  test("root 不在清单里抛错——renderer 传什么都不信", async () => {
    await assert.rejects(
      () => listDirectory(roots, req(join(dir, "pretend-root"), rootDir)),
      /不是这条会话允许的根目录之一/,
    );
  });

  test("根不存在（exists=false 的根硬列）抛中文错", async () => {
    const missing = join(dir, "not-there");
    await assert.rejects(
      () => listDirectory([{ kind: "attached", label: "m", path: missing, exists: false }], req(missing, missing)),
      /根目录不存在/,
    );
  });

  test("dir 不存在抛中文错", async () => {
    await assert.rejects(
      () => listDirectory(roots, req(rootDir, join(rootDir, "nope"))),
      /目录不存在/,
    );
  });
});
