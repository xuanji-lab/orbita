import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginBoardInfo } from "../../../../shared/plugin-board.ts";
import type { PluginPanelUnavailable } from "../../../../shared/plugin-panel.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import type { BoardCardView } from "./board-card.ts";
import { boardRows, boardUnavailableText } from "./board-view.ts";

const decl = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, size: "1x1" as const, note: null, template: "./t.html", data: null, sample: null, repeat: null, ...extra });
const board: PluginBoardInfo = { title: "t", spec: null, cards: [decl("today", { size: "2x1", note: "标题 · 理由" }), decl("paper", { repeat: "items" })] };
const live = (id: string, index: number, usingSample: boolean): BoardCardView => ({
  key: `${id}#${index}`,
  id,
  title: id,
  size: "1x1",
  index,
  frameUrl: "u",
  frameKey: 1,
  brokenProblems: null,
  shown: { kind: "empty" },
  problem: null,
  usingSample,
});

describe("boardRows", () => {
  test("每张声明一行，名字 / 尺寸 / 备注取自声明；还没读到活卡时不标样例", () => {
    const rows = boardRows(board, []);
    assert.deepEqual(rows.map((row) => [row.id, row.size, row.note, row.usingSample]), [["today", "2x1", "标题 · 理由", false], ["paper", "1x1", null, false]]);
  });

  test("repeat 展开的多张卡合成一行；有一张用样例就标样例", () => {
    const rows = boardRows(board, [live("paper", 0, false), live("paper", 1, true), live("today", 0, false)]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.usingSample, false);
    assert.equal(rows[1]?.usingSample, true);
  });
});

describe("boardUnavailableText", () => {
  test("每一种原因两种语言都有一句话", () => {
    const reasons: PluginPanelUnavailable[] = ["not-installed", "not-enabled", "no-board", "not-found", "outside-workspace"];
    for (const messages of [en, zh]) for (const reason of reasons) assert.ok(boardUnavailableText(messages.pluginPanel, reason).length > 6, reason);
  });
});
