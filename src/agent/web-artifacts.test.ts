import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  foldWebArtifacts,
  scanWebArtifacts,
  webScanRoots,
  SCAN_ATTACHED_MAX_ENTRIES,
  SCAN_MAX_ENTRIES,
  WEB_ARTIFACT_BATCH_LIMIT,
  type ScanFs,
  type ScanRoot,
} from "./web-artifacts.ts";
import type { TurnDirectories } from "../shared/agent-ipc.ts";

/** 假目录树：目录 → 条目；mtimes 给网页文件的 mtime（毫秒）。readDir 对不在的目录抛错（同真实 fs）。 */
function fakeFs(dirs: Record<string, { name: string; isDir: boolean }[]>, mtimes: Record<string, number> = {}): ScanFs {
  return {
    readDir: async (dir) => {
      const entries = dirs[dir] ?? dirs[normPosix(dir)];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
    statFile: async (path) => mtimes[path] ?? mtimes[normPosix(path)] ?? null,
  };
}

/** 扫描用 node:path join 拼路径——win 上产出反斜杠，而假树的键是 POSIX 形。查表与断言前先归一到正斜杠，测试才与宿主平台无关。 */
function normPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** 单根便捷入口：预算给足，测「收集什么」。 */
function oneRoot(root: string, maxEntries = 1000): ScanRoot[] {
  return [{ root, maxEntries }];
}

describe("scanWebArtifacts —— 收集（按 mtime 判本轮新出现）", () => {
  it("只收 .html / .htm / .svg（大小写不敏感）且 mtime ≥ 起判线的；旧文件与其它扩展名不进账", async () => {
    const fs = fakeFs(
      { "/w": [
        { name: "fresh.html", isDir: false },
        { name: "edge.HTM", isDir: false }, // 恰好压在起判线上（>=）
        { name: "old.svg", isDir: false },
        { name: "old.html", isDir: false },
        { name: "fresh.md", isDir: false },
        { name: "d.xhtml", isDir: false },
      ] },
      {
        "/w/fresh.html": 2000,
        "/w/edge.HTM": 1000,
        "/w/old.svg": 999,
        "/w/old.html": 1,
      },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 1000, fs);
    deepStrictEqual(result.paths.map(normPosix), ["/w/edge.HTM", "/w/fresh.html"]);
    strictEqual(result.truncated, false);
  });

  it("递归子目录；node_modules / .git / dist / out / build / .next 不进", async () => {
    const fs = fakeFs(
      {
        "/w": [
          { name: "src", isDir: true },
          { name: "node_modules", isDir: true },
          { name: ".git", isDir: true },
          { name: "dist", isDir: true },
          { name: "out", isDir: true },
          { name: "build", isDir: true },
          { name: ".next", isDir: true },
        ],
        "/w/src": [
          { name: "deep.html", isDir: false },
          { name: "vendor", isDir: true },
        ],
        "/w/src/vendor": [{ name: "ok.html", isDir: false }],
        // 以下整棵都不该被碰到；entries 故意留空，碰到也不会产出网页文件
        "/w/node_modules": [{ name: "pkg", isDir: true }],
        "/w/node_modules/pkg": [{ name: "hidden.html", isDir: false }],
        "/w/.git": [],
        "/w/dist": [{ name: "d.html", isDir: false }],
        "/w/out": [],
        "/w/build": [],
        "/w/.next": [],
      },
      {
        "/w/src/deep.html": 100,
        "/w/src/vendor/ok.html": 100,
        "/w/node_modules/pkg/hidden.html": 100,
        "/w/dist/d.html": 100,
      },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 0, fs);
    deepStrictEqual(result.paths.map(normPosix).sort(), ["/w/src/deep.html", "/w/src/vendor/ok.html"]);
  });

  it("根不在（工作台还没建）→ 空结果，不抛", async () => {
    const result = await scanWebArtifacts([{ root: "/nope", maxEntries: 10 }], 0, fakeFs({}));
    strictEqual(result.paths.length, 0);
    strictEqual(result.truncated, false);
  });

  it("符号链接目录不跟（isDir=false 的条目只当文件看）", async () => {
    const fs = fakeFs(
      {
        "/w": [
          { name: "link", isDir: false }, // symlink-to-dir：readdir(withFileTypes) 下不是 directory
          { name: "real.html", isDir: false },
        ],
      },
      { "/w/real.html": 1 },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 0, fs);
    deepStrictEqual(result.paths.map(normPosix), ["/w/real.html"]);
  });

  it("重复根只扫一遍（按首次出现的预算）", async () => {
    let reads = 0;
    const fs: ScanFs = {
      readDir: async (dir) => {
        reads += 1;
        if (dir !== "/w") throw new Error("ENOENT");
        return [{ name: "a.html", isDir: false }];
      },
      statFile: async () => 1,
    };
    const result = await scanWebArtifacts(
      [
        { root: "/w", maxEntries: 10 },
        { root: "/w", maxEntries: 10 },
      ],
      0,
      fs,
    );
    strictEqual(reads, 1);
    strictEqual(result.paths.length, 1);
  });

  it("结果按路径排序（卡片显示稳定）", async () => {
    const fs = fakeFs(
      { "/w": [
        { name: "z.html", isDir: false },
        { name: "a.html", isDir: false },
      ] },
      { "/w/z.html": 1, "/w/a.html": 2 },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 0, fs);
    deepStrictEqual(result.paths.map(normPosix), ["/w/a.html", "/w/z.html"]);
  });
});

describe("scanWebArtifacts —— 上限（按根分账）", () => {
  it("深度上限：更深的目录不下探（是剪枝，不是截断）", async () => {
    const fs = fakeFs(
      {
        "/w": [{ name: "a", isDir: true }],
        "/w/a": [{ name: "b", isDir: true }],
        "/w/a/b": [{ name: "too-deep.html", isDir: false }],
      },
      { "/w/a/b/too-deep.html": 1 },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 0, fs, { maxDepth: 1 });
    strictEqual(result.paths.length, 0);
    strictEqual(result.truncated, false);
  });

  it("条目上限：撞到就地截断；旧文件即使被扫到也不报，新文件截断线之前的保留", async () => {
    const fs = fakeFs(
      {
        "/w": [
          { name: "old.html", isDir: false }, // 截断线之前被扫到，但 mtime 早于开轮 → 不报
          { name: "a.html", isDir: false },
          { name: "b.html", isDir: false },
          { name: "c.html", isDir: false }, // 截断线之后，没被扫到
        ],
      },
      {
        "/w/old.html": 1,
        "/w/a.html": 100,
        "/w/b.html": 100,
        "/w/c.html": 100,
      },
    );
    const result = await scanWebArtifacts([{ root: "/w", maxEntries: 3 }], 50, fs);
    strictEqual(result.truncated, true);
    deepStrictEqual(result.paths.map(normPosix), ["/w/a.html", "/w/b.html"]);
  });

  it("一个附加目录撞自己的预算截断，不吃掉 cwd / 工作台根的预算", async () => {
    // 附加目录里塞满目录条目，把小预算耗尽；预算内的新文件照收，预算后的收不到
    const filler = Array.from({ length: 20 }, (_, i) => ({ name: `d${i}`, isDir: true }));
    const fs = fakeFs(
      {
        "/repo": [{ name: "seen.html", isDir: false }, ...filler],
        "/repo/d0": [{ name: "missed.html", isDir: false }], // 在截断线之后，没被扫到
        "/cwd": [{ name: "made.html", isDir: false }],
        "/bench": [{ name: "proto.html", isDir: false }],
      },
      {
        "/repo/seen.html": 100,
        "/repo/d0/missed.html": 100,
        "/cwd/made.html": 100,
        "/bench/proto.html": 100,
      },
    );
    const result = await scanWebArtifacts(
      [
        { root: "/cwd", maxEntries: 100 },
        { root: "/bench", maxEntries: 100 },
        { root: "/repo", maxEntries: 10 }, // 附加目录的小预算：第一个文件 + 20 个子目录，撞线
      ],
      50,
      fs,
    );
    strictEqual(result.truncated, true); // 只有 /repo 截断
    deepStrictEqual(result.paths.map(normPosix).sort(), ["/bench/proto.html", "/cwd/made.html", "/repo/seen.html"]);
  });
});

describe("foldWebArtifacts —— 批量折叠", () => {
  it("超过上限：一个不列，只报计数", () => {
    const paths = Array.from({ length: WEB_ARTIFACT_BATCH_LIMIT + 1 }, (_, i) => `/w/${i}.html`);
    deepStrictEqual(foldWebArtifacts(paths), { webArtifacts: [], webArtifactsBatch: paths.length });
  });

  it("恰好等于上限：仍逐个列出（不给计数）", () => {
    const paths = Array.from({ length: WEB_ARTIFACT_BATCH_LIMIT }, (_, i) => `/w/${i}.html`);
    deepStrictEqual(foldWebArtifacts(paths), { webArtifacts: paths });
  });

  it("空清单：空列表、无计数（没产出的轮不产卡）", () => {
    deepStrictEqual(foldWebArtifacts([]), { webArtifacts: [] });
  });
});

describe("webScanRoots —— 根与预算同开轮目录清单分账", () => {
  it("cwd 与工作台吃全预算，附加目录各吃小预算", () => {
    const directories: TurnDirectories = {
      attached: ["/extra", "/repo"],
      workbench: "/userData/workbenches/s1",
    };
    deepStrictEqual(webScanRoots("/w", directories), [
      { root: "/w", maxEntries: SCAN_MAX_ENTRIES },
      { root: "/userData/workbenches/s1", maxEntries: SCAN_MAX_ENTRIES },
      { root: "/extra", maxEntries: SCAN_ATTACHED_MAX_ENTRIES },
      { root: "/repo", maxEntries: SCAN_ATTACHED_MAX_ENTRIES },
    ]);
  });

  it("与 cwd / 工作台重复的附加目录不再单开一份小预算扫描", () => {
    const directories: TurnDirectories = {
      attached: ["/w", "/userData/workbenches/s1", "/extra"],
      workbench: "/userData/workbenches/s1",
    };
    deepStrictEqual(webScanRoots("/w", directories), [
      { root: "/w", maxEntries: SCAN_MAX_ENTRIES },
      { root: "/userData/workbenches/s1", maxEntries: SCAN_MAX_ENTRIES },
      { root: "/extra", maxEntries: SCAN_ATTACHED_MAX_ENTRIES },
    ]);
  });

  it("清单缺席 / 工作台空串：退回 cwd 一个（全预算）", () => {
    deepStrictEqual(webScanRoots("/w", undefined), [{ root: "/w", maxEntries: SCAN_MAX_ENTRIES }]);
    deepStrictEqual(webScanRoots("/w", { attached: [], workbench: "" }), [
      { root: "/w", maxEntries: SCAN_MAX_ENTRIES },
    ]);
  });
});
