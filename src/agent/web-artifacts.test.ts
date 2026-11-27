import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MEDIA_ARTIFACT_BATCH_LIMIT,
  capMediaArtifacts,
  dropSavedPages,
  foldWebArtifacts,
  isDownloadCommand,
  looksSavedFromWeb,
  isScriptTool,
  makeWebAccept,
  noteSessionWrite,
  resetOtherWrites,
  scanWebArtifacts,
  ToolWindows,
  webScanRoots,
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

describe("webScanRoots —— 只扫 cwd 与工作台，不扫附加目录", () => {
  it("附加目录不进扫描根（跨会话共享，别的会话的批量操作会被误认成本轮产物）", () => {
    const directories: TurnDirectories = {
      attached: ["/extra", "/repo"],
      workbench: "/userData/workbenches/s1",
    };
    deepStrictEqual(webScanRoots("/w", directories), [
      { root: "/w", maxEntries: SCAN_MAX_ENTRIES },
      { root: "/userData/workbenches/s1", maxEntries: SCAN_MAX_ENTRIES },
    ]);
  });

  it("工作台与 cwd 同路径时只扫一份", () => {
    deepStrictEqual(webScanRoots("/w", { attached: [], workbench: "/w" }), [{ root: "/w", maxEntries: SCAN_MAX_ENTRIES }]);
  });

  it("清单缺席 / 工作台空串：退回 cwd 一个", () => {
    deepStrictEqual(webScanRoots("/w", undefined), [{ root: "/w", maxEntries: SCAN_MAX_ENTRIES }]);
    deepStrictEqual(webScanRoots("/w", { attached: ["/x"], workbench: "" }), [
      { root: "/w", maxEntries: SCAN_MAX_ENTRIES },
    ]);
  });
});

