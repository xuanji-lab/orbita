import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countLoadedEntries,
  countVisibleEntries,
  fileIcon,
  fileIconTone,
  filterCountText,
  filterEntries,
  footerSummary,
  formatAge,
  formatSize,
  hasAgentsMd,
  mergeRefresh,
  orderEntries,
  orderEntriesByType,
  refreshTargets,
} from "./tree-view.ts";
import type { FileEntry, FileRoot } from "../../../../shared/files.ts";
import { en } from "../../messages-en.ts";

const dir = (name: string): FileEntry => ({ name, kind: "directory", modifiedAt: 0 });
const file = (name: string): FileEntry => ({ name, kind: "file", size: 1, modifiedAt: 0 });

describe("orderEntries", () => {
  it("`.` 开头的照列，但排到同层最后（主进程的名次不动）", () => {
    deepStrictEqual(
      orderEntries([dir("src"), file(".DS_Store"), file("AGENTS.md"), dir(".orbita")]),
      [dir("src"), file("AGENTS.md"), file(".DS_Store"), dir(".orbita")],
    );
  });

  it("没有 dotfile 时保持主进程顺序（稳定，不重排）", () => {
    const entries = [dir("docs"), dir("src"), file("package.json")];
    deepStrictEqual(orderEntries(entries), entries);
  });

  it("dotfile 之间保持原有相对顺序", () => {
    deepStrictEqual(
      orderEntries([file(".zshrc"), file(".DS_Store"), file("readme")]),
      [file("readme"), file(".zshrc"), file(".DS_Store")],
    );
  });
});

describe("orderEntriesByType", () => {
  it("目录最前，文件按 fileIcon 分档同类相聚，档内按名字", () => {
    deepStrictEqual(
      orderEntriesByType([
        file("notes.md"),
        dir("plans"),
        file("index.html"),
        file("a.ts"),
        file("z.ts"),
        file("logo.png"),
        file("app.tsx"),
      ]),
      [
        dir("plans"),
        file("a.ts"),
        file("app.tsx"),
        file("z.ts"),
        file("index.html"),
        file("logo.png"),
        file("notes.md"),
      ],
    );
  });

  it("dotfile 按自己的类型入档（不再垫底）：.gitignore 进配置档", () => {
    deepStrictEqual(
      orderEntriesByType([file("readme.md"), file(".gitignore"), file("main.py")]),
      [file("main.py"), file(".gitignore"), file("readme.md")],
    );
  });

  it("认不出的类型（symlink / 未知扩展）压底，名字序", () => {
    deepStrictEqual(
      orderEntriesByType([
        file("data.xyz"),
        file("a.ts"),
        { name: "link", kind: "symlink", modifiedAt: 0 },
        file("b.xyz"),
      ]),
      [file("a.ts"), file("b.xyz"), file("data.xyz"), { name: "link", kind: "symlink", modifiedAt: 0 }],
    );
  });
});

describe("filterEntries", () => {
  const entries = [dir("src"), dir("docs"), file("package.json"), file(".DS_Store")];

  it("空白词 = 不过滤（面板里删词回到全量）", () => {
    deepStrictEqual(filterEntries(entries, "  "), entries);
    deepStrictEqual(filterEntries(entries, ""), entries);
  });

  it("按名字子串裁剪，大小写不敏感；只裁已加载的这层，不递归", () => {
    deepStrictEqual(filterEntries(entries, "SRC"), [dir("src")]);
    deepStrictEqual(filterEntries(entries, "json"), [file("package.json")]);
  });

  it("dotfile 也要能被过滤词找到（照列的另一半：能搜到）", () => {
    deepStrictEqual(filterEntries(entries, "ds"), [file(".DS_Store")]);
  });

  it("全都不匹配时是空数组（调用方安静地不渲染）", () => {
    deepStrictEqual(filterEntries(entries, "zzz"), []);
  });
});

