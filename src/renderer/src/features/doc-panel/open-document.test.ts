import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TextQuote } from "../../../../shared/quote.ts";
import { contextAround } from "../../../../shared/quote-anchor.ts";
import { getOpenDocumentText, rememberDocText, setOpenDocument, resolveQuotes } from "./open-document.ts";
import { clearTrackedStore, saveTracked } from "./quote-track.ts";

const S = "重复句：这一句会出现好几次。";
const BEFORE = `开头一段。\n\n${S}\n\n结尾一段。\n`;
const AFTER = `开头一段。\n\n${S}\n\n${S}\n\n结尾一段。\n`; // 紧贴原句行首复制了一句，原句挤到第 5 行

function quote(anchor: string): TextQuote {
  const at = BEFORE.indexOf(S);
  return { text: S, messageId: "", role: "user", filePath: "/ws/a.md", lines: { from: 3, to: 3 }, context: contextAround(BEFORE, at, at + S.length), anchor };
}

describe("resolveQuotes（N2）", () => {
  it("面板开着：用编辑器追踪的区间", () => {
    const from = AFTER.lastIndexOf(S);
    setOpenDocument({ path: "/ws/a.md", kind: "doc" }, { text: () => AFTER, trackedRange: () => ({ from, to: from + S.length }) });
    const [resolved] = resolveQuotes([quote("q1")]);
    assert.deepEqual(resolved?.lines, { from: 5, to: 5 });
    setOpenDocument(null);
  });

  it("面板关着时发送：用卸载时存下的全文与区间，不再拿划选时的行号发（原先会改到复制句）", () => {
    clearTrackedStore();
    const from = AFTER.lastIndexOf(S);
    saveTracked("/ws/a.md", { text: AFTER, ranges: { q2: { from, to: from + S.length } } });
    setOpenDocument(null);
    const [resolved] = resolveQuotes([quote("q2")]);
    assert.deepEqual(resolved?.lines, { from: 5, to: 5 });
    assert.deepEqual(resolved?.occurrence, { index: 2, of: 2 });
  });

  it("面板关着、也没有存过：原样（没有任何依据可重算）；聊天引用不动", () => {
    clearTrackedStore();
    const q = quote("q3");
    const chat: TextQuote = { text: "x", messageId: "m", role: "assistant" };
    assert.deepEqual(resolveQuotes([q, chat]), [q, chat]);
  });
});

describe("过程行回溯「改在哪一节」用的文档全文", () => {
  it("开着的文档取实时全文；关了以后退回最近看过的；没看过 = null；只留最近 6 份", () => {
    setOpenDocument(null);
    assert.equal(getOpenDocumentText("/w/没看过.md"), null);
    rememberDocText("/w/a.md", "旧文本");
    assert.equal(getOpenDocumentText("/w/a.md"), "旧文本");
    // 开着：实时全文优先于记的那份
    setOpenDocument({ path: "/w/a.md", kind: "doc" }, { text: () => "实时文本", trackedRange: () => null });
    assert.equal(getOpenDocumentText("/w/a.md"), "实时文本");
    setOpenDocument(null);
    assert.equal(getOpenDocumentText("/w/a.md"), "旧文本");
    // 淘汰：再记 6 份，最早的 a.md 出局
    for (let i = 0; i < 6; i += 1) rememberDocText(`/w/n${i}.md`, `文本${i}`);
    assert.equal(getOpenDocumentText("/w/a.md"), null);
    assert.equal(getOpenDocumentText("/w/n5.md"), "文本5");
  });
});

