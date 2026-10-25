import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { contentHash, fileRootLabel, isWebArtifactFile, isWebPageFile, sortFileEntries, type FileEntry } from "./files.ts";

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

describe("contentHash（编辑器写盘的冲突判定指纹）", () => {
  it("同一段文本恒得同一个 16 位十六进制；不同文本不同", () => {
    const a = contentHash("\\section{Intro}\nHello\n");
    strictEqual(a.length, 16);
    strictEqual(a, contentHash("\\section{Intro}\nHello\n"));
    strictEqual(a === contentHash("\\section{Intro}\nHello!"), false);
  });

  it("CRLF 与 LF 是两份内容（保存保留换行才不会被当成「没改」）", () => {
    strictEqual(contentHash("a\r\nb") === contentHash("a\nb"), false);
  });

  it("空文本也有稳定指纹；开头多一个空格就是另一份内容", () => {
    strictEqual(contentHash("").length, 16);
    strictEqual(contentHash(" a") === contentHash("a"), false);
    strictEqual(contentHash("section") === contentHash("\\section"), false);
  });
});
