import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diffWebArtifacts,
  scanWebArtifacts,
  webScanRoots,
  type ScanFs,
  type WebFileStamp,
} from "./web-artifacts.ts";
import type { TurnDirectories } from "../shared/agent-ipc.ts";

/** 假目录树：目录 → 条目；stats 给网页文件的指纹。readDir 对不在的目录抛错（同真实 fs）。 */
function fakeFs(dirs: Record<string, { name: string; isDir: boolean }[]>, stats: Record<string, WebFileStamp> = {}): ScanFs {
  return {
    readDir: async (dir) => {
      const entries = dirs[dir] ?? dirs[normPosix(dir)];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
    statFile: async (path) => stats[path] ?? stats[normPosix(path)] ?? null,
  };
}

/** 扫描用 node:path join 拼路径——win 上产出反斜杠，而假树的键是 POSIX 形。查表与断言前先归一到正斜杠，测试才与宿主平台无关。 */
function normPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

const stamp = (mtimeMs: number, size: number): WebFileStamp => ({ mtimeMs, size });

describe("scanWebArtifacts —— 收集", () => {
  it("只收 .html / .htm / .svg（大小写不敏感），其余扩展名不进账", async () => {
    const fs = fakeFs(
      { "/w": [
        { name: "a.html", isDir: false },
        { name: "b.HTM", isDir: false },
        { name: "c.svg", isDir: false },
        { name: "d.xhtml", isDir: false },
        { name: "e.md", isDir: false },
        { name: "html", isDir: false },
      ] },
      {
        "/w/a.html": stamp(1, 10),
        "/w/b.HTM": stamp(2, 20),
        "/w/c.svg": stamp(3, 30),
      },
    );
    const result = await scanWebArtifacts(["/w"], fs);
    deepStrictEqual([...result.stamps.keys()].map(normPosix).sort(), ["/w/a.html", "/w/b.HTM", "/w/c.svg"]);
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
        "/w/src/deep.html": stamp(1, 1),
        "/w/src/vendor/ok.html": stamp(2, 2),
        "/w/node_modules/pkg/hidden.html": stamp(3, 3),
        "/w/dist/d.html": stamp(4, 4),
      },
    );
    const result = await scanWebArtifacts(["/w"], fs);
    deepStrictEqual([...result.stamps.keys()].map(normPosix).sort(), ["/w/src/deep.html", "/w/src/vendor/ok.html"]);
  });

  it("根不在（工作台还没建）→ 空结果，不抛", async () => {
    const result = await scanWebArtifacts(["/nope"], fakeFs({}));
    strictEqual(result.stamps.size, 0);
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
      { "/w/real.html": stamp(1, 1) },
    );
    const result = await scanWebArtifacts(["/w"], fs);
    deepStrictEqual([...result.stamps.keys()].map(normPosix), ["/w/real.html"]);
  });

  it("重复根只扫一遍", async () => {
    let reads = 0;
    const fs: ScanFs = {
      readDir: async (dir) => {
        reads += 1;
        if (dir !== "/w") throw new Error("ENOENT");
        return [{ name: "a.html", isDir: false }];
      },
      statFile: async () => stamp(1, 1),
    };
    const result = await scanWebArtifacts(["/w", "/w"], fs);
    strictEqual(reads, 1);
    strictEqual(result.stamps.size, 1);
  });
});

describe("scanWebArtifacts —— 上限", () => {
  it("深度上限：更深的目录不下探", async () => {
    const fs = fakeFs(
      {
        "/w": [{ name: "a", isDir: true }],
        "/w/a": [{ name: "b", isDir: true }],
        "/w/a/b": [{ name: "too-deep.html", isDir: false }],
      },
      { "/w/a/b/too-deep.html": stamp(1, 1) },
    );
    const result = await scanWebArtifacts(["/w"], fs, { maxDepth: 1 });
    strictEqual(result.stamps.size, 0);
    strictEqual(result.truncated, false); // 深度是剪枝，不是截断
  });

  it("条目上限：撞到就地截断（truncated=true），部分结果保留", async () => {
    const fs = fakeFs(
      {
        "/w": [
          { name: "a.html", isDir: false },
          { name: "b.html", isDir: false },
          { name: "c.html", isDir: false },
        ],
      },
      {
        "/w/a.html": stamp(1, 1),
        "/w/b.html": stamp(2, 2),
        "/w/c.html": stamp(3, 3),
      },
    );
    const result = await scanWebArtifacts(["/w"], fs, { maxEntries: 2 });
    strictEqual(result.truncated, true);
    deepStrictEqual([...result.stamps.keys()].map(normPosix), ["/w/a.html", "/w/b.html"]);
  });
});

describe("diffWebArtifacts —— 两遍快照对账", () => {
  const s = (mtimeMs: number, size = 1): WebFileStamp => ({ mtimeMs, size });
  const m = (entries: Record<string, WebFileStamp>) => new Map(Object.entries(entries));

  it("新出现的、mtime 变的、size 变的都算；没变的与被删的不算", () => {
    const before = m({ "/w/a.html": s(1), "/w/b.html": s(2), "/w/c.html": s(3, 9), "/w/gone.html": s(4) });
    const after = m({
      "/w/a.html": s(1), // 没变
      "/w/b.html": s(5), // mtime 变了
      "/w/c.html": s(3, 10), // size 变了
      "/w/new.html": s(6), // 新出现
    });
    deepStrictEqual(diffWebArtifacts(before, after), ["/w/b.html", "/w/c.html", "/w/new.html"]);
  });

  it("结果按路径排序（卡片显示稳定）", () => {
    const before = m({});
    const after = m({ "/w/z.html": s(1), "/w/a.html": s(2) });
    deepStrictEqual(diffWebArtifacts(before, after), ["/w/a.html", "/w/z.html"]);
  });
});

describe("webScanRoots —— 扫描根与开轮目录清单同源", () => {
  it("cwd + attached + 会话工作台，去重", () => {
    const directories: TurnDirectories = {
      attached: ["/extra", "/w"], // 与 cwd 重复的那条要被去掉
      workbench: "/userData/workbenches/s1",
    };
    deepStrictEqual(webScanRoots("/w", directories), ["/w", "/extra", "/userData/workbenches/s1"]);
  });

  it("清单缺席 / 工作台空串：退回 cwd 一个", () => {
    deepStrictEqual(webScanRoots("/w", undefined), ["/w"]);
    deepStrictEqual(webScanRoots("/w", { attached: [], workbench: "" }), ["/w"]);
  });
});
