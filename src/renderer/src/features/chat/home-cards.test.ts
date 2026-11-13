import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@shared/transcript";
import type { Carryover, SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import {
  HOME_CARD_QUERY_ROWS,
  homeCardLine,
  selectHomeCards,
  selectHomeLog,
  visibleAsk,
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

/** 行文本速取 */
const texts = (rows: readonly { text: string }[]): string[] => rows.map((row) => row.text);

describe("selectHomeCards", () => {
  test("按最近活跃取三张，行位吃 recentQueries（最多 3 条）", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 30, recentQueries: ["q1", "q2", "q3"] }),
      meta({ id: "b", updatedAt: 20, recentQueries: ["q4"] }),
      meta({ id: "c", updatedAt: 10 }),
      meta({ id: "d", updatedAt: 5, recentQueries: ["q5"] }),
    ];
    const cards = selectHomeCards(sessions);
    assert.deepEqual(
      cards.map((card) => card.sessionId),
      ["a", "b", "c"],
    );
    assert.deepEqual(texts(cards[0]!.rows), ["q1", "q2", "q3"]);
    assert.deepEqual(texts(cards[1]!.rows), ["q4"]);
    assert.deepEqual(cards[2]!.rows, []);
    assert.equal(cards[0]!.rows.length, HOME_CARD_QUERY_ROWS);
  });

  test("归档与空标题会话排除", () => {
    const sessions = [
      meta({ id: "archived", updatedAt: 40, archived: true }),
      meta({ id: "untitled", updatedAt: 35, title: "" }),
      meta({ id: "normal", updatedAt: 30 }),
      meta({ id: "filler", updatedAt: 20 }),
    ];
    assert.deepEqual(
      selectHomeCards(sessions).map((card) => card.sessionId),
      ["normal", "filler"],
    );
  });

  test("子会话不进首页卡，即使它最活跃（子会话 PR4c 2.3）", () => {
    const sessions = [
      meta({ id: "child", updatedAt: 99, parentId: "root-a" }),
      meta({ id: "root-a", updatedAt: 30 }),
      meta({ id: "root-b", updatedAt: 20 }),
    ];
    assert.deepEqual(
      selectHomeCards(sessions).map((card) => card.sessionId),
      ["root-a", "root-b"],
    );
  });

  test("遗留事项不再让位：旧会话身上挂多少遗留，都不抬它上卡（2026-10-30 推翻 2026-09-22 的优先占卡）", () => {
    const sessions = [
      meta({ id: "a", updatedAt: 50 }),
      meta({ id: "b", updatedAt: 40 }),
      meta({ id: "c", updatedAt: 30 }),
      meta({ id: "d", updatedAt: 20, recentQueries: ["问 d"] }),
    ];
    // selectHomeCards 已不接收遗留清单——类型上就不可能让位；这里钉住最旧的 d 没有被抬上来
    assert.deepEqual(
      selectHomeCards(sessions).map((card) => card.sessionId),
      ["a", "b", "c"],
    );
  });
});

