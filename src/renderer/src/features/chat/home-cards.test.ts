import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Carryover, SessionMeta } from "@shared/session";
import {
  HOME_CARD_CARRYOVER_ROWS,
  HOME_CARD_QUERY_ROWS,
  selectHomeCards,
} from "./home-cards.ts";

/** 构造一条最小合法 SessionMeta：default 不写的字段与首页选卡无关 */
const meta = (over: { id: string; updatedAt: number } & Partial<SessionMeta>): SessionMeta => ({
  title: `Task ${over.id}`,
  titleSource: "derived",
  cwd: "/tmp",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 0,
  ...over,
});

/** 构造一条最小合法 Carryover */
const todo = (
  id: string,
  sourceSessionId: string,
  title: string,
  status: Carryover["status"] = "open",
): Carryover => ({
  id,
  title,
  detail: "",
  sourceSessionId,
  sourceMessageRange: null,
  status,
  createdAt: 0,
  doneAt: null,
});

/** 行文本速取 */
const texts = (rows: readonly { text: string }[]): string[] => rows.map((row) => row.text);

describe("selectHomeCards", () => {
  test("无 carryover 时与现状规则完全一致（filter + slice(0,3)，行位吃 recentQueries）", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 30, recentQueries: ["q1", "q2", "q3"] }),
      meta({ id: "b", updatedAt: 20, recentQueries: ["q4"] }),
      meta({ id: "c", updatedAt: 10 }),
      meta({ id: "d", updatedAt: 5, recentQueries: ["q5"] }),
    ];
    const cards = selectHomeCards(sessions, []);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["a", "b", "c"],
    );
    assert.ok(cards.every((card) => card.todo === false));
    assert.deepEqual(texts(cards[0]!.rows), ["q1", "q2", "q3"]);
    assert.deepEqual(texts(cards[1]!.rows), ["q4"]);
    assert.deepEqual(cards[2]!.rows, []);
    // 行位种类是 query，上限与现状三槽一致
    assert.ok(cards[0]!.rows.every((row) => row.kind === "query"));
    assert.equal(cards[0]!.rows.length, HOME_CARD_QUERY_ROWS);
  });

  test("有 open carryover 的会话优先占卡，多条待办会话之间按 updatedAt 新→旧", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 30 }),
      meta({ id: "b", updatedAt: 20 }),
      meta({ id: "c", updatedAt: 10 }),
      meta({ id: "d", updatedAt: 5 }),
    ];
    const carryovers = [
      todo("t1", "c", "c 的遗留"),
      todo("t2", "b", "b 的遗留"),
      // done 不算「还有事」：不能让办结的事项把会话抬上卡
      todo("t3", "a", "a 的旧账", "done"),
    ];
    const cards = selectHomeCards(sessions, carryovers);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["b", "c", "a"],
    );
    assert.equal(cards[0]!.todo, true);
    assert.deepEqual(texts(cards[0]!.rows), ["b 的遗留"]);
    assert.equal(cards[2]!.todo, false);
  });

  test("归档与空标题会话仍排除，即使有 open carryover", () => {
    const sessions = [
      meta({ id: "archived", updatedAt: 40, archived: true }),
      meta({ id: "untitled", updatedAt: 35, title: "" }),
      meta({ id: "normal", updatedAt: 30 }),
      meta({ id: "filler", updatedAt: 20 }),
    ];
    const carryovers = [
      todo("t1", "archived", "归档会话的遗留"),
      todo("t2", "untitled", "空标题会话的遗留"),
      todo("t3", "normal", "正常会话的遗留"),
    ];
    const cards = selectHomeCards(sessions, carryovers);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["normal", "filler"],
    );
    assert.equal(cards[0]!.todo, true);
    assert.equal(cards[1]!.todo, false);
  });

  test("子会话不进首页卡，即使它最活跃、有 open carryover（子会话 PR4c 2.3）", () => {
    const sessions = [
      meta({ id: "child", updatedAt: 99, parentId: "root-a" }),
      meta({ id: "root-a", updatedAt: 30 }),
      meta({ id: "root-b", updatedAt: 20 }),
    ];
    const carryovers = [todo("t1", "child", "子会话的遗留")];
    const cards = selectHomeCards(sessions, carryovers);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["root-a", "root-b"],
    );
    // 子会话没进卡，它名下的 carryover 也就没让任何一张卡变成待办卡
    assert.ok(cards.every((card) => card.todo === false));
  });

  test("单卡超过 4 条 open carryover 截断到 4 行，不做「等 N 项」", () => {
    const sessions = [meta({ id: "a", updatedAt: 30 })];
    const carryovers = ["t1", "t2", "t3", "t4", "t5"].map((id, index) =>
      todo(id, "a", `遗留 ${index + 1}`),
    );
    const cards = selectHomeCards(sessions, carryovers);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.rows.length, HOME_CARD_CARRYOVER_ROWS);
    // 截断保前 4 条（存储序，与侧栏面板同序），第 5 条不出现、也没有溢出标记行
    assert.deepEqual(texts(cards[0]!.rows), ["遗留 1", "遗留 2", "遗留 3", "遗留 4"]);
    assert.ok(cards[0]!.rows.every((row) => row.kind === "carryover"));
  });

  test("待办会话不足 3 张时，剩余槽位按最近活跃规则补齐", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 50 }),
      meta({ id: "b", updatedAt: 40 }),
      meta({ id: "c", updatedAt: 30 }),
      meta({ id: "d", updatedAt: 20 }),
    ];
    const carryovers = [todo("t1", "d", "d 的遗留")];
    const cards = selectHomeCards(sessions, carryovers);
    // d 最旧但有待办 → 占首卡；a、b 按活跃序补齐；c 挤出卡外
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["d", "a", "b"],
    );
    assert.deepEqual(texts(cards[0]!.rows), ["d 的遗留"]);
    assert.equal(cards[1]!.todo, false);
  });

  // 实验开关关闭时 ChatView 传空遗留清单（见 ChatView 的 homeCards）：这里把
  // 契约钉住——盘上再多的 open 遗留也不出待办卡，全部退回「最近提问」行位
  test("遗留清单为空（实验开关关闭）：不出待办卡，行位全部退回最近提问", () => {
    const sessions = [meta({ id: "a", updatedAt: 50, recentQueries: ["问 a"] })];
    const cards = selectHomeCards(sessions, []);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.todo, false);
    assert.ok(cards[0]!.rows.every((row) => row.kind === "query"));
    assert.deepEqual(texts(cards[0]!.rows), ["问 a"]);
  });
});