describe("hasAgentsMd", () => {
  it("第一层有 AGENTS.md：有 rules，不出提示行", () => {
    deepStrictEqual(hasAgentsMd([dir("src"), file("AGENTS.md")]), true);
  });

  it("没有就是没有——提示行是「找不到规则文件」的痛点落点，不能错报", () => {
    deepStrictEqual(hasAgentsMd([dir("src"), file("package.json")]), false);
    deepStrictEqual(hasAgentsMd([]), false);
  });

  it("大小写不同的近似名不算（模板与 agent 写的都是 AGENTS.md，精确匹配）", () => {
    deepStrictEqual(hasAgentsMd([file("agents.md")]), false);
  });
});

describe("footerSummary", () => {
  it("单数 root", () => {
    deepStrictEqual(footerSummary(1, 0, en), "1 root");
  });

  it("复数 roots", () => {
    deepStrictEqual(footerSummary(3, 0, en), "3 roots");
  });

  it("attached 在盘上缺席：如实追加 missing，不静默", () => {
    deepStrictEqual(footerSummary(4, 1, en), "4 roots · 1 missing");
    deepStrictEqual(footerSummary(5, 2, en), "5 roots · 2 missing");
  });
});

describe("fileIcon", () => {
  it("目录按展开态选 folder / folder-open，忽略名字", () => {
    deepStrictEqual(fileIcon("src", "directory", false), "folder");
    deepStrictEqual(fileIcon("src", "directory", true), "folder-open");
    deepStrictEqual(fileIcon("src", "directory"), "folder"); // 不传 open 默认收起
  });

  it("AGENTS.md 保持 book（精确名，先于扩展名判定）", () => {
    deepStrictEqual(fileIcon("AGENTS.md", "file"), "book");
  });

  it("symlink 一律 file——契约里没有目标路径，也不知道目标是文件还是目录", () => {
    deepStrictEqual(fileIcon("docs-archive", "symlink"), "file");
    deepStrictEqual(fileIcon("readme.md", "symlink"), "file"); // 扩展名不影响，仍是中性 file
  });

  it("代码扩展名 → file-code-2", () => {
    deepStrictEqual(fileIcon("index.ts", "file"), "file-code-2");
    deepStrictEqual(fileIcon("App.tsx", "file"), "file-code-2");
    deepStrictEqual(fileIcon("main.py", "file"), "file-code-2");
    deepStrictEqual(fileIcon("styles.SCSS", "file"), "file-code-2"); // 大小写不敏感
  });

  it("配置扩展名 → file-json-2", () => {
    deepStrictEqual(fileIcon("package.json", "file"), "file-json-2");
    deepStrictEqual(fileIcon("tsconfig.YAML", "file"), "file-json-2");
    deepStrictEqual(fileIcon("bun.lock", "file"), "file-json-2");
  });

  it("常见无扩展名配置文件与点文件 → file-json-2", () => {
    deepStrictEqual(fileIcon(".gitignore", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".gitattributes", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".editorconfig", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".npmrc", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".nvmrc", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".env", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".env.local", "file"), "file-json-2");
    deepStrictEqual(fileIcon(".env.production", "file"), "file-json-2");
    deepStrictEqual(fileIcon("Dockerfile", "file"), "file-json-2");
    deepStrictEqual(fileIcon("Makefile", "file"), "file-json-2");
    deepStrictEqual(fileIcon("makefile", "file"), "file-json-2"); // 大小写不敏感
  });

  it("图片扩展名 → image", () => {
    deepStrictEqual(fileIcon("shot.PNG", "file"), "image");
    deepStrictEqual(fileIcon("logo.svg", "file"), "image");
  });

  it("文本扩展名 → file-text；markdown 也是文本形状", () => {
    deepStrictEqual(fileIcon("README.md", "file"), "file-text");
    deepStrictEqual(fileIcon("notes.txt", "file"), "file-text");
    deepStrictEqual(fileIcon("guide.mdx", "file"), "file-text");
  });

  it("网页扩展名 → globe（html / css 与样式表同档）", () => {
    deepStrictEqual(fileIcon("index.html", "file"), "globe");
    deepStrictEqual(fileIcon("styles.CSS", "file"), "globe"); // 大小写不敏感
    deepStrictEqual(fileIcon("page.htm", "file"), "globe");
  });

  it("文档扩展名 → book（排版过的成品文档）；pdf 单独走卷轴 scroll-text（与 docx 形状先分，2026-10 验收 L）", () => {
    deepStrictEqual(fileIcon("paper.pdf", "file"), "scroll-text");
    deepStrictEqual(fileIcon("简历.DOCX", "file"), "book");
    deepStrictEqual(fileIcon("report.rtf", "file"), "book");
  });

  it("演示扩展名 → presentation", () => {
    deepStrictEqual(fileIcon("slides.pptx", "file"), "presentation");
    deepStrictEqual(fileIcon("demo.KEY", "file"), "presentation");
  });

  it("表格扩展名 → file-spreadsheet（csv/tsv 从文本形状挪来——形状是表）", () => {
    deepStrictEqual(fileIcon("budget.XLSX", "file"), "file-spreadsheet");
    deepStrictEqual(fileIcon("data.csv", "file"), "file-spreadsheet");
    deepStrictEqual(fileIcon("sheet.numbers", "file"), "file-spreadsheet");
  });

  it("压缩包扩展名 → file-archive", () => {
    deepStrictEqual(fileIcon("bundle.zip", "file"), "file-archive");
    deepStrictEqual(fileIcon("backup.7Z", "file"), "file-archive");
    deepStrictEqual(fileIcon("src.tar.gz", "file"), "file-archive");
  });

  it("音视频分开：mp3 → file-audio-2，mp4 → file-video-2", () => {
    deepStrictEqual(fileIcon("voice.MP3", "file"), "file-audio-2");
    deepStrictEqual(fileIcon("clip.mov", "file"), "file-video-2");
    deepStrictEqual(fileIcon("lecture.mp4", "file"), "file-video-2");
  });

  it("无扩展名、不在任何配置名单里、其它未知扩展名 → file（兜底）", () => {
    deepStrictEqual(fileIcon("LICENSE", "file"), "file");
    deepStrictEqual(fileIcon("binary.out", "file"), "file");
    deepStrictEqual(fileIcon(".mystery", "file"), "file"); // 点文件但不在配置名单
  });

  it("fileIconTone：文档 / 演示 / 表格三族有色，其余（含 pdf、目录、symlink）中性", () => {
    deepStrictEqual(fileIconTone("论文.DOCX", "file"), "doc");
    deepStrictEqual(fileIconTone("memo.rtf", "file"), "doc");
    deepStrictEqual(fileIconTone("notes.odt", "file"), "doc");
    deepStrictEqual(fileIconTone("slides.pptx", "file"), "slides");
    deepStrictEqual(fileIconTone("demo.key", "file"), "slides");
    deepStrictEqual(fileIconTone("budget.xlsx", "file"), "sheet");
    deepStrictEqual(fileIconTone("data.CSV", "file"), "sheet");
    deepStrictEqual(fileIconTone("sheet.numbers", "file"), "sheet");
    deepStrictEqual(fileIconTone("ledger.ods", "file"), "sheet");
    // pdf 用户点名不在内；代码 / 图片 / 文本 / 压缩包 / 音视频一律中性
    deepStrictEqual(fileIconTone("paper.pdf", "file"), null);
    deepStrictEqual(fileIconTone("index.ts", "file"), null);
    deepStrictEqual(fileIconTone("notes.txt", "file"), null);
    deepStrictEqual(fileIconTone("data.tsv", "file"), null); // tsv 不在用户点名的表格清单里
    deepStrictEqual(fileIconTone("bundle.zip", "file"), null);
    deepStrictEqual(fileIconTone("src", "directory"), null);
    deepStrictEqual(fileIconTone("readme.md", "symlink"), null);
    deepStrictEqual(fileIconTone("无扩展名", "file"), null);
  });
});

