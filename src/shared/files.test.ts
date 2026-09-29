import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileRootLabel, isWebPageFile, sortFileEntries, type FileEntry } from "./files.ts";

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
