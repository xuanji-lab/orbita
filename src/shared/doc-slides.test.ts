import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  insertPageAfter,
  isDeckText,
  NEW_DECK_TEXT,
  parseDeck,
  removePage,
  replacePage,
} from "./doc-slides.ts";

const FIVE = "---\nmarp: true\n---\n\n# 一\n\n---\n\n# 二\n正文\n\n---\n\n# 三\n\n---\n\n# 四\n\n---\n\n# 五\n";

describe("parseDeck —— 分页", () => {
  it("5 页 = 4 个分页符；front matter 不是页", () => {
    const deck = parseDeck(FIVE);
    assert.equal(deck.pages.length, 5);
    assert.equal(deck.head, "---\nmarp: true\n---");
    assert.deepEqual(
      deck.pages.map((page) => page.text.trim()),
      ["# 一", "# 二\n正文", "# 三", "# 四", "# 五"],
    );
  });

  it("行号是整份文件的 1 起行号，含两端", () => {
    const deck = parseDeck(FIVE);
    const lines = FIVE.split("\n");
    for (const page of deck.pages) {
      const body = lines.slice(page.startLine - 1, page.endLine).join("\n");
      assert.equal(body, page.text, `第 ${page.index + 1} 页`);
    }
    assert.deepEqual([deck.pages[1]?.startLine, deck.pages[1]?.endLine], [9, 10]);
  });

  it("没有 front matter 也行；文件末尾的结尾换行不算页内容、末页行号不多算一行", () => {
    const deck = parseDeck("# A\n\n---\n\n# B\n");
    assert.equal(deck.head, null);
    assert.equal(deck.pages.length, 2);
    assert.equal(deck.pages[1]?.text, "# B");
    assert.equal(deck.pages[1]?.endLine, 5);
  });

  it("围栏代码块里的 --- 不分页", () => {
    const text = "# A\n\n```yaml\na: 1\n---\nb: 2\n```\n\n---\n\n# B\n";
    assert.equal(parseDeck(text).pages.length, 2);
  });

  it("空白页算一页；整份只有空白 / 只有 front matter 才是 0 页", () => {
    assert.equal(parseDeck(NEW_DECK_TEXT).pages.length, 0);
    assert.equal(parseDeck("").pages.length, 0);
    assert.equal(parseDeck("\n\n").pages.length, 0);
    const trailing = parseDeck("# A\n\n---\n");
    assert.equal(trailing.pages.length, 2);
    assert.equal(trailing.pages[1]?.text, "");
    assert.equal(parseDeck("---\n---\n").pages.length, 3); // 不是 front matter（里面没有 key），是两条分隔线 = 三页（都空白）
  });

  it("文档首页以 --- 开头但里面不是 key: value，不当 front matter", () => {
    const deck = parseDeck("---\n# 标题\n---\n正文\n");
    assert.equal(deck.head, null);
  });

  it("CRLF 文件：行号与页数一致", () => {
    const deck = parseDeck("# A\r\n\r\n---\r\n\r\n# B\r\n");
    assert.equal(deck.pages.length, 2);
    assert.equal(deck.pages[1]?.text, "# B");
  });
});

describe("isDeckText", () => {
  it("front matter 里有 marp: true 才是演示文稿", () => {
    assert.equal(isDeckText(FIVE), true);
    assert.equal(isDeckText("---\ntitle: x\n---\n# a"), false);
    assert.equal(isDeckText("# 普通文档\n\n---\n\n还是普通文档"), false);
    assert.equal(isDeckText(NEW_DECK_TEXT), true);
  });
});

describe("页的增删改：只动那一页，其余逐字不变", () => {
  it("replacePage 只换第 3 页", () => {
    const next = replacePage(FIVE, 2, "# 三\n| 左 | 中 | 右 |");
    const before = parseDeck(FIVE).pages;
    const after = parseDeck(next).pages;
    assert.equal(after.length, 5);
    for (const i of [0, 1, 3, 4]) assert.equal(after[i]?.text, before[i]?.text, `第 ${i + 1} 页`);
    assert.equal(after[2]?.text, "# 三\n| 左 | 中 | 右 |");
  });

  it("用户在页里删光结尾换行，分隔线也不会被吃掉（页区间不含分隔线前的换行）", () => {
    const next = replacePage(FIVE, 1, "# 二改");
    assert.equal(parseDeck(next).pages.length, 5);
  });

  it("insertPageAfter：插在当前页后面，页数 +1，别的页不变", () => {
    const { text, index } = insertPageAfter(FIVE, 1);
    const pages = parseDeck(text).pages;
    assert.equal(pages.length, 6);
    assert.equal(index, 2);
    assert.equal(pages[2]?.text, "# ");
    assert.deepEqual(
      [0, 1, 3, 4, 5].map((i) => pages[i]?.text.trim()),
      ["# 一", "# 二\n正文", "# 三", "# 四", "# 五"],
    );
  });

  it("insertPageAfter：末页后面、空演示文稿里都行；新页区间指到新页文字", () => {
    const tail = insertPageAfter(FIVE, 4);
    assert.equal(parseDeck(tail.text).pages.length, 6);
    assert.equal(tail.text.slice(tail.from, tail.to), "# ");
    const empty = insertPageAfter(NEW_DECK_TEXT, null);
    assert.equal(parseDeck(empty.text).pages.length, 1);
    assert.equal(isDeckText(empty.text), true);
    assert.equal(empty.text.slice(empty.from, empty.to), "# ");
    const second = insertPageAfter(empty.text, 0);
    assert.equal(parseDeck(second.text).pages.length, 2);
  });

  it("removePage：首页 / 中间 / 末页 / 唯一一页", () => {
    for (const i of [0, 2, 4]) {
      const next = removePage(FIVE, i);
      const pages = parseDeck(next).pages;
      assert.equal(pages.length, 4, `删第 ${i + 1} 页`);
      const rest = parseDeck(FIVE).pages.filter((_, k) => k !== i);
      assert.deepEqual(pages.map((p) => p.text.trim()), rest.map((p) => p.text.trim()));
    }
    assert.equal(parseDeck(removePage(insertPageAfter(NEW_DECK_TEXT, null).text, 0)).pages.length, 0);
  });
});
