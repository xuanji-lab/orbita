/**
 * textPreviewMode / truncatedNotice 的账。textPreviewMode 依赖 highlight.ts 的
 * langFromPath，引擎初始化是异步的——先等 highlighterReady 再断言（同
 * highlight.test.ts 的先例）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { highlighterReady } from "../chat/highlight.ts";
import { HIGHLIGHT_LIMIT, textPreviewMode, truncatedNotice } from "./preview-view.ts";
import { en } from "../../messages-en.ts";

await highlighterReady;

describe("textPreviewMode", () => {
  test("md 系一律 markdown（大小写不敏感）", () => {
    for (const name of ["README.md", "notes.mdx", "spec.markdown", "README.MD"]) {
      assert.equal(textPreviewMode(name), "markdown");
    }
  });

  test("highlight.ts 认得的语言算代码", () => {
    for (const name of ["a.ts", "b.tsx", "c.json", "d.py", "e.html", "f.yml"]) {
      assert.equal(textPreviewMode(name), "code");
    }
  });

  test("无扩展名 / highlight.ts 没预置的扩展名算等宽原文", () => {
    for (const name of ["LICENSE", "Makefile", "data.bin", "logo.svg"]) {
      assert.equal(textPreviewMode(name), "plain");
    }
  });
});

describe("truncatedNotice", () => {
  test("拼出 Showing the first … of … 文案，复用 formatSize 的单位格式", () => {
    assert.equal(
      truncatedNotice(2 * 1024 * 1024, 5 * 1024 * 1024, en),
      "Showing the first 2 MB of 5 MB",
    );
  });
});

describe("HIGHLIGHT_LIMIT", () => {
  test("200 KB", () => {
    assert.equal(HIGHLIGHT_LIMIT, 200 * 1024);
  });
});