describe("formatSize", () => {
  it("0 字节", () => {
    deepStrictEqual(formatSize(0), "0 B");
  });

  it("小于 1024：原样报字节数", () => {
    deepStrictEqual(formatSize(812), "812 B");
  });

  it("刚好 1024：进 KB 档，不是 1024 B", () => {
    deepStrictEqual(formatSize(1024), "1 KB");
  });

  it("KB 取整", () => {
    deepStrictEqual(formatSize(49_152), "48 KB"); // 48 * 1024，整除
    deepStrictEqual(formatSize(49_700), "49 KB"); // 48.53 KB，四舍五入进位
  });

  it("MB 一位小数，去掉多余的 .0", () => {
    deepStrictEqual(formatSize(Math.round(1.9 * 1024 * 1024)), "1.9 MB");
    deepStrictEqual(formatSize(2 * 1024 * 1024), "2 MB");
  });

  it("GB 一位小数，去掉多余的 .0", () => {
    deepStrictEqual(formatSize(Math.round(2.3 * 1024 * 1024 * 1024)), "2.3 GB");
    deepStrictEqual(formatSize(4 * 1024 * 1024 * 1024), "4 GB");
  });
});

describe("formatAge", () => {
  const NOW = 1_700_000_000_000;

  it("1 分钟以内：now", () => {
    deepStrictEqual(formatAge(NOW, NOW, en), "now");
    deepStrictEqual(formatAge(NOW - 59_000, NOW, en), "now");
  });

  it("未来时间戳（主进程与本机时钟不同步）也当 now，不显示负数", () => {
    deepStrictEqual(formatAge(NOW + 60_000, NOW, en), "now");
  });

  it("分钟档", () => {
    deepStrictEqual(formatAge(NOW - 60_000, NOW, en), "1m");
    deepStrictEqual(formatAge(NOW - 12 * 60_000, NOW, en), "12m");
  });

  it("小时档", () => {
    deepStrictEqual(formatAge(NOW - 60 * 60_000, NOW, en), "1h");
  });

  it("天档", () => {
    deepStrictEqual(formatAge(NOW - 24 * 60 * 60_000, NOW, en), "1d");
    deepStrictEqual(formatAge(NOW - 3 * 24 * 60 * 60_000, NOW, en), "3d");
  });

  it("周档", () => {
    deepStrictEqual(formatAge(NOW - 7 * 24 * 60 * 60_000, NOW, en), "1w");
    deepStrictEqual(formatAge(NOW - 35 * 24 * 60 * 60_000, NOW, en), "5w");
  });

  it("月档", () => {
    deepStrictEqual(formatAge(NOW - 60 * 24 * 60 * 60_000, NOW, en), "2mo");
    deepStrictEqual(formatAge(NOW - 240 * 24 * 60 * 60_000, NOW, en), "8mo");
  });

  it("年档", () => {
    deepStrictEqual(formatAge(NOW - 365 * 24 * 60 * 60_000, NOW, en), "1y");
    deepStrictEqual(formatAge(NOW - 2 * 365 * 24 * 60 * 60_000, NOW, en), "2y");
  });
});

