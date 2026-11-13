import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { planChangeText, planNoticeText } from "./plan-text.ts";

describe("计划改动文案：提前与等待", () => {
  const moved = { kind: "moved" as const, text: "DDPM 立场表", before: "每日一篇", earlier: true };
  const waiting = { kind: "waiting" as const, text: "每日一篇", waitingFor: "等你改权限" };

  test("往前提：「把 X 提到 Y 前面」；往后挪、挪到最后仍是原来的说法", () => {
    assert.equal(planChangeText(zh, moved), "把「DDPM 立场表」提到「每日一篇」前面");
    assert.equal(planChangeText(en, moved), 'moved "DDPM 立场表" up, before "每日一篇"');
    assert.equal(planChangeText(zh, { ...moved, earlier: false }), "「DDPM 立场表」挪到「每日一篇」前面");
    assert.equal(planChangeText(zh, { ...moved, before: null, earlier: false }), "「DDPM 立场表」挪到了最后");
  });

  test("在等：带 waitingFor 写原话，没写写「在等你」", () => {
    assert.equal(planChangeText(zh, waiting), "「每日一篇」：等你改权限");
    assert.equal(planChangeText(zh, { ...waiting, waitingFor: null }), "「每日一篇」在等你");
    assert.equal(planChangeText(en, { ...waiting, waitingFor: null }), '"每日一篇" is waiting on you');
    assert.equal(planChangeText(en, waiting), '"每日一篇" is waiting: 等你改权限');
  });

  test("对话里那一行：提前 + 等待合成一条，带理由", () => {
    assert.equal(
      planNoticeText(zh, { changes: [moved, waiting], why: "你说先做这条" }),
      "计划改了 2 处：把「DDPM 立场表」提到「每日一篇」前面等——你说先做这条",
    );
    assert.equal(planNoticeText(zh, { changes: [waiting], why: null }), "计划改了：「每日一篇」：等你改权限");
  });
});
