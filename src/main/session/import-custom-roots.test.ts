/**
 * import-custom-roots 的测试：CustomRootsStore 的持久化往返与三关校验（在 / 是目录 /
 * validate / 不重复），mergeCustomRoots 的顺序与去重，expandHome 的 ~ 展开。
 * 全部在临时目录搭数据目录（proma 用 agent-sessions.json 当会话索引）。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CustomRootsStore,
  dirsOf,
  expandHome,
  mergeCustomRoots,
  normalizeInputDir,
} from "./import-custom-roots.ts";
import { DATA_ROOT_SPECS } from "./import-locate.ts";
import { IMPORT_CUSTOM_ROOT_INVALID_CODE } from "../../shared/import.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "import-custom-roots-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 造一个过 proma validate 的数据根 */
async function makePromaRoot(name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "agent-sessions.json"), "{}");
  return root;
}

/** 断言抛的是稳定错误码 + 指定原因 */
async function assertInvalid(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, IMPORT_CUSTOM_ROOT_INVALID_CODE + reason);
    return true;
  });
}

describe("expandHome", () => {
  test("单独的 ~ 与 ~/ 前缀展开到家目录，其余（含 ~foo 这种写法）原样", () => {
    assert.equal(expandHome("~", "/home/u"), "/home/u");
    assert.equal(expandHome("~/.proma", "/home/u"), join("/home/u", ".proma"));
    assert.equal(expandHome("~foo/bar", "/home/u"), "~foo/bar");
    assert.equal(expandHome("/abs/path", "/home/u"), "/abs/path");
  });

  test("Windows 的 ~\\ 写法同 ~/", () => {
    assert.equal(expandHome("~\\.proma-old", "/home/u"), join("/home/u", ".proma-old"));
  });
});

describe("normalizeInputDir", () => {
  test("去首尾空白与两头成对的引号（资源管理器「复制文件地址」带双引号），再展开 ~", () => {
    assert.equal(normalizeInputDir('  "C:\\Users\\u\\.proma-old"  ', "/home/u"), "C:\\Users\\u\\.proma-old");
    assert.equal(normalizeInputDir("'/data/proma backup'", "/home/u"), "/data/proma backup");
    assert.equal(normalizeInputDir('"~/.proma-old"', "/home/u"), join("/home/u", ".proma-old"));
  });

  test("不成对或只有一个引号时原样（不猜）", () => {
    assert.equal(normalizeInputDir('"/a/b', "/home/u"), '"/a/b');
    assert.equal(normalizeInputDir(`"/a/b'`, "/home/u"), `"/a/b'`);
    assert.equal(normalizeInputDir('"', "/home/u"), '"');
  });
});

describe("CustomRootsStore", () => {
  test("添加三关全过才落盘；重启（新实例）读得回（持久化往返）", async () => {
    const store = new CustomRootsStore(dir);
    const root = await makePromaRoot("proma-backup");
    const after = await store.add("proma", root + "/");
    assert.deepEqual(after, [{ source: "proma", dir: root }]);
    // 尾斜杠被 resolve 归一；新实例 = 重启后仍在
    assert.deepEqual(await new CustomRootsStore(dir).read(), [{ source: "proma", dir: root }]);
  });

  test("目录不存在 → not-found；目录在但没有该来源的聊天记录 → no-data", async () => {
    const store = new CustomRootsStore(dir);
    await assertInvalid(store.add("proma", join(dir, "no-such-dir")), "not-found");
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    await assertInvalid(store.add("proma", empty), "no-data");
    assert.deepEqual(await store.read(), []);
  });

  test("同一来源重复添加同一个目录（写法不同也算）→ duplicate，清单不加长", async () => {
    const store = new CustomRootsStore(dir);
    const root = await makePromaRoot("proma-backup");
    await store.add("proma", root);
    await assertInvalid(store.add("proma", root + "/"), "duplicate");
    assert.equal((await store.read()).length, 1);
  });

  test("不同来源可以各有一条同名目录；dirsOf 按来源过滤、保持添加顺序", async () => {
    const store = new CustomRootsStore(dir);
    const first = await makePromaRoot("one");
    const second = await makePromaRoot("two");
    const zcode = join(dir, "zcode-root");
    await mkdir(join(zcode, "cli", "db"), { recursive: true });
    await writeFile(join(zcode, "cli", "db", "db.sqlite"), "");
    await store.add("proma", first);
    await store.add("zcode", zcode);
    await store.add("proma", second);
    const roots = await store.read();
    assert.deepEqual(dirsOf(roots, "proma"), [first, second]);
    assert.deepEqual(dirsOf(roots, "zcode"), [zcode]);
    assert.deepEqual(dirsOf(roots, "codex"), []);
  });

  test("移除后不再在清单里（持久化）；移除不存在的条目是幂等空操作", async () => {
    const store = new CustomRootsStore(dir);
    const root = await makePromaRoot("proma-backup");
    await store.add("proma", root);
    const after = await store.remove("proma", root);
    assert.deepEqual(after, []);
    assert.deepEqual(await new CustomRootsStore(dir).read(), []);
    // 不在清单里的移除不报错、不改清单
    const other = await makePromaRoot("other");
    await store.add("proma", other);
    assert.deepEqual(await store.remove("proma", root), [{ source: "proma", dir: other }]);
  });

  test("读容错：文件不是 JSON / 形状不对 / 混进不认识的条目都滤掉，退回可用部分", async () => {
    await writeFile(
      join(dir, "import-custom-roots.json"),
      "not json at all",
      "utf8",
    );
    assert.deepEqual(await new CustomRootsStore(dir).read(), []);
    const keep = await makePromaRoot("keep");
    await writeFile(
      join(dir, "import-custom-roots.json"),
      JSON.stringify({
        roots: [
          { source: "proma", dir: keep },
          { source: "agent-skills", dir: "/agents" }, // 不支持自定义路径的来源
          { source: "bogus", dir: "/bogus" }, // 不认识的来源
          { dir: "/no-source" }, // 缺 source
          { source: "proma" }, // 缺 dir
          "junk",
        ],
      }),
      "utf8",
    );
    assert.deepEqual(await new CustomRootsStore(dir).read(), [{ source: "proma", dir: keep }]);
  });
});

describe("mergeCustomRoots", () => {
  test("自动定位在前、自定义垫后（按添加顺序），去重按 resolve 后的路径", async () => {
    const auto = [join(dir, "auto-a"), join(dir, "auto-b")];
    const custom = [await makePromaRoot("custom-c"), auto[0] + "/", await makePromaRoot("custom-d")];
    assert.deepEqual(await mergeCustomRoots(auto, custom, DATA_ROOT_SPECS.proma), [
      join(dir, "auto-a"),
      join(dir, "auto-b"),
      custom[0],
      custom[2],
    ]);
  });

  test("自定义路径此刻 validate 不过（数据被删了）就不进清单；自动定位那半不再验（本来就已验）", async () => {
    const gone = join(dir, "gone");
    await mkdir(gone, { recursive: true }); // 目录在，但没有会话索引 → validate 不过
    assert.deepEqual(await mergeCustomRoots([join(dir, "auto")], [gone], DATA_ROOT_SPECS.proma), [
      join(dir, "auto"),
    ]);
  });

  test("自定义为空 = 原样；两边都空 = 空", async () => {
    assert.deepEqual(await mergeCustomRoots([join(dir, "auto")], [], DATA_ROOT_SPECS.proma), [join(dir, "auto")]);
    assert.deepEqual(await mergeCustomRoots([], [], DATA_ROOT_SPECS.proma), []);
  });
});