describe("filterCountText", () => {
  it("不过滤：只报已加载总数", () => {
    deepStrictEqual(filterCountText(41, 41, false), "41");
  });

  it("过滤中：命中 / 总数", () => {
    deepStrictEqual(filterCountText(2, 41, true), "2 / 41");
  });

  it("过滤后 0 命中：0 / 总数（不是空字符串）", () => {
    deepStrictEqual(filterCountText(0, 41, true), "0 / 41");
  });
});

describe("countVisibleEntries / countLoadedEntries", () => {
  const root: FileRoot = { kind: "workspace", label: "orbita", path: "/ws", exists: true };

  it("只数已展开层，折叠的子树哪怕已加载也不计入 shown", () => {
    const dirs = new Map<string, readonly FileEntry[]>([
      ["/ws", [dir("src"), file("README.md")]],
      ["/ws/src", [file("index.ts"), file("index.test.ts")]], // 已加载但父目录没展开
    ]);
    deepStrictEqual(countVisibleEntries([root], dirs, new Set(), ""), 2);
    deepStrictEqual(countLoadedEntries(dirs), 4);
  });

  it("展开后子树的条目计入 shown，且每一层都受同一条过滤词约束（父层不匹配，子层再匹配也不下探——与 rowsOf 的渲染规则一致）", () => {
    const dirs = new Map<string, readonly FileEntry[]>([
      ["/ws", [dir("src"), file("README.md")]],
      ["/ws/src", [file("index.ts"), file("styles.css")]],
    ]);
    const expanded = new Set(["/ws/src"]);
    deepStrictEqual(countVisibleEntries([root], dirs, expanded, ""), 4);
    // "s"：顶层命中 src（不命中 README.md），下探后子层两个文件名都带 s
    deepStrictEqual(countVisibleEntries([root], dirs, expanded, "s"), 3);
  });

  it("根不存在（exists: false）时不下探——即便 dirs 里有残留缓存也不计入", () => {
    const missingRoot: FileRoot = { ...root, exists: false };
    const dirs = new Map<string, readonly FileEntry[]>([["/ws", [file("stale.md")]]]);
    deepStrictEqual(countVisibleEntries([missingRoot], dirs, new Set(), ""), 0);
    deepStrictEqual(countLoadedEntries(dirs), 1); // loaded 口径不管根是否还存在，如实数已加载的
  });

  it("跨多个根累加", () => {
    const rootB: FileRoot = { kind: "attached", label: "vault", path: "/vault", exists: true };
    const dirs = new Map<string, readonly FileEntry[]>([
      ["/ws", [file("a.md")]],
      ["/vault", [file("b.md"), file("c.md")]],
    ]);
    deepStrictEqual(countVisibleEntries([root, rootB], dirs, new Set(), ""), 3);
    deepStrictEqual(countLoadedEntries(dirs), 3);
  });
});