describe("旁路网页只算这一条会话这一轮自己产生的（2026-11-22 另一条会话 edit 的网页被算进来）", () => {
  const T0 = 1_000_000; // 开轮时刻
  const fsOf = (mtimes: Record<string, number>) =>
    fakeFs(
      { "/w": Object.keys(mtimes).map((path) => ({ name: path.slice(3), isDir: false })) },
      mtimes,
    );

  it("isScriptTool：只有 shell / 终端执行 / 外接工具可能在文件账外生成网页", () => {
    for (const name of ["bash", "powershell", "terminal_execute", "mcp__qgis__execute_code"]) strictEqual(isScriptTool(name), true, name);
    for (const name of ["write", "edit", "read", "grep", "show_image", "slides_export", "terminal_read"]) strictEqual(isScriptTool(name), false, name);
  });

  it("下载命令（curl / wget / git clone）不开窗口：搬来的网页不是本轮产物——会话 2defbe 调研时 curl 的五个官网页面", () => {
    for (const command of [
      'curl -sS -L -m 25 -o liveblocks-agentic.html https://liveblocks.io/docs',
      'for u in a b; do f=page_$(echo $u | md5).html; code=$(curl -sS -o $f "$u"); done',
      "wget -O x.html https://example.com",
      "git clone https://github.com/a/b research/b",
      "Invoke-WebRequest https://example.com -OutFile x.html",
    ]) strictEqual(isDownloadCommand({ command }), true, command);
    for (const args of [{ command: "python3 make_chart.py > chart.html" }, { command: "node build.mjs" }, {}, null, undefined, "curl"]) {
      strictEqual(isDownloadCommand(args), false, JSON.stringify(args));
    }
    const windows = new ToolWindows();
    windows.begin("dl", "bash", T0 + 1, { command: "curl -o a.html https://x.y" });
    windows.finish("dl", T0 + 2);
    windows.begin("gen", "bash", T0 + 10, { command: "python3 gen.py" });
    windows.finish("gen", T0 + 20);
    deepStrictEqual(windows.snapshot(T0 + 99), [{ start: T0 + 10, end: T0 + 20 }]);
  });

  it("从网上存下来的页面（canonical / og:url 指向 http、saved from url）扣掉，自己生成的网页和 svg 照留", async () => {
    strictEqual(looksSavedFromWeb('<head><link rel="canonical" href="https://liveblocks.io/docs/use-cases/agentic-users"/></head>'), true);
    strictEqual(looksSavedFromWeb('<link href="https://openai.com/index/x/" rel="canonical">'), true);
    strictEqual(looksSavedFromWeb('<meta property="og:url" content="https://www.kimi.ai/blog/"/>'), true);
    strictEqual(looksSavedFromWeb("<!-- saved from url=(0014)about:internet -->"), true);
    strictEqual(looksSavedFromWeb('<html><head><title>周报图表</title><link rel="stylesheet" href="style.css"></head>'), false);
    strictEqual(looksSavedFromWeb('<p>canonical 形式：见 https://example.com</p>'), false);
    const heads: Record<string, string> = {
      "/w/src/page_5c842764.html": '<!DOCTYPE html><html><head><link rel="canonical" href="https://claude.com/x"/>',
      "/w/chart.html": "<!DOCTYPE html><html><head><title>chart</title>",
      "/w/icon.svg": '<svg><a href="https://x.y" rel="canonical"/></svg>',
    };
    const kept = await dropSavedPages(Object.keys(heads), async (path) => heads[path] ?? "");
    deepStrictEqual(kept, ["/w/chart.html", "/w/icon.svg"]);
  });

  it("ToolWindows：只记脚本类工具；没落定的（被中断）按轮尾时刻封口", () => {
    const windows = new ToolWindows();
    windows.begin("a", "write", T0 + 1);
    windows.finish("a", T0 + 2);
    windows.begin("b", "bash", T0 + 10);
    windows.finish("b", T0 + 20);
    windows.begin("c", "bash", T0 + 30); // 没有 finish
    deepStrictEqual(windows.snapshot(T0 + 99), [
      { start: T0 + 10, end: T0 + 20 },
      { start: T0 + 30, end: T0 + 99 },
    ]);
  });

  it("脚本生成的网页（mtime 落在本轮 bash 窗口里）照常收进来——样张「脚本生成两张图表」那一类", async () => {
    resetOtherWrites();
    const windows = new ToolWindows();
    windows.begin("b", "bash", T0 + 5_000);
    windows.finish("b", T0 + 9_000);
    const accept = makeWebAccept("s1", windows.snapshot(T0 + 20_000), T0);
    const result = await scanWebArtifacts(oneRoot("/w"), T0 - 2000, fsOf({ "/w/chart.html": T0 + 8_000, "/w/chart.svg": T0 + 8_500 }), { accept });
    deepStrictEqual(result.paths.map(normPosix), ["/w/chart.html", "/w/chart.svg"]);
  });

  it("窗口之外的空档（模型想事情的时候别的会话写的）不算：mtime 在两次 bash 之间", async () => {
    resetOtherWrites();
    const windows = new ToolWindows();
    windows.begin("b1", "bash", T0 + 1_000);
    windows.finish("b1", T0 + 2_000);
    windows.begin("b2", "bash", T0 + 30_000);
    windows.finish("b2", T0 + 31_000);
    const accept = makeWebAccept("s1", windows.snapshot(T0 + 40_000), T0);
    const result = await scanWebArtifacts(oneRoot("/w"), T0 - 2000, fsOf({ "/w/gap.html": T0 + 15_000 }), { accept });
    deepStrictEqual(result.paths, []);
  });

  it("本轮没跑过脚本类工具：没有窗口，什么 mtime 都不收", async () => {
    resetOtherWrites();
    const accept = makeWebAccept("s1", new ToolWindows().snapshot(T0 + 40_000), T0);
    const result = await scanWebArtifacts(oneRoot("/w"), T0 - 2000, fsOf({ "/w/other.html": T0 + 100 }), { accept });
    deepStrictEqual(result.paths, []);
  });

  it("别的会话在本轮期间 write / edit 过的路径扣掉，哪怕 mtime 恰好落在本会话的 bash 窗口里", async () => {
    resetOtherWrites();
    noteSessionWrite("s2", "/w/index.html", T0 + 8_000);
    const windows = new ToolWindows();
    windows.begin("b", "bash", T0 + 7_000);
    windows.finish("b", T0 + 9_000);
    const accept = makeWebAccept("s1", windows.snapshot(T0 + 20_000), T0);
    const result = await scanWebArtifacts(
      oneRoot("/w"),
      T0 - 2000,
      fsOf({ "/w/index.html": T0 + 8_000, "/w/mine.html": T0 + 8_100 }),
      { accept },
    );
    deepStrictEqual(result.paths.map(normPosix), ["/w/mine.html"]);
  });

  it("别人很早以前（本轮开始前）写过的不连坐；本会话自己写的也不算「别人」", async () => {
    resetOtherWrites();
    noteSessionWrite("s2", "/w/old.html", T0 - 600_000);
    noteSessionWrite("s1", "/w/self.html", T0 + 8_000);
    const windows = new ToolWindows();
    windows.begin("b", "bash", T0 + 7_000);
    windows.finish("b", T0 + 9_000);
    const accept = makeWebAccept("s1", windows.snapshot(T0 + 20_000), T0);
    const result = await scanWebArtifacts(oneRoot("/w"), T0 - 2000, fsOf({ "/w/old.html": T0 + 8_000, "/w/self.html": T0 + 8_000 }), { accept });
    deepStrictEqual(result.paths.map(normPosix), ["/w/old.html", "/w/self.html"]);
  });
});

