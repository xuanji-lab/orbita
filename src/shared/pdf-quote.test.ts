import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  citationsOfDetails,
  displayText,
  findQuote,
  indexPageText,
  newCitationId,
  normalizeQuote,
  sourceSpan,
  type PdfTextRun,
} from "./pdf-quote.ts";

/** 模拟 pdf.js 的条目：每行一个条目、行尾 hasEOL */
function lines(...rows: string[]): PdfTextRun[] {
  return rows.map((str) => ({ str, hasEOL: true }));
}

describe("normalizeQuote", () => {
  it("去空白与标点、小写、展开连字与全角", () => {
    assert.equal(normalizeQuote("The ﬁrst  Step,\n“quoted”"), "thefirststepquoted");
    assert.equal(normalizeQuote("ＡＢＣ１２３"), "abc123");
    assert.equal(normalizeQuote("双缓冲， 机制。"), "双缓冲机制");
  });
});

describe("findQuote", () => {
  const page1 = indexPageText(lines("Introduction", "We describe a new method."));
  const page2 = indexPageText(
    lines("The renderer uses double buf-", "fering to avoid tearing when the", "window is resized."),
  );
  const page3 = indexPageText(lines("本系统采用双缓冲机制，避免窗口", "缩放时出现撕裂。"));
  const pages = [page1, page2, page3];

  it("跨行 + 行尾断词：模型交来的整句能精确命中", () => {
    const hit = findQuote(pages, "uses double buffering to avoid tearing when the window is resized");
    assert.equal(hit.kind, "exact");
    if (hit.kind !== "exact") return;
    assert.equal(hit.page, 2);
    const span = sourceSpan(page2, hit.start, hit.end);
    assert.deepEqual(span, { startRun: 0, startOffset: 13, endRun: 2, endOffset: 17 });
  });

  it("中文跨行：提取工具在换行处插的空格不影响命中", () => {
    const hit = findQuote(pages, "避免窗口 缩放时出现撕裂");
    assert.equal(hit.kind, "exact");
    if (hit.kind === "exact") assert.equal(hit.page, 3);
  });

  it("中段改了几个字：首尾锚定判近似命中", () => {
    const hit = findQuote(pages, "The renderer uses double buffering to prevent tearing when the window is resized");
    assert.equal(hit.kind, "approximate");
    if (hit.kind === "approximate") assert.equal(hit.page, 2);
  });

  it("编出来的句子：not-found，开头对得上时给最近处", () => {
    const hit = findQuote(pages, "The renderer uses triple buffering exclusively on every platform");
    assert.equal(hit.kind, "not-found");
    if (hit.kind === "not-found") assert.equal(hit.nearest?.page, 2);
    const none = findQuote(pages, "completely unrelated sentence here");
    assert.deepEqual(none, { kind: "not-found", nearest: null });
  });

  it("过短的引文拒绝定位", () => {
    assert.deepEqual(findQuote(pages, "the"), { kind: "too-short" });
  });

  it("多处命中：取提示页那一处，并报出现次数", () => {
    const repeated = [indexPageText(lines("see the appendix")), indexPageText(lines("see the appendix"))];
    const hit = findQuote(repeated, "see the appendix", 2);
    assert.equal(hit.kind, "exact");
    if (hit.kind === "exact") {
      assert.equal(hit.page, 2);
      assert.equal(hit.occurrences, 2);
    }
  });

  it("提示页记错也照样找得到", () => {
    const hit = findQuote(pages, "We describe a new method", 3);
    assert.equal(hit.kind, "exact");
    if (hit.kind === "exact") assert.equal(hit.page, 1);
  });
});

describe("displayText", () => {
  it("英文换行补空格（行尾断词不补），中文换行不补", () => {
    const plain = lines("double buffering", "works");
    const plainIndex = indexPageText(plain);
    const plainHit = findQuote([plainIndex], "buffering works");
    if (plainHit.kind !== "exact") return assert.fail("应精确命中");
    const plainSpan = sourceSpan(plainIndex, plainHit.start, plainHit.end);
    if (plainSpan !== null) assert.equal(displayText(plain, plainSpan), "buffering works");
    const en = lines("double buf-", "fering works");
    const enIndex = indexPageText(en);
    const enHit = findQuote([enIndex], "double buffering works");
    assert.equal(enHit.kind, "exact");
    if (enHit.kind === "exact") {
      const span = sourceSpan(enIndex, enHit.start, enHit.end);
      assert.ok(span !== null);
      if (span !== null) assert.equal(displayText(en, span), "double buf-fering works");
    }
    const zh = lines("采用双缓冲机制，避免窗口", "缩放时出现撕裂。");
    const zhIndex = indexPageText(zh);
    const zhHit = findQuote([zhIndex], "避免窗口缩放时出现撕裂");
    if (zhHit.kind === "exact") {
      const span = sourceSpan(zhIndex, zhHit.start, zhHit.end);
      if (span !== null) assert.equal(displayText(zh, span), "避免窗口缩放时出现撕裂");
    } else {
      assert.fail("中文跨行应精确命中");
    }
  });

  it("连字与康熙部首折回正字，中文全角标点不动", () => {
    const runs = lines("当同⼀个⽂件被修改时，double buﬀering");
    const index = indexPageText(runs);
    const hit = findQuote([index], "当同一个文件被修改时，double buffering");
    if (hit.kind !== "exact") return assert.fail("应精确命中");
    const span = sourceSpan(index, hit.start, hit.end);
    if (span !== null) assert.equal(displayText(runs, span), "当同一个文件被修改时，double buffering");
  });

  it("命中区间不含首尾标点（标点不进归一化串）", () => {
    const runs = lines("“Hello, world.”");
    const index = indexPageText(runs);
    const hit = findQuote([index], "hello world");
    assert.equal(hit.kind, "exact");
    if (hit.kind === "exact") {
      const span = sourceSpan(index, hit.start, hit.end);
      if (span !== null) assert.equal(displayText(runs, span), "Hello, world");
    }
  });
});

describe("citation ids 与 details 校验", () => {
  it("编号形如 c + 3 位 base36", () => {
    assert.match(newCitationId(), /^c[a-z0-9]{3}$/);
    assert.equal(newCitationId(() => 0), "c000");
  });

  it("坏条目丢掉，好条目原样", () => {
    const good = { id: "c1a2", path: "/a.pdf", page: 3, start: 0, end: 5, text: "hello" };
    const parsed = citationsOfDetails({
      pdfCitations: [good, { ...good, id: "x" }, { ...good, page: 0 }, { ...good, end: 0 }, null],
    });
    assert.deepEqual(parsed, [good]);
    assert.deepEqual(citationsOfDetails(undefined), []);
    assert.deepEqual(citationsOfDetails({ pdfCitations: "nope" }), []);
  });
});
