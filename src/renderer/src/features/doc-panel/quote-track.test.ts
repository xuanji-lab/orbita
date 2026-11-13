import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { quoteTrackField, quoteTracker, trackRange } from "./quote-track.ts";

const SENTENCE = "重复句：这一句会出现两次。";
const DOC = `# 标题\n\n第一段。\n\n${SENTENCE}\n\n结尾一段。\n`;

function track(doc: string, needle: string): { state: EditorState; from: number; to: number } {
  const from = doc.indexOf(needle);
  const to = from + needle.length;
  const state = EditorState.create({ doc, extensions: [quoteTracker()] }).update({ effects: trackRange.of({ id: "a", from, to }) }).state;
  return { state, from, to };
}

const rangeOf = (state: EditorState) => state.field(quoteTrackField).get("a");

describe("引用位置追踪（M3）", () => {
  it("被引用的原句上方「紧贴」着复制出一模一样的一句：追踪的仍是原句（上下文比对分不出的那种）", () => {
    const { state, from } = track(DOC, SENTENCE);
    // 在原句行首插入「复制句 + 空行」（插入点 == 区间起点）
    const after = state.update({ changes: { from, insert: `${SENTENCE}\n\n` } }).state;
    const range = rangeOf(after)!;
    assert.equal(after.doc.sliceString(range.from, range.to), SENTENCE);
    assert.equal(range.from, from + SENTENCE.length + 2, "起点被推到插入文字之后 = 原句");
    // 复制句在上、原句在下
    assert.equal(after.doc.toString().indexOf(SENTENCE), from);
  });

  it("在上方插入别的内容：区间整体后移；在区间末尾追加：不吞进去", () => {
    const { state, from, to } = track(DOC, SENTENCE);
    const a = state.update({ changes: { from: 0, insert: "新增\n\n" } }).state;
    assert.deepEqual([rangeOf(a)!.from, rangeOf(a)!.to], [from + 4, to + 4]);
    const b = state.update({ changes: { from: to, insert: "（追加）" } }).state;
    assert.equal(b.doc.sliceString(rangeOf(b)!.from, rangeOf(b)!.to), SENTENCE);
  });

  it("区间里的字被改过：追踪到的文字与原文不再相等，调用方据此退回上下文定位", () => {
    const { state, from } = track(DOC, SENTENCE);
    const after = state.update({ changes: { from: from + 3, to: from + 5, insert: "XX" } }).state;
    const r = rangeOf(after)!;
    assert.notEqual(after.doc.sliceString(r.from, r.to), SENTENCE);
  });

  it("整句被删掉：区间塌成一个点", () => {
    const { state, from, to } = track(DOC, SENTENCE);
    const after = state.update({ changes: { from, to, insert: "" } }).state;
    const r = rangeOf(after)!;
    assert.equal(r.from, r.to);
  });
});

describe("面板卸载后追踪不丢（N2）", () => {
  it("存 → 取：区间原样还在；盘上在关面板期间被 agent 改过，按差异映射过去", async () => {
    const { saveTracked, loadTracked, mapRanges, clearTrackedStore, newAnchorId } = await import("./quote-track.ts");
    clearTrackedStore();
    const { state, from, to } = track(DOC, SENTENCE);
    // 用户在原句行首紧贴着打了一模一样的一句（追踪把区间推到原句上）
    const after = state.update({ changes: { from, insert: `${SENTENCE}\n\n` } }).state;
    const range = after.field(quoteTrackField).get("a")!;
    saveTracked("/ws/a.md", { text: after.doc.toString(), ranges: { a: { from: range.from, to: range.to } } });
    // ——面板卸载，编辑器没了——
    const saved = loadTracked("/ws/a.md")!;
    const text = saved.text;
    assert.equal(text.slice(saved.ranges["a"]!.from, saved.ranges["a"]!.to), SENTENCE);
    // 重新打开、盘上没变：原样
    assert.deepEqual(mapRanges(text, text, saved.ranges), saved.ranges);
    // 期间 agent 在文首加了一段：区间整体后移，仍是原句（第二处，不是复制句）
    const edited = `agent 加的一段\n\n${text}`;
    const mapped = mapRanges(text, edited, saved.ranges)["a"]!;
    assert.equal(edited.slice(mapped.from, mapped.to), SENTENCE);
    assert.equal(mapped.from, edited.lastIndexOf(SENTENCE));
    assert.notEqual(newAnchorId(), newAnchorId());
    void to;
  });

  it("没有区间就不占位；超出份数上限丢最早的", async () => {
    const { saveTracked, loadTracked, clearTrackedStore } = await import("./quote-track.ts");
    clearTrackedStore();
    saveTracked("/e.md", { text: "x", ranges: {} });
    assert.equal(loadTracked("/e.md"), null);
    for (let i = 0; i < 25; i += 1) saveTracked(`/f${i}.md`, { text: "x", ranges: { a: { from: 0, to: 1 } } });
    assert.equal(loadTracked("/f0.md"), null);
    assert.notEqual(loadTracked("/f24.md"), null);
  });
});
