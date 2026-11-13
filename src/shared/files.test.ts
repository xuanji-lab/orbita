import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fileRootLabel,
  isWebArtifactFile,
  isWebPageFile,
  PREVIEW_BINARY_SNIFF_BYTES,
  PREVIEW_HIGHLIGHT_LIMIT,
  PREVIEW_IMAGE_LIMIT,
  PREVIEW_LINES_PER_READ,
  PREVIEW_MARKDOWN_LIMIT,
  PREVIEW_MAX_INDEX_BYTES,
  PREVIEW_MAX_LINE_BYTES,
  PREVIEW_PDF_LIMIT,
  PREVIEW_ROW_CHARS,
  PREVIEW_TEXT_LIMIT,
  PREVIEW_WINDOW_LIMIT,
  sortFileEntries,
  type FileEntry,
} from "./files.ts";

const entry = (name: string, kind: FileEntry["kind"]): FileEntry => ({ name, kind, modifiedAt: 0 });

describe("sortFileEntries", () => {
  it("目录排前，同类按名字、大小写不敏感、数字按数值", () => {
    const sorted = sortFileEntries([
      entry("b.md", "file"),
      entry("src", "directory"),
      entry("A.md", "file"),
      entry("file10", "file"),
      entry("file2", "file"),
      entry("Docs", "directory"),
    ]);
    deepStrictEqual(
      sorted.map((item) => item.name),
      ["Docs", "src", "A.md", "b.md", "file2", "file10"],
    );
  });

  it("不改原数组", () => {
    const input = [entry("b", "file"), entry("a", "directory")];
    sortFileEntries(input);
    deepStrictEqual(
      input.map((item) => item.name),
      ["b", "a"],
    );
  });
});

describe("fileRootLabel", () => {
  it("attached 取路径末段，结尾斜杠不影响", () => {
    strictEqual(fileRootLabel("attached", "/Users/wafo/ob/research vault/", "", "x"), "research vault");
  });

  it("session / workspace 用标题，空标题退回 fallback", () => {
    strictEqual(fileRootLabel("session", "/w/1", "grill 文件系统", "Untitled"), "grill 文件系统");
    strictEqual(fileRootLabel("session", "/w/1", "   ", "Untitled"), "Untitled");
    strictEqual(fileRootLabel("workspace", "/x", "orbita", "Home"), "orbita");
  });
});

describe("isWebPageFile", () => {
  it("html / htm / xhtml / svg 算网页，大小写不敏感；别的不算", () => {
    for (const name of ["report.html", "a/b/INDEX.HTM", "page.xhtml", "chart.svg"]) strictEqual(isWebPageFile(name), true, name);
    for (const name of ["notes.md", "data.json", "html", "page.html.bak", "shot.png"]) strictEqual(isWebPageFile(name), false, name);
  });
});

describe("isWebArtifactFile（轮尾网页产物：卡片行与轮内扫描同一张表）", () => {
  it("只收 html / htm / svg，不认 xhtml（那是浏览器那套表）", () => {
    for (const name of ["report.html", "a/b/INDEX.HTM", "chart.SVG"]) strictEqual(isWebArtifactFile(name), true, name);
    for (const name of ["page.xhtml", "notes.md", "html", "page.html.bak"]) strictEqual(isWebArtifactFile(name), false, name);
  });
});

describe("PREVIEW_TEXT_LIMIT", () => {
  it("16 MB：窗口化之后它只保护整份文本进 JS 堆 / 一次 IPC，不再是渲染上限", () => {
    strictEqual(PREVIEW_TEXT_LIMIT, 16 * 1024 * 1024);
  });
});

describe("文件预览的尺寸门槛表", () => {
  it("从小到大的台阶是单调的：渲染路径的门槛 < 整份进 renderer 的上限 < 扫一遍的上限", () => {
    // markdown 渲染 ≤ 代码高亮 ≤ 窗口化 < 16 MB（整份读）< 1 GiB（主进程愿意扫）
    strictEqual(PREVIEW_MARKDOWN_LIMIT <= PREVIEW_HIGHLIGHT_LIMIT, true);
    strictEqual(PREVIEW_HIGHLIGHT_LIMIT <= PREVIEW_WINDOW_LIMIT, true);
    strictEqual(PREVIEW_WINDOW_LIMIT < PREVIEW_TEXT_LIMIT, true);
    strictEqual(PREVIEW_TEXT_LIMIT < PREVIEW_MAX_INDEX_BYTES, true);
    strictEqual(PREVIEW_MAX_INDEX_BYTES, 1024 * 1024 * 1024);
  });

  it("分段预览的单行 / 一窗的数没被改动；一条显示行（字符）不会比单行字节上限还长", () => {
    strictEqual(PREVIEW_MAX_LINE_BYTES, 64 * 1024);
    strictEqual(PREVIEW_LINES_PER_READ, 600);
    strictEqual(PREVIEW_ROW_CHARS <= PREVIEW_MAX_LINE_BYTES, true);
  });

  it("其余几个数没被改动", () => {
    strictEqual(PREVIEW_BINARY_SNIFF_BYTES, 8 * 1024);
    strictEqual(PREVIEW_IMAGE_LIMIT, 20 * 1024 * 1024);
    strictEqual(PREVIEW_PDF_LIMIT, 100 * 1024 * 1024);
  });
});
