import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord } from "./session.ts";
import type { WrapupTurn } from "./wrapup.ts";
import {
  buildClosingScanPrompt,
  buildWrapupRevisePrompt,
  CLOSING_SCAN_HEAD,
  isClosingScanText,
  LEGACY_CLOSING_SCAN_PROMPT,
  parseWrapupRevise,
  parseWrapupScan,
  splitTurns,
  wrapupItemTotals,
} from "./wrapup-scan.ts";

const user = (id: string, text: string): SessionRecord => ({ id, role: "user", content: [{ type: "text", text }], timestamp: 0 });
const reply = (id: string): SessionRecord =>
  ({ id, role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0, status: "complete", stopReason: "stop", model: { provider: "p", id: "m" } }) as SessionRecord;
const mark = (id: string): SessionRecord => ({ role: "channel-mark", id, peerId: "c", messageId: "m", from: "child", kind: "done", timestamp: 0 });

const RANGE = { sinceTurn: 1, lastTurn: 5 };
const fence = (json: string) => "```json\n" + json + "\n```";

describe("splitTurns（第 n 轮的定义）", () => {
  test("第 n 条真人用户消息起、到下一条用户消息前；机器提问与它的回答不属于任何一轮", () => {
    const records = [
      user("u1", "修登录"),
      reply("a1"),
      reply("a2"),
      user("u2", "再看看注册"),
      reply("a3"),
      user("scan", buildClosingScanPrompt({ sinceTurn: 1, lastTurn: 2, turns: [] })),
      reply("a4"),
      user("u3", "接着做"),
      reply("a5"),
    ];
    const turns = splitTurns(records);
    assert.deepEqual(
      turns.map((t) => [t.n, t.userId, t.start, t.end]),
      [
        [1, "u1", 0, 3],
        [2, "u2", 3, 5],
        [3, "u3", 7, 9],
      ],
    );
    assert.equal(turns[0]?.preview, "修登录");
  });

  test("v1 的旧扫描 prompt 同样不是一轮", () => {
    const turns = splitTurns([user("u1", "a"), reply("a1"), user("scan", LEGACY_CLOSING_SCAN_PROMPT), reply("a2")]);
    assert.deepEqual(turns.map((t) => [t.userId, t.end]), [["u1", 2]]);
  });

  test("通道标记不切轮：子会话交回的消息算在它所在的那一轮里", () => {
    const turns = splitTurns([user("u1", "派个子会话"), reply("a1"), mark("m1"), reply("a2"), user("u2", "好")]);
    assert.deepEqual(turns.map((t) => [t.n, t.start, t.end]), [
      [1, 0, 4],
      [2, 4, 5],
    ]);
  });
});

describe("isClosingScanText", () => {
  test("v2 认首行标记，v1 认全文，普通消息不认", () => {
    assert.equal(isClosingScanText(buildClosingScanPrompt({ sinceTurn: 3, lastTurn: 9, turns: [] })), true);
    assert.equal(isClosingScanText(`  ${LEGACY_CLOSING_SCAN_PROMPT}\n`), true);
    assert.equal(isClosingScanText(`帮我看看 ${CLOSING_SCAN_HEAD}`), false);
    assert.equal(isClosingScanText("这个会话已经完成了。"), false);
  });
});

describe("buildClosingScanPrompt", () => {
  test("带轮次表与范围；自检规则与解析器的判定一一对应", () => {
    const prompt = buildClosingScanPrompt({
      sinceTurn: 4,
      lastTurn: 5,
      turns: [
        { n: 4, userId: "u4", preview: "查复现代码", usage: [] },
        { n: 5, userId: "u5", preview: "", usage: [] },
      ],
    });
    assert.ok(prompt.startsWith(CLOSING_SCAN_HEAD));
    assert.ok(prompt.includes("第 4 轮：查复现代码"));
    assert.ok(prompt.includes("第 5 轮：（没有文字，只有附件）"));
    for (const rule of ["合法 JSON", "title 和 turns", "4–5 之间", "互不重叠", "title 和 detail", "null"]) {
      assert.ok(prompt.includes(rule), `prompt 缺少自检规则：${rule}`);
    }
  });
});

