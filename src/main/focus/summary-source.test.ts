/**
 * 专注收工小结素材归拢的测试（summary-source.ts）。记录与时间全注入。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { FocusChangeEntry } from "../../shared/focus.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import {
  SUMMARY_MAX_LINES,
  SUMMARY_MAX_SESSIONS,
  buildSummaryMaterial,
  buildSummaryPrompt,
  extractSessionLines,
  pickActiveSessions,
} from "./summary-source.ts";

const T0 = 1_700_000_000_000;
const T1 = T0 + 55 * 60_000;

const meta = (id: string, updatedAt: number, workspaceId: string | null = null): SessionMeta =>
  ({ id, title: `任务-${id}`, titleSource: "derived", cwd: "/w", workspaceId, updatedAt, createdAt: updatedAt, archived: false }) as unknown as SessionMeta;

const user = (text: string, timestamp: number): SessionRecord =>
  ({ id: `u${timestamp}`, role: "user", content: [{ type: "text", text }], timestamp }) as SessionRecord;

const assistant = (timestamp: number, blocks: unknown[]): SessionRecord =>
  ({ id: `a${timestamp}`, role: "assistant", content: blocks, model: { provider: "p", id: "m" }, status: "complete", stopReason: "stop", timestamp }) as unknown as SessionRecord;

const fileTurn = (timestamp: number, paths: string[]): SessionRecord =>
  ({ id: `f${timestamp}`, role: "file-turn", timestamp, changes: paths.map((path) => ({ path, added: 3, removed: 1 })) }) as unknown as SessionRecord;

describe("pickActiveSessions", () => {
  test("严格晚于专注开始才算；最近的在前；上限截断", () => {
    const metas = [
      meta("old", T0 - 1), // 专注开始前就沉了
      meta("during", T0 + 100),
      meta("newest", T0 + 999),
    ];
    assert.deepEqual(
      pickActiveSessions(metas, T0).map((item) => item.id),
      ["newest", "during"],
    );
    const many = Array.from({ length: SUMMARY_MAX_SESSIONS + 5 }, (_, i) => meta(`s${i}`, T0 + i));
    assert.equal(pickActiveSessions(many, T0).length, SUMMARY_MAX_SESSIONS);
  });
});

describe("extractSessionLines", () => {
  test("窗口过滤（含边界）：startedAt 排除、until 含入", () => {
    const records = [user("太早", T0), user("正好", T0 + 1), user("太晚", T1 + 1)];
    const lines = extractSessionLines(records, T0, T1);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^用户：正好/);
  });
  test("assistant：text 与 toolCall 都出，thinking 不出", () => {
    const records = [
      assistant(T0 + 10, [
        { type: "thinking", thinking: "内心戏" },
        { type: "text", text: "好的，我来建。" },
        { type: "toolCall", toolCallId: "c1", toolName: "create_skill", input: { name: "focus-helper" } },
      ]),
    ];
    const lines = extractSessionLines(records, T0, T1);
    assert.deepEqual(lines, ["助手：好的，我来建。", "调用工具 create_skill：{\"name\":\"focus-helper\"}"]);
  });
  test("file-turn：文件账出「写改文件」，取文件名", () => {
    const lines = extractSessionLines([fileTurn(T0 + 20, ["/w/src/a.ts", "/w/src/b.ts"])], T0, T1);
    assert.deepEqual(lines, ["写改文件：a.ts、b.ts"]);
  });
  test("长文截断与行数上限", () => {
    const long = "字".repeat(500);
    const many = Array.from({ length: SUMMARY_MAX_LINES + 10 }, (_, i) => user(`${long}-${i}`, T0 + i + 1));
    const lines = extractSessionLines(many, T0, T1);
    assert.equal(lines.length, SUMMARY_MAX_LINES);
    assert.ok(lines[0]!.length < 220, "单行要被截短");
    assert.match(lines[0]!, /……$/);
  });
});

describe("buildSummaryMaterial + buildSummaryPrompt", () => {
  const changes: FocusChangeEntry[] = [
    { path: "src/focus/new.ts", kind: "U", added: 64, removed: 0, binary: false },
    { path: "src/shell/Sidebar.tsx", kind: "M", added: 42, removed: 7, binary: false },
  ];
  const inputs = [
    {
      meta: meta("a", T0 + 100, "ws-1"),
      records: [user("帮我建个 skill", T0 + 50), assistant(T0 + 60, [{ type: "text", text: "建好了" }])],
    },
    {
      meta: meta("b", T0 + 200, null),
      records: [user("另一工作区的事", T0 + 150)],
    },
    {
      meta: meta("silent", T0 + 300),
      records: [user("窗口外的话", T0 - 50)], // 行抽不出来 → 不进素材
    },
  ];

  test("窗口内无行的会话被剔除；hasActivity 口径", () => {
    const material = buildSummaryMaterial(inputs, {
      workspaceNames: new Map([["ws-1", "orbita"]]),
      workspaceName: "orbita",
      branch: "feat/focus-mode",
      changeEntries: changes,
      startedAt: T0,
      until: T1,
    });
    assert.equal(material.sessions.length, 2);
    // 顺序跟调用方（pickActiveSessions 已按最近在前排）；这里只验内容
    assert.deepEqual(
      material.sessions.map((session) => session.title),
      ["任务-a", "任务-b"],
    );
    assert.equal(material.sessions[0]?.workspaceName, "orbita");
    assert.equal(material.sessions[1]?.workspaceName, null);
    assert.equal(material.hasActivity, true);
  });

  test("摘抄拼回素材：活动会话里、窗口内摘的才算；跨窗口与外会话的不算", () => {
    const material = buildSummaryMaterial(inputs, {
      workspaceNames: new Map([["ws-1", "orbita"]]),
      workspaceName: "orbita",
      branch: null,
      changeEntries: [],
      startedAt: T0,
      until: T1,
      excerpts: [
        { sessionId: "a", text: "原则：代码是唯一真源", createdAt: T0 + 80 },
        { sessionId: "a", text: "窗口外摘的", createdAt: T0 - 1 },
        { sessionId: "silent", text: "没进素材的会话", createdAt: T0 + 90 },
        { sessionId: "gone", text: "不存在的会话", createdAt: T0 + 90 },
      ],
    });
    const lines = material.sessions.find((session) => session.title === "任务-a")?.lines ?? [];
    assert.ok(lines.includes("摘抄：原则：代码是唯一真源"));
    assert.equal(lines.filter((line) => line.startsWith("摘抄：")).length, 1);
    // 只有摘抄、没有流水的会话（silent）也能进素材——活动就是活动
    assert.ok(material.sessions.some((session) => session.title === "任务-silent"));
  });

  test("全空 → hasActivity false（回 no-activity 的依据）", () => {
    const material = buildSummaryMaterial([], {
      workspaceNames: new Map(),
      workspaceName: "orbita",
      branch: null,
      changeEntries: [],
      startedAt: T0,
      until: T1,
    });
    assert.equal(material.hasActivity, false);
  });

  test("正文：时段头、会话块（带工作区名）、U/M 清单带行数", () => {
    const material = buildSummaryMaterial(inputs, {
      workspaceNames: new Map([["ws-1", "orbita"]]),
      workspaceName: "orbita",
      branch: "feat/focus",
      changeEntries: changes,
      startedAt: T0,
      until: T1,
    });
    const prompt = buildSummaryPrompt(material, T0, T1);
    assert.match(prompt, /约 55 分钟/);
    assert.match(prompt, /工作区：orbita（分支 feat\/focus）/);
    assert.match(prompt, /== 会话「任务-a」（工作区 orbita）==/);
    assert.match(prompt, /用户：帮我建个 skill/);
    assert.match(prompt, /U focus\/new\.ts（\+64）/);
    assert.match(prompt, /M shell\/Sidebar\.tsx（\+42 −7）/);
  });

  test("正文：超大未跟踪文件写「行数未知」，不写 +0", () => {
    const material = buildSummaryMaterial([], {
      workspaceNames: new Map(),
      workspaceName: "orbita",
      branch: null,
      changeEntries: [
        { path: "data/dump.binlog", kind: "U", added: 0, removed: 0, binary: false, lineCountUnknown: true },
      ],
      startedAt: T0,
      until: T1,
    });
    const prompt = buildSummaryPrompt(material, T0, T1);
    assert.match(prompt, /U data\/dump\.binlog（行数未知）/);
    assert.doesNotMatch(prompt, /dump\.binlog（\+0）/);
  });

  test("无改动时的诚实句", () => {
    const material = buildSummaryMaterial([], {
      workspaceNames: new Map(),
      workspaceName: "orbita",
      branch: null,
      changeEntries: [],
      startedAt: T0,
      until: T1,
    });
    assert.match(buildSummaryPrompt(material, T0, T1), /没有未提交的改动/);
  });
});
