/**
 * textPreviewMode / truncatedNotice 的账。textPreviewMode 依赖 highlight.ts 的
 * langFromPath，引擎初始化是异步的——先等 highlighterReady 再断言（同
 * highlight.test.ts 的先例）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { highlighterReady } from "../chat/highlight.ts";
import { PREVIEW_HIGHLIGHT_LIMIT, PREVIEW_MARKDOWN_LIMIT, PREVIEW_ROW_CHARS, PREVIEW_WINDOW_LIMIT } from "../../../../shared/files.ts";
import {
  largeTextNotice,
  textLines,
  textPreviewMode,
  textRenderKind,
  textRows,
  textWindow,
  truncatedNotice,
  WINDOW_OVERSCAN,
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

describe("PREVIEW_HIGHLIGHT_LIMIT", () => {
  test("200 KB", () => {
    assert.equal(PREVIEW_HIGHLIGHT_LIMIT, 200 * 1024);
  });
});

describe("textRenderKind", () => {
  test("小 md 走 MarkdownBlock，超大 md 退化成窗口化纯文本", () => {
    assert.equal(textRenderKind("markdown", "rendered", 10 * 1024), "markdown");
    assert.equal(textRenderKind("markdown", "rendered", PREVIEW_MARKDOWN_LIMIT), "markdown");
    assert.equal(textRenderKind("markdown", "rendered", PREVIEW_MARKDOWN_LIMIT + 1), "plain");
    assert.equal(textRenderKind("markdown", "rendered", PREVIEW_WINDOW_LIMIT + 1), "windowed");
  });

  test("md 的 Source 段不跑 markdown 渲染", () => {
    assert.equal(textRenderKind("markdown", "source", 1024), "plain");
    assert.equal(textRenderKind("markdown", "source", PREVIEW_WINDOW_LIMIT + 1), "windowed");
  });

  test("代码：高亮上限内走 shiki，超过上限的走窗口化原文", () => {
    assert.equal(textRenderKind("code", "rendered", 1), "highlight");
    assert.equal(textRenderKind("code", "rendered", PREVIEW_HIGHLIGHT_LIMIT), "highlight");
    assert.equal(textRenderKind("code", "rendered", PREVIEW_HIGHLIGHT_LIMIT + 1), "plain");
    assert.equal(textRenderKind("code", "rendered", PREVIEW_WINDOW_LIMIT + 1), "windowed");
  });

  test("阈值恰好卡在边界上：等于上限走完整渲染，多一个字才换路径", () => {
    assert.equal(textRenderKind("plain", "rendered", PREVIEW_WINDOW_LIMIT), "plain");
    assert.equal(textRenderKind("plain", "rendered", PREVIEW_WINDOW_LIMIT + 1), "windowed");
  });
});

describe("textLines", () => {
  test("按 \\n 切行，末尾换行保留成最后一个空行（与 <pre> 一致）", () => {
    assert.deepEqual(textLines("a\nb\n"), ["a", "b", ""]);
    assert.deepEqual(textLines(""), [""]);
    assert.deepEqual(textLines("one"), ["one"]);
  });
});

describe("textRows（窗口化的显示行：超长单行硬切）", () => {
  test("短行原样保留，行为与 textLines 一致（末尾换行的空行也在）", () => {
    assert.deepEqual(textRows("a\nb\n"), ["a", "b", ""]);
    assert.deepEqual(textRows(""), [""]);
    assert.deepEqual(textRows("one"), ["one"]);
  });

  test("恰好 4096 字符仍是一行，多一个字才切", () => {
    assert.equal(PREVIEW_ROW_CHARS, 4096);
    assert.deepEqual(textRows("x".repeat(PREVIEW_ROW_CHARS)), ["x".repeat(PREVIEW_ROW_CHARS)]);
    const over = textRows("x".repeat(PREVIEW_ROW_CHARS + 1));
    assert.equal(over.length, 2);
    assert.deepEqual(over.map((row) => row.length), [PREVIEW_ROW_CHARS, 1]);
  });

  test("10,000 字符的单行切成 3 条，最后一段长度正确，拼回去是原文", () => {
    const line = "ab".repeat(5_000);
    const rows = textRows(line);
    assert.equal(rows.length, Math.ceil(line.length / PREVIEW_ROW_CHARS));
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.length),
      [PREVIEW_ROW_CHARS, PREVIEW_ROW_CHARS, line.length - 2 * PREVIEW_ROW_CHARS],
    );
    assert.equal(rows.join(""), line);
  });

  test("多条长行：每条各自切，短行不受影响、不合并", () => {
    const rows = textRows(["short", "y".repeat(5_000), "tail"].join("\n"));
    assert.equal(rows.length, 1 + 2 + 1);
    assert.equal(rows[0], "short");
    assert.equal(rows[rows.length - 1], "tail");
    // 硬切只是显示分段：拼回去仍是原文（分段不插换行符，原换行已在切行时去掉）
    assert.equal(rows.join(""), "short" + "y".repeat(5_000) + "tail");
  });

  test("切分点落在代理对中间时不会劈开 emoji", () => {
    const line = "a".repeat(PREVIEW_ROW_CHARS - 1) + "😀" + "b";
    const rows = textRows(line);
    assert.equal(rows.length, 2);
    assert.equal(rows[0], "a".repeat(PREVIEW_ROW_CHARS - 1) + "😀");
    assert.equal(rows[1], "b");
    // 没有孤立代理码元
    for (const row of rows) {
      assert.equal(/^[\uD800-\uDBFF]$/.test(row), false);
      assert.equal(row.endsWith("\uD800"), false);
    }
  });

  test("可注入更小的上限（测试 / 将来调参用）", () => {
    assert.deepEqual(textRows("abcdef", 4), ["abcd", "ef"]);
    assert.deepEqual(textRows("abcd", 4), ["abcd"]);
  });

  test("窗口按显示行算：两条 8,192 字符的长行 = 4 条显示行", () => {
    const rows = textRows(["z".repeat(8_192), "z".repeat(8_192)].join("\n"));
    assert.equal(rows.length, 4);
    const w = textWindow(rows.length, 0, 600, 20);
    assert.equal(w.totalLines, 4);
    assert.equal(w.start, 0);
    assert.equal(w.end, 4);
    assert.equal(w.padTop + (w.end - w.start) + w.padBottom, 4);
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

describe("largeTextNotice", () => {
  const KB = 1024;
  const MB = KB * 1024;

  test("小文件没有提示条（各种形态都不弹）", () => {
    assert.equal(largeTextNotice("markdown", "rendered", 10 * KB, 10 * KB, en), null);
    assert.equal(largeTextNotice("code", "rendered", 10 * KB, 10 * KB, en), null);
    assert.equal(largeTextNotice("plain", "rendered", 10 * KB, 10 * KB, en), null);
    // md 恰好在上限上：仍走 MarkdownBlock，不提示
    assert.equal(largeTextNotice("markdown", "rendered", PREVIEW_MARKDOWN_LIMIT, PREVIEW_MARKDOWN_LIMIT, en), null);
  });

  test("md 退化两条路径都说「按纯文本显示」，体积用真实字节数", () => {
    const plain = en.files.largeTextPlain("100 KB");
    assert.equal(largeTextNotice("markdown", "rendered", 100 * KB, 100 * KB, en), plain);
    const windowed = en.files.largeTextPlain("1 MB");
    assert.equal(largeTextNotice("markdown", "rendered", MB, MB, en), windowed);
  });

  test("txt / 代码被窗口化时说「只渲染可见区」", () => {
    const notice = en.files.largeTextWindowed("600 KB");
    assert.equal(largeTextNotice("plain", "rendered", 600 * KB, 600 * KB, en), notice);
    assert.equal(largeTextNotice("code", "rendered", 600 * KB, 600 * KB, en), notice);
  });

  test("md 的 Source 是用户自己切的，不当退化提示", () => {
    assert.equal(largeTextNotice("markdown", "source", 100 * KB, 100 * KB, en), null);
    // 但窗口化照旧提示（源码模式下大文件也只渲染可见区）
    assert.equal(
      largeTextNotice("markdown", "source", MB, MB, en),
      en.files.largeTextWindowed("1 MB"),
    );
  });

  test("超过高亮上限但未到窗口化阈值的代码：只降级不提示（排版没变，仍是一整块）", () => {
    assert.equal(largeTextNotice("code", "rendered", PREVIEW_HIGHLIGHT_LIMIT + 1, PREVIEW_HIGHLIGHT_LIMIT + 1, en), null);
  });
});
