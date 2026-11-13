/**
 * 文献库扫描的回归网 —— 正经测「上限会不会静默吃掉 .bib」这一条（评审 F1）。
 *
 * 夹具在临时目录里现造：论文仓里 `figures/` 放几千张图是常态，早期实现把「看过的
 * 条目数」全局卡在 2000，排队在后面的 `refs/ok.bib` 就整份读不到、界面毫无提示。
 * 这里钉三件事：非 bib 文件再多也不影响 .bib、体积超限要说出来、超量要说出来。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCiteLibrary, scanBibFiles } from "./library.ts";

const ENTRY = (key: string, title: string) =>
  `@article{${key},\n  title = {${title}},\n  author = {Doe, Jane},\n  year = {2020},\n}\n`;

function withProject(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "orbita-cite-"));
  build(dir);
  return dir;
}

describe("collectCiteLibrary —— 上限不许静默丢 .bib", () => {
  test("一个目录里 3000 个非 bib 文件，排在后面的 refs/ok.bib 照读", () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "figures"), { recursive: true });
      for (let i = 0; i < 3000; i += 1) {
        writeFileSync(join(root, "figures", `fig${String(i).padStart(4, "0")}.png`), "x");
      }
      mkdirSync(join(root, "refs"), { recursive: true });
      writeFileSync(join(root, "refs", "ok.bib"), ENTRY("stillfound", "Still Found"));
    });
    try {
      const library = collectCiteLibrary(dir);
      assert.deepEqual(library.entries.map((entry) => entry.key), ["stillfound"]);
      assert.deepEqual(library.files.map((file) => file.path), ["refs/ok.bib"]);
      assert.deepEqual(library.skipped, []);
      assert.equal(library.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("超过 8 MB 的 .bib：整份没读，进 skipped，并给出原因", () => {
    const dir = withProject((root) => {
      // 8 MB 上限：造一份刚过线的文件（内容不必是合法 BibTeX，反正不会解析）
      writeFileSync(join(root, "big.bib"), "x".repeat(8 * 1024 * 1024 + 1));
      writeFileSync(join(root, "small.bib"), ENTRY("small", "Small"));
    });
    try {
      const library = collectCiteLibrary(dir);
      assert.deepEqual(library.entries.map((entry) => entry.key), ["small"]);
      assert.deepEqual(library.skipped, [{ path: "big.bib", reason: "too-large" }]);
      // 没读的那份不出现在 files 里：它不是「读了但坏了」
      assert.deepEqual(library.files.map((file) => file.path), ["small.bib"]);
      assert.equal(library.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("超过 200 份 .bib：多出来的进 skipped（too-many-files），前 200 份照常读", () => {
    const dir = withProject((root) => {
      for (let i = 0; i < 205; i += 1) {
        writeFileSync(join(root, `f${String(i).padStart(3, "0")}.bib`), ENTRY(`k${String(i).padStart(3, "0")}`, "T"));
      }
    });
    try {
      const library = collectCiteLibrary(dir);
      assert.equal(library.files.length, 200);
      assert.equal(library.entries.length, 200);
      assert.equal(library.skipped.length, 5);
      assert.ok(library.skipped.every((item) => item.reason === "too-many-files"));
      assert.equal(library.skipped[0]?.path, "f200.bib");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("「没读」名单不无限攒：多到 200 份就停，用 truncated 说「还有」", () => {
    const dir = withProject((root) => {
      // 200 份读 + 200 份进名单 + 剩下的连名单都不攒
      for (let i = 0; i < 401; i += 1) {
        writeFileSync(join(root, `f${String(i).padStart(3, "0")}.bib`), ENTRY(`k${String(i).padStart(3, "0")}`, "T"));
      }
    });
    try {
      const library = collectCiteLibrary(dir);
      assert.equal(library.files.length, 200);
      assert.equal(library.skipped.length, 200);
      assert.equal(library.truncated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("坏条目计数与坏文件分开记；没有 .bib 时是空库", () => {
    const dir = withProject((root) => {
      writeFileSync(join(root, "broken.bib"), "@article{, title = {No Key}}\n@book{good, title = {Good}}\n");
      mkdirSync(join(root, "build"), { recursive: true });
      // build/ 里的 .bib 是编译产物，不该被算进文献库
      writeFileSync(join(root, "build", "copy.bib"), ENTRY("frombuild", "From Build"));
    });
    try {
      const library = collectCiteLibrary(dir);
      assert.deepEqual(library.entries.map((entry) => entry.key), ["good"]);
      assert.deepEqual(library.files, [{ path: "broken.bib", bad: 1, error: null }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("空的 / 不存在的目录：空库，不抛", () => {
    const dir = withProject(() => {});
    try {
      assert.deepEqual(collectCiteLibrary(dir), { entries: [], files: [], skipped: [], truncated: false });
      assert.deepEqual(collectCiteLibrary(join(dir, "nope")), { entries: [], files: [], skipped: [], truncated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanBibFiles —— 文件顺序与跳过原因", () => {
  test("按相对路径排序（决定「同 key 先出现者」），隐藏目录与 build/ 不进去", () => {
    const dir = withProject((root) => {
      mkdirSync(join(root, "b"), { recursive: true });
      writeFileSync(join(root, "b", "z.bib"), ENTRY("z", "Z"));
      writeFileSync(join(root, "a.bib"), ENTRY("a", "A"));
      mkdirSync(join(root, ".hidden"), { recursive: true });
      writeFileSync(join(root, ".hidden", "h.bib"), ENTRY("h", "H"));
      mkdirSync(join(root, "build"), { recursive: true });
      writeFileSync(join(root, "build", "b.bib"), ENTRY("b", "B"));
    });
    try {
      const scan = scanBibFiles(dir);
      assert.deepEqual(
        scan.files.map((path) => path.replace(dir, "").replace(/\\/g, "/").replace(/^\//, "")),
        ["a.bib", "b/z.bib"],
      );
      assert.equal(scan.truncated, false);
      assert.deepEqual(scan.skipped, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