describe("selectHomeCards —— 要你注意的先占卡（原型：等你 > 出错 > 在跑 > 最近）", () => {
  const sessions = [
    meta({ id: "recent", updatedAt: 50 }),
    meta({ id: "idle", updatedAt: 40 }),
    meta({ id: "run", updatedAt: 30 }),
    meta({ id: "fail", updatedAt: 20 }),
    meta({ id: "wait", updatedAt: 10 }),
  ];
  const states: Record<string, SessionRunState> = { run: "running", fail: "failed", wait: "waiting" };
  const stateOf = (m: SessionMeta): SessionRunState => states[m.id] ?? null;

  test("等你 > 出错 > 在跑，压过最近", () => {
    assert.deepEqual(
      selectHomeCards(sessions, stateOf).map((card) => card.sessionId),
      ["wait", "fail", "run"],
    );
  });

  test("要注意的不满三张：其余按最近活跃补齐", () => {
    assert.deepEqual(
      selectHomeCards(sessions, (m) => (m.id === "run" ? "running" : null)).map((card) => card.sessionId),
      ["run", "recent", "idle"],
    );
  });

  test("跑完没看不算要注意（它在「最近」里排）；不给 stateOf 就是旧口径", () => {
    assert.deepEqual(
      selectHomeCards(sessions, (m) => (m.id === "wait" ? "done" : null)).map((card) => card.sessionId),
      ["recent", "idle", "run"],
    );
    assert.deepEqual(
      selectHomeCards(sessions).map((card) => card.sessionId),
      ["recent", "idle", "run"],
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
    noText: "（没有文字）",
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

  test("正在读技能：配了 summary 就写技能名，不写绝对路径", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "s1", toolName: "read", input: { path: "/r/builtin-plugins/docs-slides/skills/slides/SKILL.md" } }]),
    ];
    const withSummary: HomeCardLineText = { ...text, verb: () => "skill", summary: (_tool, input) => ((input as { path?: string }).path?.includes("slides/SKILL.md") === true ? "slides" : null) };
    assert.equal(homeCardLine({ ...base, state: "running", records }, withSummary), "skill slides");
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

describe("selectHomeLog", () => {
  const stateById =
    (map: Record<string, SessionRunState>) =>
    (m: SessionMeta): SessionRunState =>
      map[m.id] ?? null;

  test("按运行态分三组：等你（含出错）> 进行中 > 最近（含跑完没看），组内保持列表序", () => {
    const sessions = [
      meta({ id: "idle1", updatedAt: 90 }),
      meta({ id: "run", updatedAt: 80 }),
      meta({ id: "wait", updatedAt: 70 }),
      meta({ id: "fail", updatedAt: 60 }),
      meta({ id: "done", updatedAt: 50 }),
      meta({ id: "idle2", updatedAt: 40 }),
    ];
    const groups = selectHomeLog(sessions, stateById({ run: "running", wait: "waiting", fail: "failed", done: "done" }));
    assert.deepEqual(
      groups.map((g) => [g.group, g.rows.map((r) => r.sessionId)]),
      [
        ["waiting", ["wait", "fail"]],
        ["running", ["run"]],
        ["recent", ["idle1", "done", "idle2"]],
      ],
    );
  });

  test("没有行的组不返回；全是闲置会话只剩「最近」", () => {
    const groups = selectHomeLog([meta({ id: "a", updatedAt: 2 }), meta({ id: "b", updatedAt: 1 })], stateById({}));
    assert.deepEqual(
      groups.map((g) => g.group),
      ["recent"],
    );
    assert.deepEqual(selectHomeLog([], stateById({})), []);
  });

  test("子会话 / 归档 / 无标题不进记录；每组各有上限（等你 4、进行中 4、最近 5）", () => {
    const many = (prefix: string, n: number, base: number): SessionMeta[] =>
      Array.from({ length: n }, (_, i) => meta({ id: `${prefix}${i}`, updatedAt: base - i }));
    const sessions = [
      ...many("w", 6, 600),
      ...many("r", 6, 500),
      ...many("x", 8, 400),
      meta({ id: "child", updatedAt: 999, parentId: "w0" }),
      meta({ id: "arch", updatedAt: 998, archived: true }),
      meta({ id: "blank", updatedAt: 997, title: "" }),
    ];
    const state = (m: SessionMeta): SessionRunState =>
      m.id.startsWith("w") ? "waiting" : m.id.startsWith("r") ? "running" : null;
    const groups = selectHomeLog(sessions, state);
    const sizes = Object.fromEntries(groups.map((g) => [g.group, g.rows.length]));
    assert.deepEqual(sizes, { waiting: 4, running: 4, recent: 5 });
    const ids = groups.flatMap((g) => g.rows.map((r) => r.sessionId));
    for (const bad of ["child", "arch", "blank"]) assert.ok(!ids.includes(bad), `${bad} 不该出现`);
  });
});

describe("visibleAsk / 首页记录行的「此刻」一格不露系统提示", () => {
  const text: HomeCardLineText = {
    thinking: "在想",
    doing: (step, now) => `${step}：${now}`,
    approve: (what) => `等你批准：${what}`,
    childWaiting: "子会话在等你批准",
    failed: "出错停下了",
    done: "跑完了",
    noText: "（没有文字）",
    verb: (toolName) => toolName,
  };
  const idle = (lastAsk: string | null) => homeCardLine({ state: null, records: null, approval: null, turnError: null, lastAsk }, text);

  test("成对的系统包装块、自闭合标签整段剥掉，只留用户写的话", () => {
    assert.equal(
      visibleAsk('<user_context>\nsent_at: 2026-11-07\n</user_context><orbita-memory>\n- 偏好 A\n</orbita-memory>帮我看下首页'),
      "帮我看下首页",
    );
    assert.equal(visibleAsk('<referenced_task id="x" title="y" />继续做这个'), "继续做这个");
    assert.equal(visibleAsk("普通的一句话"), "普通的一句话");
  });

  test("HTML 注释剥掉；没闭合的注释吞到结尾（它之后全是系统文字）", () => {
    assert.equal(visibleAsk("<!-- 系统说明 -->总结一下"), "总结一下");
    assert.equal(visibleAsk("<!-- 你正在通过 Proma 飞书桥收到消息，下面是系统提示……"), "");
  });

  test("引用块也剥（用户看到的是引用芯片，不是文字）", () => {
    assert.equal(visibleAsk('<quoted_context role="assistant" turn="2">\n被引的一段\n</quoted_context>\n\n基于这段改'), "基于这段改");
  });

  test("homeCardLine：剥完为空 → 「（没有文字）」；本来就空 → null；有文字 → 剥后的文字", () => {
    assert.equal(idle("<!-- 你正在通过 Proma 飞书桥…"), "（没有文字）");
    assert.equal(idle("   "), null);
    assert.equal(idle(null), null);
    assert.equal(idle("<user_context>x</user_context>写个测试"), "写个测试");
  });
});