describe("音视频候选（同一次扫描、同一套时间窗）", () => {
  it("扫描顺带收 mp3 / mp4 等，与网页分开放；旧文件与别的扩展名不收", async () => {
    const fs = fakeFs(
      { "/w": [
        { name: "final.mp3", isDir: false },
        { name: "part_1.MP3", isDir: false },
        { name: "clip.mp4", isDir: false },
        { name: "old.wav", isDir: false },
        { name: "movie.mkv", isDir: false }, // 面板播不了的容器不收
        { name: "page.html", isDir: false },
      ] },
      { "/w/final.mp3": 2000, "/w/part_1.MP3": 2000, "/w/clip.mp4": 2000, "/w/old.wav": 100, "/w/movie.mkv": 2000, "/w/page.html": 2000 },
    );
    const result = await scanWebArtifacts(oneRoot("/w"), 1000, fs);
    deepStrictEqual(result.mediaPaths.map(normPosix), ["/w/clip.mp4", "/w/final.mp3", "/w/part_1.MP3"]);
    deepStrictEqual(result.paths.map(normPosix), ["/w/page.html"]);
  });

  it("时间窗：mtime 不在脚本类工具窗口里的媒体不收（别的会话写的 / 模型想事情的空档）", async () => {
    const fs = fakeFs({ "/w": [{ name: "in.mp3", isDir: false }, { name: "out.mp3", isDir: false }] }, { "/w/in.mp3": 5000, "/w/out.mp3": 90000 });
    const accept = makeWebAccept("s1", [{ start: 4000, end: 6000 }], 1000);
    const result = await scanWebArtifacts(oneRoot("/w"), 1000, fs, { accept });
    deepStrictEqual(result.mediaPaths.map(normPosix), ["/w/in.mp3"]);
  });

  it("yt-dlp / youtube-dl 是下载命令：不开窗口（下载下来的不是本轮做的）", () => {
    for (const command of ["yt-dlp -x --audio-format mp3 https://x/y", "youtube-dl https://x/y", "curl -O https://x/a.mp3"]) {
      strictEqual(isDownloadCommand({ command }), true, command);
      const windows = new ToolWindows();
      windows.begin("c1", "bash", 1000, { command });
      windows.finish("c1", 2000);
      strictEqual(windows.snapshot(3000).length, 0, command);
    }
    strictEqual(isDownloadCommand({ command: "say -o a.aiff 你好 && ffmpeg -i a.aiff a.mp3" }), false);
  });

  it("capMediaArtifacts：超过批量上限一个不报", () => {
    const few = Array.from({ length: MEDIA_ARTIFACT_BATCH_LIMIT }, (_, i) => `/w/${i}.mp3`);
    deepStrictEqual(capMediaArtifacts(few), few);
    deepStrictEqual(capMediaArtifacts([...few, "/w/extra.mp3"]), []);
  });
});