describe("refreshTargets", () => {
  const ws: FileRoot = { kind: "workspace", label: "orbita", path: "/ws", exists: true };
  const session: FileRoot = { kind: "session", label: "task", path: "/wb/s1", exists: false };

  it("在盘的根 + 全部展开目录（含祖先收起的），各自带上所属根", () => {
    // /ws/src 收起但 /ws/src/lib 还在展开表里：祖先再展开时它要有新数据
    deepStrictEqual(refreshTargets([session, ws], new Set(["/ws/docs", "/ws/src/lib"])), [
      { root: "/ws", dir: "/ws" },
      { root: "/ws", dir: "/ws/docs" },
      { root: "/ws", dir: "/ws/src/lib" },
    ]);
  });

  it("不在盘的根不拉；落不进任何在盘根的展开目录（根被摘）不拉", () => {
    deepStrictEqual(refreshTargets([ws], new Set(["/vault/notes"])), [{ root: "/ws", dir: "/ws" }]);
  });

  it("按路径段判归属：/ws2 下的目录不归 /ws", () => {
    deepStrictEqual(refreshTargets([ws], new Set(["/ws2/a"])), [{ root: "/ws", dir: "/ws" }]);
  });

  it("嵌套的根（附加目录在工作区里）按目录去重", () => {
    const vendor: FileRoot = { kind: "attached", label: "vendor", path: "/ws/vendor", exists: true };
    deepStrictEqual(refreshTargets([ws, vendor], new Set(["/ws/vendor"])), [
      { root: "/ws", dir: "/ws" },
      { root: "/ws/vendor", dir: "/ws/vendor" },
    ]);
  });
});