describe("parseWrapupScan（严格：半残不进 UI）", () => {
  test("正常回答：两组都解出来；引导文字与多个块取第一个可解析的", () => {
    const answer = `好的：\n\n${fence('{"done": [{"title": "修好登录", "turns": [1, 2]}, {"title": "改文案", "turns": [4, 4]}], "carryovers": [{"title": "补测试", "detail": "说了要补"}]}')}\n\n${fence('{"done": [], "carryovers": []}')}`;
    assert.deepEqual(parseWrapupScan(answer, RANGE), {
      done: [
        { title: "修好登录", detail: "", turns: [1, 2] },
        { title: "改文案", detail: "", turns: [4, 4] },
      ],
      left: [{ title: "补测试", detail: "说了要补", turns: null }],
    });
  });

  test("两组都空是合法答案", () => {
    assert.deepEqual(parseWrapupScan(fence('{"done": [], "carryovers": []}'), RANGE), { done: [], left: [] });
  });

  test("轮号越界 / 起 > 止 / 不是整数 / 重叠 → null", () => {
    for (const turns of ["[0, 1]", "[2, 6]", "[3, 2]", "[1.5, 2]", '"1-2"']) {
      assert.equal(parseWrapupScan(fence(`{"done": [{"title": "x", "turns": ${turns}}], "carryovers": []}`), RANGE), null, turns);
    }
    assert.equal(
      parseWrapupScan(fence('{"done": [{"title": "a", "turns": [1, 3]}, {"title": "b", "turns": [3, 4]}], "carryovers": []}'), RANGE),
      null,
    );
  });

  test("缺键、多键、空标题、旧版只有 carryovers → null", () => {
    assert.equal(parseWrapupScan(fence('{"carryovers": []}'), RANGE), null);
    assert.equal(parseWrapupScan(fence('{"done": [{"title": "x", "turns": [1, 1], "why": "?"}], "carryovers": []}'), RANGE), null);
    assert.equal(parseWrapupScan(fence('{"done": [{"title": " ", "turns": [1, 1]}], "carryovers": []}'), RANGE), null);
    assert.equal(parseWrapupScan(fence('{"done": [], "carryovers": [{"title": "x"}]}'), RANGE), null);
    assert.equal(parseWrapupScan(fence('{"done": [], "carryovers": [}'), RANGE), null);
    assert.equal(parseWrapupScan("没有围栏", RANGE), null);
  });
});

describe("按反馈改写", () => {
  const draft = {
    done: [
      { title: "找复现代码", detail: "", turns: [1, 2] as [number, number] },
      { title: "核对口径", detail: "", turns: [3, 4] as [number, number] },
    ],
    left: [{ title: "查分数", detail: "没去 runs/ 查", turns: null }],
  };

  test("prompt 带轮次表、当前清单与用户原话", () => {
    const prompt = buildWrapupRevisePrompt({
      turns: [{ n: 1, preview: "查代码" }],
      sinceTurn: 1,
      lastTurn: 5,
      draft,
      feedback: " 1 和 2 是一件事 ",
    });
    assert.ok(prompt.includes("第 1 轮：查代码"));
    assert.ok(prompt.includes('"title": "核对口径"'));
    assert.ok(prompt.includes("用户说：1 和 2 是一件事"));
    for (const tag of ["merged", "moved-to-left", "moved-to-done", "added", "edited"]) assert.ok(prompt.includes(tag));
  });

  test("回答解析：change 标签、挪过去的留下的事带轮次", () => {
    const answer = fence(
      '{"summary": "1、2 合成一件；查聊天记录挪到留下的事", "done": [{"title": "找代码并核对口径", "turns": [1, 4], "change": "merged"}], "carryovers": [{"title": "查聊天记录", "detail": "没查到", "turns": [5, 5], "change": "moved-to-left"}, {"title": "查分数", "detail": "没去 runs/ 查", "turns": null}]}',
    );
    assert.deepEqual(parseWrapupRevise(answer, RANGE), {
      summary: "1、2 合成一件；查聊天记录挪到留下的事",
      draft: {
        done: [{ title: "找代码并核对口径", detail: "", turns: [1, 4], change: "merged" }],
        left: [
          { title: "查聊天记录", detail: "没查到", turns: [5, 5], change: "moved-to-left" },
          { title: "查分数", detail: "没去 runs/ 查", turns: null },
        ],
      },
    });
  });

  test("未知标签 / 缺 summary / 轮号越界 → null", () => {
    assert.equal(parseWrapupRevise(fence('{"summary": "x", "done": [{"title": "a", "turns": [1, 1], "change": "split"}], "carryovers": []}'), RANGE), null);
    assert.equal(parseWrapupRevise(fence('{"done": [], "carryovers": []}'), RANGE), null);
    assert.equal(parseWrapupRevise(fence('{"summary": "x", "done": [], "carryovers": [{"title": "a", "detail": "", "turns": [9, 9]}]}'), RANGE), null);
  });
});

describe("wrapupItemTotals（花费算给 token 最多的型号 × 档）", () => {
  const usage = (modelId: string, level: "high" | "medium", total: number, cost: number | null) => ({
    providerId: "p",
    modelId,
    level,
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0 },
    recordedCost: cost ?? 0,
    unpricedTokens: { input: cost === null ? total : 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    officialCost: cost,
  });
  const turns: WrapupTurn[] = [
    { n: 1, userId: "u1", preview: "", usage: [usage("opus", "high", 100, 1)] },
    { n: 2, userId: "u2", preview: "", usage: [usage("flash", "medium", 300, 0.1), usage("opus", "high", 150, 1.5)] },
    { n: 3, userId: "u3", preview: "", usage: [usage("flash", "medium", 50, null)] },
  ];

  test("合计这几轮，归属看各「型号 × 档」的 token 合计（opus 250 < flash 300）", () => {
    const totals = wrapupItemTotals(turns, [1, 2]);
    assert.equal(totals.modelId, "flash");
    assert.equal(totals.level, "medium");
    assert.equal(totals.tokens.input, 550);
    assert.equal(totals.recordedCost, 2.6);
    assert.equal(totals.officialCost, 2.6);
  });

  test("有一段折不出官方价 → officialCost null；没有轮次 → 没有归属", () => {
    assert.equal(wrapupItemTotals(turns, [2, 3]).officialCost, null);
    const none = wrapupItemTotals(turns, null);
    assert.equal(none.modelId, null);
    assert.equal(none.tokens.input, 0);
  });
});
