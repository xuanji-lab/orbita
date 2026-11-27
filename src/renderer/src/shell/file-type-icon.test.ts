import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { iconFileOf, materialIconName, type IconManifest } from "./file-type-icon.ts";

const manifest: IconManifest = {
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
  fileExtensions: { md: "markdown", docx: "word", "test.ts": "test-ts", pdf: "pdf" },
  fileNames: { "package.json": "nodejs", "agents.md": "agent" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  languageIds: { css: "css", typescript: "typescript" },
};

describe("materialIconName：名字 → 彩色图标名", () => {
  test("文件名优先，其次复合扩展名、扩展名，再其次经语言 id", () => {
    assert.equal(materialIconName(manifest, "package.json", "file"), "nodejs");
    assert.equal(materialIconName(manifest, "AGENTS.md", "file"), "agent");
    assert.equal(materialIconName(manifest, "a.test.ts", "file"), "test-ts");
    assert.equal(materialIconName(manifest, "周报.MD", "file"), "markdown");
    assert.equal(materialIconName(manifest, "main.ts", "file"), "typescript");
    assert.equal(materialIconName(manifest, "x.css", "file"), "css");
    assert.equal(materialIconName(manifest, "未知.qqq", "file"), "file");
    assert.equal(materialIconName(manifest, "Makefile", "file"), "file");
  });
  test("Orbita 的演示文稿按演示认；文件夹按名字，展开另一套", () => {
    assert.equal(materialIconName(manifest, "汇报.slides.json", "file"), "powerpoint");
    assert.equal(materialIconName(manifest, "src", "directory"), "folder-src");
    assert.equal(materialIconName(manifest, "src", "directory", true), "folder-src-open");
    assert.equal(materialIconName(manifest, "随便", "directory", true), "folder-open");
  });
  test("iconFileOf：iconPath 取末段；没有这个图标 = null", () => {
    assert.equal(iconFileOf({ markdown: { iconPath: "./../icons/markdown.svg" } }, "markdown"), "markdown.svg");
    assert.equal(iconFileOf({}, "nope"), null);
  });
});