describe("mergeRefresh", () => {
  it("展开目录换新快照，展开态原样保留（复现：展开着的目录里新建文件）", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([
        ["/ws", [dir("src")]],
        ["/ws/src", [file("a.ts")]],
      ]),
      expanded: new Set(["/ws/src"]),
    };
    const next = mergeRefresh(current, ["/ws"], new Map([
      ["/ws", [dir("src")]],
      ["/ws/src", [file("a.ts"), file("b.ts")]],
    ]));
    deepStrictEqual(next.dirs.get("/ws/src"), [file("a.ts"), file("b.ts")]);
    deepStrictEqual(next.expanded, new Set(["/ws/src"]));
  });

  it("收起目录的旧缓存丢掉——下次展开缓存未命中、现拉（复现：收起再展开还是旧列表）", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([
        ["/ws", [dir("src")]],
        ["/ws/src", [file("a.ts")]],
      ]),
      expanded: new Set<string>(),
    };
    const next = mergeRefresh(current, ["/ws"], new Map([["/ws", [dir("src")]]]));
    deepStrictEqual(next.dirs.has("/ws/src"), false);
    deepStrictEqual(next.dirs.get("/ws"), [dir("src")]);
  });

  it("非根目录拉失败（被删 / 挪走）：连同子孙一起丢缓存、剪出展开态", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([
        ["/ws", [dir("build"), dir("build-cache")]],
        ["/ws/build", [dir("out")]],
        ["/ws/build/out", [file("x.js")]],
        ["/ws/build-cache", [file("y")]],
      ]),
      expanded: new Set(["/ws/build", "/ws/build/out", "/ws/build-cache"]),
    };
    const next = mergeRefresh(current, ["/ws"], new Map<string, readonly FileEntry[] | null>([
      ["/ws", [dir("build-cache")]],
      ["/ws/build", null],
      ["/ws/build/out", null],
      ["/ws/build-cache", [file("y")]],
    ]));
    deepStrictEqual([...next.dirs.keys()], ["/ws", "/ws/build-cache"]); // 按段判，build-cache 不陪葬
    deepStrictEqual(next.expanded, new Set(["/ws/build-cache"]));
  });

  it("根拉失败保留旧快照（读失败 ≠ 空），展开态不动", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([["/ws", [file("a.md")]]]),
      expanded: new Set<string>(),
    };
    const next = mergeRefresh(current, ["/ws"], new Map([["/ws", null]]));
    deepStrictEqual(next.dirs.get("/ws"), [file("a.md")]);
  });

  it("刷新在途时新点开的目录（不在结果里但展开着）原样保留，不被冲掉", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([
        ["/ws", [dir("docs")]],
        ["/ws/docs", [file("guide.md")]], // 刷新发起后才由懒加载拉到
      ]),
      expanded: new Set(["/ws/docs"]),
    };
    const next = mergeRefresh(current, ["/ws"], new Map([["/ws", [dir("docs")]]]));
    deepStrictEqual(next.dirs.get("/ws/docs"), [file("guide.md")]);
    deepStrictEqual(next.expanded, new Set(["/ws/docs"]));
  });

  it("之前没缓存的根（工作台首次写入后才出现）直接收下", () => {
    const current = { dirs: new Map<string, readonly FileEntry[]>(), expanded: new Set<string>() };
    const next = mergeRefresh(current, ["/wb/s1"], new Map([["/wb/s1", [file("plan.md")]]]));
    deepStrictEqual(next.dirs.get("/wb/s1"), [file("plan.md")]);
  });

  it("根被摘 / 不在盘了：它名下的缓存与展开态一起清掉", () => {
    const current = {
      dirs: new Map<string, readonly FileEntry[]>([
        ["/ws", [file("a.md")]],
        ["/vault", [dir("notes")]],
        ["/vault/notes", [file("n.md")]],
      ]),
      expanded: new Set(["/vault/notes"]),
    };
    const next = mergeRefresh(current, ["/ws"], new Map([["/ws", [file("a.md")]]]));
    deepStrictEqual([...next.dirs.keys()], ["/ws"]);
    deepStrictEqual(next.expanded, new Set());
  });
});

describe("原生 Windows 路径（反斜杠根）", () => {
  const root: FileRoot = { kind: "workspace", label: "orbita", path: "C:\\Orbita", exists: true };

  it("countVisibleEntries：原生根拼出的混形子键也能取到已加载项", () => {
    // 子键是 `${root}/${name}`：原生根 C:\Orbita 拼出混形 C:\Orbita/src，dirs/expanded 用同一把钥匙
    const dirs = new Map<string, readonly FileEntry[]>([
      ["C:\\Orbita", [dir("src"), file("README.md")]],
      ["C:\\Orbita/src", [file("index.ts")]],
    ]);
    deepStrictEqual(countVisibleEntries([root], dirs, new Set(["C:\\Orbita/src"]), ""), 3);
  });

  it("refreshTargets：展开目录落在反斜杠根之内也重拉（isWithin 走 pathWithin）", () => {
    deepStrictEqual(refreshTargets([root], new Set(["C:\\Orbita/src"])), [
      { root: "C:\\Orbita", dir: "C:\\Orbita" },
      { root: "C:\\Orbita", dir: "C:\\Orbita/src" },
    ]);
  });
});
