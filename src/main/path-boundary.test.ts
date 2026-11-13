import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isInside, pathUnderRoots, realpathInside } from "./path-boundary.ts";

describe("isInside（纯词法）", () => {
  const root = resolve("/ws/root");
  test("根本身与子孙算在内", () => {
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, join(root, "a", "b.txt")), true);
  });
  test("上跳、兄弟、同前缀的兄弟不算", () => {
    assert.equal(isInside(root, resolve("/ws")), false);
    assert.equal(isInside(root, join(root, "..", "other")), false);
    // 前缀比较会误判的那种：/ws/root-2 不在 /ws/root 里
    assert.equal(isInside(root, resolve("/ws/root-2/x")), false);
  });
  test("名字以 .. 开头的子目录（..cache）在根内——不能只看 relative 是不是以 .. 开头", () => {
    assert.equal(isInside(root, join(root, "..cache", "x")), true);
  });
});

describe("realpathInside（realpath 后再判）", () => {
  let base = "";
  let root = "";
  let outside = "";

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "orbita-path-boundary-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "sub", "a.txt"), "a", "utf8");
    await writeFile(join(outside, "secret.txt"), "s", "utf8");
    // junction：Windows 免特权（#365 的夹具形态），POSIX 上 type 被忽略
    await symlink(outside, join(root, "linkout"), "junction");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("根内的文件 → 真实路径", async () => {
    assert.equal(await realpathInside(join(root, "sub", "a.txt"), [root]), await realpath(join(root, "sub", "a.txt")));
  });

  test("穿过根内的链接到根外 → null", async () => {
    assert.equal(await realpathInside(join(root, "linkout", "secret.txt"), [root]), null);
  });

  test("不存在的路径 → null；不存在的根跳过，不连累别的根", async () => {
    assert.equal(await realpathInside(join(root, "nope.txt"), [root]), null);
    assert.equal(
      await realpathInside(join(outside, "secret.txt"), [join(base, "not-created"), outside]),
      await realpath(join(outside, "secret.txt")),
    );
  });
});

describe("pathUnderRoots（真实路径 → 用户挂的根下的路径）", () => {
  test("根是 symlink：真实路径换回根下的原样路径；不在任何根里 / 根读不出来原样返回", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "orbita-under-roots-")));
    try {
      await mkdir(join(base, "real", "sub"), { recursive: true });
      await writeFile(join(base, "real", "sub", "a.md"), "a", "utf8");
      await symlink(join(base, "real"), join(base, "Home"));
      const real = join(base, "real", "sub", "a.md");
      assert.equal(await pathUnderRoots(real, [join(base, "Home")]), join(base, "Home", "sub", "a.md"));
      assert.equal(await pathUnderRoots(real, [join(base, "nope")]), real);
      assert.equal(await pathUnderRoots(join(base, "elsewhere.md"), [join(base, "Home")]), join(base, "elsewhere.md"));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
