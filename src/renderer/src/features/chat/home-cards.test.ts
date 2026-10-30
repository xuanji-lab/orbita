import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { Carryover, SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import {
  HOME_CARD_CARRYOVER_ROWS,
  HOME_CARD_QUERY_ROWS,
  homeCardLine,
  selectHomeCards,
  type HomeCardLineText,
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
  origin: "wrapup",
  anchor: null,
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

describe("selectHomeCards —— 要你注意的先占卡（原型：等你 > 出错 > 在跑 > 最近）", () => {
  const sessions = [
    meta({ id: "recent", updatedAt: 50 }),
    meta({ id: "todo", updatedAt: 40 }),
    meta({ id: "run", updatedAt: 30 }),
    meta({ id: "fail", updatedAt: 20 }),
    meta({ id: "wait", updatedAt: 10 }),
  ];
  const states: Record<string, SessionRunState> = { run: "running", fail: "failed", wait: "waiting" };
  const stateOf = (m: SessionMeta): SessionRunState => states[m.id] ?? null;

  test("等你 > 出错 > 在跑，压过遗留与最近", () => {
    const cards = selectHomeCards(sessions, [todo("t1", "todo", "收尾")], stateOf);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["wait", "fail", "run"],
    );
  });

  test("要注意的不满三张：其余照旧——先遗留，再最近", () => {
    const cards = selectHomeCards(sessions, [todo("t1", "todo", "收尾")], (m) => (m.id === "run" ? "running" : null));
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["run", "todo", "recent"],
    );
  });

  test("跑完没看不算要注意（它在「最近」里排）；不给 stateOf 就是旧口径", () => {
    const done = selectHomeCards(sessions, [], (m) => (m.id === "wait" ? "done" : null));
    assert.deepEqual(
      done.map((card) => card.sessionId),
      ["recent", "todo", "run"],
    );
    assert.deepEqual(
      selectHomeCards(sessions, []).map((card) => card.sessionId),
      ["recent", "todo", "run"],
    );
  });
});

describe("homeCardLine —— 卡上「此刻在干什么」那一句", () => {
  const text: HomeCardLineText = {
    thinking: "在想",
    doing: (step, now) => `${step}：${now}`,
    approve: (what) => `等你批准：${what}`,
    childWaiting: "子会话在等你批准",
    failed: "出错停下了",
    done: "跑完了",
    verb: (toolName) => toolName,
  };
  const user = (id: string, timestamp: number, body = "hi"): TranscriptItem =>
    ({ id, role: "user", content: [{ type: "text", text: body }], timestamp }) as TranscriptItem;
  const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
    ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
  const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
    ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
  const base = { approval: null, turnError: null, lastAsk: "上次问的" } as const;

  test("在跑：当前章节（agent 刚说的话）；有计划在做的那一步时带在前面", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [
        { type: "text", text: "先读代码。" },
        { type: "toolCall", toolCallId: "p1", toolName: "update_plan", input: {} },
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
      ]),
      tool({
        toolCallId: "p1",
        toolName: "update_plan",
        input: { items: [{ text: "读代码", status: "in_progress" }, { text: "改", status: "pending" }] } as never,
        timestamp: 2001,
      }),
      tool({ toolCallId: "r1", timestamp: 2100 }),
      assistant("a2", 3000, [
        { type: "text", text: "`a.ts` 里没有，换个地方找。" },
        { type: "toolCall", toolCallId: "g1", toolName: "grep", input: { pattern: "x" } },
      ]),
    ];
    assert.equal(homeCardLine({ ...base, state: "running", records }, text), "读代码：`a.ts` 里没有，换个地方找。");
  });

  test("在跑但还没说话：正在跑的工具（动词 + 对象）；什么都没有是「在想」；槽没载过也是「在想」", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "bun test" } }]),
    ];
    assert.equal(homeCardLine({ ...base, state: "running", records }, text), "bash bun test");
    assert.equal(homeCardLine({ ...base, state: "running", records: [user("u1", 1000)] }, text), "在想");
    assert.equal(homeCardLine({ ...base, state: "running", records: null }, text), "在想");
  });

  test("只看最后一轮：上一轮的章节不串进这一轮", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "text", text: "上一轮的话" }, { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } }]),
      tool({ toolCallId: "r1", timestamp: 2100 }),
      assistant("a2", 2200, [{ type: "text", text: "答完了" }]),
      user("u2", 3000),
    ];
    assert.equal(homeCardLine({ ...base, state: "running", records }, text), "在想");
  });

  test("等你：挂着的审批要做什么；自己没有审批（子会话在等）另一句", () => {
    const approval = { toolName: "bash", input: { command: "git push origin main" } };
    assert.equal(homeCardLine({ ...base, state: "waiting", records: null, approval }, text), "等你批准：bash git push origin main");
    assert.equal(homeCardLine({ ...base, state: "waiting", records: null }, text), "子会话在等你批准");
  });

  test("出错：错误原文第一行；没有原文（重启后只剩未读标记）说出错停下了", () => {
    assert.equal(homeCardLine({ ...base, state: "failed", records: null, turnError: "网络中断\n重试 3 次" }, text), "网络中断");
    assert.equal(homeCardLine({ ...base, state: "failed", records: null }, text), "出错停下了");
  });

  test("跑完没看：最后一段正文的第一行；槽没载过说跑完了", () => {
    const records = [user("u1", 1000), assistant("a1", 2000, [{ type: "text", text: "## 改好了\n细节……" }])];
    assert.equal(homeCardLine({ ...base, state: "done", records }, text), "改好了");
    assert.equal(homeCardLine({ ...base, state: "done", records: null }, text), "跑完了");
  });

  test("没在跑：最近一次提问；没有提问（老会话）是 null", () => {
    assert.equal(homeCardLine({ ...base, state: null, records: null }, text), "上次问的");
    assert.equal(homeCardLine({ ...base, state: null, records: null, lastAsk: null }, text), null);
  });
});
