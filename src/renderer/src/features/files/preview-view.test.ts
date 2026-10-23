/**
 * textPreviewMode / truncatedNotice 的账。textPreviewMode 依赖 highlight.ts 的
 * langFromPath，引擎初始化是异步的——先等 highlighterReady 再断言（同
 * highlight.test.ts 的先例）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { highlighterReady } from "../chat/highlight.ts";
import {
  HIGHLIGHT_LIMIT,
  MARKDOWN_LIMIT,
  textLines,
  textPreviewMode,
  textRenderKind,
  textWindow,
  truncatedNotice,
  WINDOW_OVERSCAN,
  WINDOW_TEXT_LIMIT,
} from "./preview-view.ts";
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

describe("textRenderKind", () => {
  test("小 md 走 MarkdownBlock，超大 md 退化成窗口化纯文本", () => {
    assert.equal(textRenderKind("markdown", "rendered", 10 * 1024), "markdown");
    assert.equal(textRenderKind("markdown", "rendered", MARKDOWN_LIMIT), "markdown");
    assert.equal(textRenderKind("markdown", "rendered", MARKDOWN_LIMIT + 1), "plain");
    assert.equal(textRenderKind("markdown", "rendered", WINDOW_TEXT_LIMIT + 1), "windowed");
  });

  test("md 的 Source 段不跑 markdown 渲染", () => {
    assert.equal(textRenderKind("markdown", "source", 1024), "plain");
    assert.equal(textRenderKind("markdown", "source", WINDOW_TEXT_LIMIT + 1), "windowed");
  });

  test("代码：高亮上限内走 shiki，超过上限的走窗口化原文", () => {
    assert.equal(textRenderKind("code", "rendered", 1), "highlight");
    assert.equal(textRenderKind("code", "rendered", HIGHLIGHT_LIMIT), "highlight");
    assert.equal(textRenderKind("code", "rendered", HIGHLIGHT_LIMIT + 1), "plain");
    assert.equal(textRenderKind("code", "rendered", WINDOW_TEXT_LIMIT + 1), "windowed");
  });

  test("阈值恰好卡在边界上：等于上限走完整渲染，多一个字才换路径", () => {
    assert.equal(textRenderKind("plain", "rendered", WINDOW_TEXT_LIMIT), "plain");
    assert.equal(textRenderKind("plain", "rendered", WINDOW_TEXT_LIMIT + 1), "windowed");
  });
});

describe("textLines", () => {
  test("按 \\n 切行，末尾换行保留成最后一个空行（与 <pre> 一致）", () => {
    assert.deepEqual(textLines("a\nb\n"), ["a", "b", ""]);
    assert.deepEqual(textLines(""), [""]);
    assert.deepEqual(textLines("one"), ["one"]);
  });
});

describe("textWindow", () => {
  const ROW = 20;
  const VIEW = 600; // 30 行视口

  test("首屏：从 0 起，上界 = 一屏 + overscan", () => {
    const w = textWindow(10_000, 0, VIEW, ROW);
    assert.deepEqual(w, {
      totalLines: 10_000,
      start: 0,
      end: Math.ceil(VIEW / ROW) + WINDOW_OVERSCAN,
      padTop: 0,
      padBottom: 10_000 - (Math.ceil(VIEW / ROW) + WINDOW_OVERSCAN),
    });
  });

  test("滚到中部：上下各留 overscan 行", () => {
    // 滚到第 5,000 行开头
    const w = textWindow(10_000, 5_000 * ROW, VIEW, ROW);
    assert.equal(w.start, 5_000 - WINDOW_OVERSCAN);
    assert.equal(w.end, 5_000 + 30 + WINDOW_OVERSCAN);
    assert.equal(w.padTop, w.start);
    assert.equal(w.padBottom, 10_000 - w.end);
    // 占位 + 渲染行 = 全文行数，滚动条长度才与全文一致
    assert.equal(w.padTop + (w.end - w.start) + w.padBottom, w.totalLines);
  });

  test("滚到底：end 夹到总行数，底部占位为 0", () => {
    const total = 10_000;
    const maxScroll = total * ROW - VIEW;
    const w = textWindow(total, maxScroll, VIEW, ROW);
    assert.equal(w.end, total);
    assert.equal(w.padBottom, 0);
    assert.ok(w.start > 0);
    assert.equal(w.padTop + (w.end - w.start) + w.padBottom, total);
  });

  test("超短文件（比 overscan 还少）：全部渲染，没有占位", () => {
    const w = textWindow(3, 0, VIEW, ROW);
    assert.deepEqual(w, { totalLines: 3, start: 0, end: 3, padTop: 0, padBottom: 0 });
    for (const total of [1, WINDOW_OVERSCAN, WINDOW_OVERSCAN + 1]) {
      const t = textWindow(total, 0, VIEW, ROW);
      assert.equal(t.start, 0);
      assert.equal(t.end, Math.min(total, 30 + WINDOW_OVERSCAN));
      assert.equal(t.padTop + (t.end - t.start) + t.padBottom, total);
    }
  });

  test("恰好等于一屏 + 一次 overscan：铺满窗口且不留占位", () => {
    const total = 30 + WINDOW_OVERSCAN;
    const w = textWindow(total, 0, VIEW, ROW);
    assert.equal(w.start, 0);
    assert.equal(w.end, total);
    assert.equal(w.padTop, 0);
    assert.equal(w.padBottom, 0);
  });

  test("行高还没量出来（首帧 rowHeight = 0）：只给首屏 + overscan，绝不退化成全渲染", () => {
    const w = textWindow(10_000, 0, VIEW, 0);
    assert.equal(w.start, 0);
    assert.equal(w.end, 2 * WINDOW_OVERSCAN + 1);
    assert.equal(w.padBottom, 10_000 - w.end);
  });

  test("空文件 / 越界的滚动位置不越界", () => {
    assert.deepEqual(textWindow(0, 0, VIEW, ROW), {
      totalLines: 0,
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
    const w = textWindow(100, 99_999, VIEW, ROW);
    assert.equal(w.start, 0);
    assert.equal(w.end, 100);
  });
});
