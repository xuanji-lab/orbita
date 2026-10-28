/**
 * B-1 的账：引用匹配、轮号解析、简报构建（纯核穷尽测）与 applyReadTask
 * （真 SessionStore + 临时目录，与 write-requests.test 同款）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReadTask,
  buildRoundsExcerpt,
  buildTaskBriefing,
  buildTaskIndex,
  numberRounds,
  resolveTaskReference,
  selectRounds,
  type ChannelStoreReader,
  type RoundChannelContext,
  type RoundsSelection,
  type WorkspaceStoreReader,
} from "./read-task.ts";
import { SessionStore } from "./store.ts";
import { ChannelStore } from "../channel/store.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { ChannelMessage } from "../../shared/channel.ts";
import type { ChannelMarkRecord, SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { ExternalSessionReader, ExternalSessionSummary } from "./external-session.ts";

type ReadTaskRequestEvent = Extract<AgentEvent, { type: "readTaskRequest" }>;

const S1 = "11111111-2222-3333-4444-555555555555";
const S2 = "22222222-3333-4444-5555-666666666666";
const S3 = "33333333-4444-5555-6666-777777777777";
const W1 = "ws-orbita";
const W2 = "ws-other";

/** 工作区的最小只读 stub：只管名字。 */
const workspacesStub = (...list: Workspace[]): WorkspaceStoreReader => ({
  list: async (): Promise<Workspace[]> => list,
});

/** 通道账本的最小只读 stub：没有任何往来（与通道无关的用例用它） */
const noChannels: ChannelStoreReader = { load: async (): Promise<ChannelMessage[]> => [] };

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  path: `/tmp/${name}`,
  createdAt: 0,
  attachedDirs: [],
});

const meta = (id: string, title: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title,
  titleSource: "derived",
  cwd: "/tmp/demo",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const userItem = (id: string, text: string, timestamp = 2000): TranscriptItem => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistantItem = (id: string, text: string, timestamp = 3000): TranscriptItem => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp,
  status: "complete",
  stopReason: "stop",
});

const compactedItem = (id: string, summary: string): SessionRecord => ({
  role: "compacted",
  id,
  summary,
  tokensBefore: 45_000,
  timestamp: 1500,
});

/** 通道标记：顶替 pi 本子里那条通道信封 user 消息的接收侧记录（正文在通道账本） */
const channelMark = (
  id: string,
  peerId: string,
  messageId: string,
  from: ChannelMarkRecord["from"],
  kind: ChannelMarkRecord["kind"],
  timestamp: number,
): SessionRecord => ({ role: "channel-mark", id, peerId, messageId, from, kind, timestamp });

const channelMessage = (
  id: string,
  from: ChannelMessage["from"],
  kind: ChannelMessage["kind"],
  text: string,
  createdAt: number,
): ChannelMessage => ({ id, from, author: "model", kind, text, delivery: "followUp", createdAt });

/** 造 n 轮记录：第 i 轮 = user("ask i") + assistant("answer i") */
function roundsFixture(n: number, answerChars = 0): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (let i = 1; i <= n; i++) {
    records.push(userItem(`u${i}`, `ask ${i}`, i * 1000));
    records.push(assistantItem(`a${i}`, `answer ${i}${"x".repeat(answerChars)}`, i * 1000 + 500));
  }
  return records;
}

describe("resolveTaskReference", () => {
  const metas = [meta(S1, "Fix sidebar fold"), meta(S2, "Fix composer drag"), meta(S3, "")];

  test("精确 id 命中；命中自己 = self", () => {
    assert.deepEqual(resolveTaskReference(S2, metas, S1), { kind: "found", id: S2 });
    assert.deepEqual(resolveTaskReference(S1, metas, S1), { kind: "self" });
  });

  test("精确标题大小写不敏感；重名标题算歧义", () => {
    assert.deepEqual(resolveTaskReference("fix sidebar FOLD", metas, S3), { kind: "found", id: S1 });
    const duplicated = [meta(S1, "Same"), meta(S2, "Same")];
    const match = resolveTaskReference("Same", duplicated, S3);
    assert.equal(match.kind, "ambiguous");
  });

  test("唯一前缀（标题或 id）命中；多前缀歧义并剔除当前会话", () => {
    assert.deepEqual(resolveTaskReference("fix sidebar", metas, S3), { kind: "found", id: S1 });
    assert.deepEqual(resolveTaskReference(S2.slice(0, 8), metas, S3), { kind: "found", id: S2 });
    const match = resolveTaskReference("fix", metas, S3);
    assert.equal(match.kind, "ambiguous");
    if (match.kind === "ambiguous") assert.equal(match.candidates.length, 2);
  });

  test("前缀只撞到自己 = self；无匹配与空串 = notFound", () => {
    assert.deepEqual(resolveTaskReference("fix sidebar", metas, S1), { kind: "self" });
    assert.deepEqual(resolveTaskReference("no such task", metas, S3), { kind: "notFound" });
    assert.deepEqual(resolveTaskReference("   ", metas, S3), { kind: "notFound" });
  });

  test("跨工作区同标题：本工作区那条胜出，不再算歧义", () => {
    const scoped = [
      meta(S1, "Same title", { workspaceId: W1 }),
      meta(S2, "Same title", { workspaceId: W2 }),
      meta(S3, "Current", { workspaceId: W1 }),
    ];
    assert.deepEqual(resolveTaskReference("Same title", scoped, S3), { kind: "found", id: S1 });
  });

  test("前缀在本工作区唯一、全仓歧义 → 仍然 found", () => {
    const scoped = [
      meta(S1, "Fix sidebar fold", { workspaceId: W1 }),
      meta(S2, "Fix composer drag", { workspaceId: W2 }),
      meta(S3, "Current", { workspaceId: W1 }),
    ];
    assert.deepEqual(resolveTaskReference("fix", scoped, S3), { kind: "found", id: S1 });
  });

  test("本工作区一个都没有才退回全仓", () => {
    const scoped = [
      meta(S1, "Fix sidebar fold", { workspaceId: W2 }),
      meta(S3, "Current", { workspaceId: W1 }),
    ];
    assert.deepEqual(resolveTaskReference("fix sidebar", scoped, S3), { kind: "found", id: S1 });
  });

  test("workspaceId 为 null 的会话彼此同组（侧栏 TASKS 组）", () => {
    const scoped = [
      meta(S1, "Home note", { workspaceId: null }),
      meta(S2, "Home notice", { workspaceId: W1 }),
      meta(S3, "Current", { workspaceId: null }),
    ];
    assert.deepEqual(resolveTaskReference("home not", scoped, S3), { kind: "found", id: S1 });
  });
});

describe("buildTaskIndex", () => {
  test("只列同工作区兄弟，排除自己，按 updatedAt 倒序，带 id / 时间 / 模型", () => {
    const metas = [
      meta(S1, "Current", { workspaceId: W1, updatedAt: 9000 }),
      meta(S2, "Older sibling", { workspaceId: W1, updatedAt: 1000 }),
      meta(S3, "Newer sibling", { workspaceId: W1, updatedAt: 5000 }),
      meta("other-ws", "Elsewhere", { workspaceId: W2, updatedAt: 8000 }),
    ];
    const result = buildTaskIndex(metas, S1, "orbita");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card, null);
    assert.match(result.text, /Workspace "orbita": 2 other tasks/);
    assert.doesNotMatch(result.text, /Elsewhere/);
    assert.doesNotMatch(result.text, /Current/);
    assert.ok(result.text.indexOf("Newer sibling") < result.text.indexOf("Older sibling"));
    assert.match(result.text, new RegExp(`Newer sibling \\(id: ${S3}\\) · updated 1970-01-01T00:00:05Z · zai/glm-5\\.3`));
    assert.match(result.text, /Call read_task again with `task`/);
  });

  test("零兄弟如实说；workspaceName 为 null 用「不属于任何工作区」文案", () => {
    const alone = buildTaskIndex([meta(S1, "Current", { workspaceId: W1 })], S1, "orbita");
    assert.match(alone.ok ? alone.text : "", /Workspace "orbita": this is the only task here/);
    const homeless = buildTaskIndex(
      [meta(S1, "Current"), meta(S2, "Sibling")],
      S1,
      null,
    );
    assert.match(homeless.ok ? homeless.text : "", /Tasks outside any workspace: 1 other task,/);
    assert.match(homeless.ok ? homeless.text : "", /- Sibling \(id: /);
  });

  test("归档的排在活跃的后面、行尾标注；头部计数只数活跃的", () => {
    const metas = [
      meta(S1, "Current", { updatedAt: 9000 }),
      meta(S2, "Archived but recent", { archived: true, updatedAt: 8000 }),
      meta(S3, "Active older", { updatedAt: 1000 }),
    ];
    const result = buildTaskIndex(metas, S1, "orbita");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 归档那条更新更新，但侧栏把它收在底部，索引也要排在后面
    assert.ok(result.text.indexOf("Active older") < result.text.indexOf("Archived but recent"));
    assert.match(result.text, /Workspace "orbita": 1 other task \(\+1 archived\), most recently updated first:/);
    assert.match(result.text, new RegExp(`Archived but recent \\(id: ${S2}\\) · updated [^\n]+ · zai/glm-5\\.3 · archived`));
    assert.match(result.text, new RegExp(`Active older \\(id: ${S3}\\) · updated [^\n]+ · zai/glm-5\\.3\n`));
  });

  test("一条归档都没有就不提 archived", () => {
    const result = buildTaskIndex([meta(S1, "Current"), meta(S2, "Sibling")], S1, "orbita");
    assert.doesNotMatch(result.ok ? result.text : "", /archived/);
  });

  test("空标题给占位", () => {
    const result = buildTaskIndex([meta(S1, "Current"), meta(S2, "")], S1, null);
    assert.match(result.ok ? result.text : "", /- \(untitled\) \(id: /);
  });
});

describe("numberRounds", () => {
  test("前导界碑不成轮；轮号按 user 记录数，endIndex 到下一条 user 或末尾", () => {
    const records: SessionRecord[] = [
      compactedItem("c1", "早期摘要"),
      userItem("u1", "ask 1"),
      assistantItem("a1", "answer 1"),
      userItem("u2", "ask 2"),
      assistantItem("a2", "answer 2"),
    ];
    const rounds = numberRounds(records);
    assert.deepEqual(
      rounds.map((round) => [round.number, round.startIndex, round.endIndex]),
      [
        [1, 1, 3],
        [2, 3, 5],
      ],
    );
  });
});

describe("selectRounds", () => {
  const records = roundsFixture(5);

  test("单轮 / 范围 / 列表 / 混合，去重并按轮号排序", () => {
    const single = selectRounds(records, "3");
    assert.equal(single.kind, "ok");
    if (single.kind === "ok") assert.deepEqual(single.rounds.map((r) => r.number), [3]);
    assert.equal(selectRounds(records, "4,1,3-2,2").kind, "error"); // 3-2 倒序是错
    const mixed = selectRounds(records, "4,1,2-3");
    assert.equal(mixed.kind, "ok");
    if (mixed.kind === "ok") assert.deepEqual(mixed.rounds.map((r) => r.number), [1, 2, 3, 4]);
  });

  test("越界、倒序、非数字都报错并带有效范围", () => {
    const errorOf = (selection: RoundsSelection): string => (selection.kind === "error" ? selection.message : "");
    assert.match(errorOf(selectRounds(records, "0")), /valid rounds are 1-5/);
    assert.match(errorOf(selectRounds(records, "6")), /valid rounds are 1-5/);
    assert.match(errorOf(selectRounds(records, "abc")), /use "3", "2-5" or "1,4"/);
    assert.match(errorOf(selectRounds(records, "5-2")), /out of range/);
    assert.match(errorOf(selectRounds(roundsFixture(0), "1")), /no rounds/);
  });
});

describe("buildTaskBriefing", () => {
  test("头部（标题/id/目录/模型/用量/快照标注）+ 目录行与回答箭头", () => {
    const records = roundsFixture(2);
    const result = buildTaskBriefing(meta(S1, "Demo"), records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /Task "Demo" \(id: 11111111/);
    assert.match(result.text, /Folder: \/tmp\/demo · Model: zai\/glm-5\.3 · 2 rounds/);
    assert.match(result.text, /Snapshot read from disk as of 1970-01-01T00:00:00Z/);
    assert.match(result.text, /1\. ask 1\n/);
    assert.match(result.text, /   → answer 1/);
    assert.match(result.text, /--- Last 2 rounds in full ---/);
    assert.match(result.text, /answer 2/);
    assert.deepEqual(result.card, { sessionId: S1, title: "Demo", mode: "briefing", roundCount: 2 });
  });

  test("用量行只在有账本时出现；空标题给占位", () => {
    const result = buildTaskBriefing(meta(S1, "", { stats: null }), roundsFixture(1));
    if (!result.ok) return;
    assert.match(result.text, /Task "\(untitled\)"/);
    assert.doesNotMatch(result.text, /Usage so far/);
    const withStats = buildTaskBriefing(
      meta(S1, "Demo", { stats: { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 12345 }, cost: 0.5, contextUsage: null } }),
      roundsFixture(1),
    );
    assert.match(withStats.ok ? withStats.text : "", /Usage so far: 12,345 tokens, \$0\.5000/);
  });

  test("界碑摘要进目录（截断如实标注）；无轮如实说", () => {
    const longSummary = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const records: SessionRecord[] = [compactedItem("c1", longSummary), ...roundsFixture(1)];
    const result = buildTaskBriefing(meta(S1, "Demo"), records);
    assert.match(result.ok ? result.text : "", /truncated, 50 lines in total/);
    const empty = buildTaskBriefing(meta(S1, "Demo"), []);
    assert.match(empty.ok ? empty.text : "", /No rounds yet/);
  });

  test("全文超预算就减轮数，并如实标注被减这件事", () => {
    const result = buildTaskBriefing(meta(S1, "Demo"), roundsFixture(12, 9_000));
    assert.match(result.ok ? result.text : "", /only the last \d+ of 10 rounds shown in full/);
    assert.equal(result.ok && result.card !== null && result.card.roundCount, 12);
  });

  test("给了 workspaceName 就在头部标工作区；缺省不动", () => {
    const named = buildTaskBriefing(meta(S1, "Demo"), roundsFixture(1), "orbita");
    assert.match(named.ok ? named.text : "", /Workspace: orbita/);
    const homeless = buildTaskBriefing(meta(S1, "Demo"), roundsFixture(1), null);
    assert.match(homeless.ok ? homeless.text : "", /Workspace: \(outside any workspace\)/);
    const bare = buildTaskBriefing(meta(S1, "Demo"), roundsFixture(1));
    assert.doesNotMatch(bare.ok ? bare.text : "", /Workspace:/);
  });
});

describe("buildRoundsExcerpt", () => {
  test("只含选中轮；轮内界碑带上；卡片 mode=rounds、rounds 原样", () => {
    const records: SessionRecord[] = [
      userItem("u1", "ask 1"),
      assistantItem("a1", "answer 1"),
      userItem("u2", "ask 2"),
      compactedItem("c2", "第二轮里的界碑"),
      assistantItem("a2", "answer 2"),
    ];
    const result = buildRoundsExcerpt(meta(S1, "Demo"), records, "2");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /--- Round 2 ---/);
    assert.match(result.text, /answer 2/);
    assert.match(result.text, /第二轮里的界碑/);
    assert.doesNotMatch(result.text, /answer 1/);
    assert.deepEqual(result.card, {
      sessionId: S1,
      title: "Demo",
      mode: "rounds",
      rounds: "2",
      roundCount: 2,
    });
  });

  test("非法轮号透传 selectRounds 的错误", () => {
    const result = buildRoundsExcerpt(meta(S1, "Demo"), roundsFixture(2), "9");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /valid rounds are 1-2/);
  });
});

describe("applyReadTask（真 store）", () => {
  let dir = "";
  let sessions: SessionStore;

  const event = (over: Partial<Extract<import("../../shared/agent-ipc.ts").AgentEvent, { type: "readTaskRequest" }>> = {}) => ({
    type: "readTaskRequest" as const,
    requestId: "r1",
    sessionId: S1,
    task: "Fix sidebar fold",
    ...over,
  });

  /** 真 store 里的会话都是 workspaceId null（侧栏 TASKS 组），工作区表给空即可 */
  const noWorkspaces = workspacesStub();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbita-read-task-"));
    sessions = new SessionStore(join(dir, "sessions"));
    await sessions.ensureSession(meta(S1, "Fix sidebar fold"));
    await sessions.ensureSession(meta(S2, "Fix composer drag"));
    // 第三条用来造歧义："fix" 剔除当前会话（S1）后还剩两个候选
    await sessions.ensureSession(meta(S3, "Fix dropdown clip"));
    for (const record of roundsFixture(2)) await sessions.record(S1, record);
    for (const record of roundsFixture(3)) await sessions.record(S2, record);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("标题命中 → 简报；卡片指向正确 id", async () => {
    const result = await applyReadTask(sessions, event({ task: "fix composer" }), noWorkspaces, noChannels);
    assert.equal(result.ok, true);
    if (!result.ok || result.card === null) return assert.fail("简报应该有任务卡");
    assert.equal(result.card.sessionId, S2);
    assert.equal(result.card.roundCount, 3);
    assert.match(result.text, /--- Last 3 rounds in full ---/);
  });

  test("rounds 有值 → 只取指定轮", async () => {
    const result = await applyReadTask(sessions, event({ task: S2, rounds: "1" }), noWorkspaces, noChannels);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /--- Round 1 ---/);
    assert.doesNotMatch(result.text, /answer 3/);
  });

  test("读自己、无匹配、歧义都报错且错误可指导改道", async () => {
    const self = await applyReadTask(sessions, event({ task: "fix sidebar" }), noWorkspaces, noChannels);
    assert.match(self.ok ? "" : self.error, /is the current task/);
    const missing = await applyReadTask(sessions, event({ task: "nope" }), noWorkspaces, noChannels);
    assert.match(missing.ok ? "" : missing.error, /No task matches/);
    const ambiguous = await applyReadTask(sessions, event({ task: "fix" }), noWorkspaces, noChannels);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /matches several tasks/);
  });

  test("notFound / ambiguous 的报错都附兄弟索引，模型一次改道", async () => {
    const missing = await applyReadTask(sessions, event({ task: "nope" }), noWorkspaces, noChannels);
    const missingError = missing.ok ? "" : missing.error;
    assert.match(missingError, /Tasks outside any workspace: 2 other tasks/);
    assert.match(missingError, new RegExp(`Fix composer drag \\(id: ${S2}\\)`));
    const ambiguous = await applyReadTask(sessions, event({ task: "fix" }), noWorkspaces, noChannels);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /Tasks outside any workspace: 2 other tasks/);
  });

  test("task 缺席 / 空白 → 目录模式，card 为 null", async () => {
    const listed = await applyReadTask(sessions, event({ task: undefined }), noWorkspaces, noChannels);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.card, null);
    assert.match(listed.text, /Tasks outside any workspace: 2 other tasks/);
    assert.doesNotMatch(listed.text, /Fix sidebar fold/);
    const blank = await applyReadTask(sessions, event({ task: "   " }), noWorkspaces, noChannels);
    assert.equal(blank.ok && blank.card, null);
  });

  test("目录模式的工作区名来自工作区表", async () => {
    const scoped = {
      list: async (): Promise<SessionMeta[]> => [
        meta(S1, "Current", { workspaceId: W1 }),
        meta(S2, "Sibling", { workspaceId: W1 }),
        meta(S3, "Elsewhere", { workspaceId: W2 }),
      ],
      load: async (): Promise<null> => null,
      recordPath: (id: string): string => `/tmp/sessions/${id}.jsonl`,
    };
    const result = await applyReadTask(
      scoped,
      event({ task: undefined }),
      workspacesStub(workspace(W1, "orbita"), workspace(W2, "other")),
      noChannels,
    );
    assert.match(result.ok ? result.text : "", /Workspace "orbita": 1 other task,/);
    assert.doesNotMatch(result.ok ? result.text : "", /Elsewhere/);
  });

  test("list 之后目标被删（竞态防御）：load null 报「已不存在」", async () => {
    const racy = {
      list: async () => [meta(S2, "Fix composer drag")],
      load: async () => null,
    } as unknown as SessionStore;
    const result = await applyReadTask(racy, event({ task: "fix composer" }), noWorkspaces, noChannels);
    assert.match(result.ok ? "" : result.error, /no longer exists/);
  });
});

// ── 通道消息开轮（2026-09-25：读子会话恒是 0 轮）──

const PARENT = "aaaaaaaa-0000-0000-0000-000000000001";
const CHILD = "bbbbbbbb-0000-0000-0000-000000000002";

/** 子会话的账：母会话派的任务开第一轮，母会话后来的回复开第二轮 */
const childRecords: SessionRecord[] = [
  channelMark("mk1", PARENT, "msg-task", "parent", "task", 1000),
  assistantItem("ca1", "Looking at FilesPanel first.", 1500),
  channelMark("mk2", PARENT, "msg-reply", "parent", "reply", 2000),
  assistantItem("ca2", "Fixed the band in paper-themes.css.", 2500),
];

const childChannel: RoundChannelContext = {
  messages: new Map([
    ["msg-task", channelMessage("msg-task", "parent", "task", "Find the white band in the copybook Files panel.", 1000)],
    ["msg-reply", channelMessage("msg-reply", "parent", "reply", "Only the session group, not the workspace one.", 2000)],
  ]),
  titles: new Map([[PARENT, "Image input branch"]]),
};

describe("numberRounds：通道标记也开一轮（与 store.ts 的 branchRoles 同一条不变量）", () => {
  test("子会话：每一轮都由通道标记开头——以前是 0 轮", () => {
    assert.deepEqual(numberRounds(childRecords), [
      { number: 1, startIndex: 0, endIndex: 2 },
      { number: 2, startIndex: 2, endIndex: 4 },
    ]);
  });

  test("母会话收到子会话的回报：单独成一轮，不再并进上一轮", () => {
    const parentRecords: SessionRecord[] = [
      userItem("u1", "investigate the white band", 1000),
      assistantItem("a1", "Delegated it.", 1500),
      channelMark("mk", CHILD, "msg-q", "child", "question", 2000),
      assistantItem("a2", "Answered the sub-session.", 2500),
    ];
    assert.deepEqual(
      numberRounds(parentRecords).map((round) => [round.startIndex, round.endIndex]),
      [
        [0, 2],
        [2, 4],
      ],
    );
  });

  test("selectRounds 按新的轮号取：子会话的第 2 轮取得到", () => {
    const selection = selectRounds(childRecords, "2");
    assert.equal(selection.kind, "ok");
    if (selection.kind === "ok") assert.deepEqual(selection.rounds.map((round) => round.number), [2]);
  });
});

describe("简报与轮切片：通道消息的正文从通道账本补回来", () => {
  const child = meta(CHILD, "Copybook white band", { parentId: PARENT });

  test("简报：头部是真实轮数，目录行写明谁发来的、什么类型，再接正文首行", () => {
    const result = buildTaskBriefing(child, childRecords, null, childChannel);
    assert.equal(result.ok, true);
    if (!result.ok || result.card === null) return assert.fail("简报应该有任务卡");
    assert.equal(result.card.roundCount, 2);
    assert.match(result.text, /· 2 rounds/);
    assert.doesNotMatch(result.text, /No rounds yet/);
    assert.match(
      result.text,
      /1\. \[task from the parent session "Image input branch"\] Find the white band in the copybook Files panel\./,
    );
    assert.match(result.text, /2\. \[reply from the parent session "Image input branch"\] Only the session group/);
    assert.match(result.text, /→ Fixed the band in paper-themes\.css\./);
  });

  test("全文：通道标记渲染成「Channel · 标题行 + 正文」，夹在前后的回答之间", () => {
    const result = buildRoundsExcerpt(child, childRecords, "1-2", null, childChannel);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const order = [
      '**Channel · task from the parent session "Image input branch"**',
      "Find the white band in the copybook Files panel.",
      "Looking at FilesPanel first.",
      '**Channel · reply from the parent session "Image input branch"**',
      "Only the session group, not the workspace one.",
      "Fixed the band in paper-themes.css.",
    ].map((needle) => result.text.indexOf(needle));
    assert.equal(order.includes(-1), false, `缺内容：${JSON.stringify(order)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test("母会话里子会话发来的：标题行写子会话，不写母会话", () => {
    const parent = meta(PARENT, "Image input branch");
    const records: SessionRecord[] = [
      userItem("u1", "investigate", 1000),
      channelMark("mk", CHILD, "msg-q", "child", "question", 2000),
    ];
    const channel: RoundChannelContext = {
      messages: new Map([["msg-q", channelMessage("msg-q", "child", "question", "Session group only?", 2000)]]),
      titles: new Map([[CHILD, "Copybook white band"]]),
    };
    const result = buildRoundsExcerpt(parent, records, "2", null, channel);
    assert.match(result.ok ? result.text : "", /\*\*Channel · question from sub-session "Copybook white band"\*\*\n\nSession group only\?/);
  });

  test("账本里没有这条消息 / 对面标题不认识：如实说读不到、给 id，不编", () => {
    const bare: RoundChannelContext = { messages: new Map(), titles: new Map() };
    const briefing = buildTaskBriefing(child, childRecords, null, bare);
    assert.match(briefing.ok ? briefing.text : "", new RegExp(`1\\. \\[task from the parent session \\(id: ${PARENT}\\)\\] \\(no text\\)`));
    const excerpt = buildRoundsExcerpt(child, childRecords, "1", null, bare);
    assert.match(excerpt.ok ? excerpt.text : "", /\(message text not found in the channel ledger\)/);
  });
});

describe("applyReadTask：真 SessionStore + 真 ChannelStore 读子会话", () => {
  let dir = "";
  let sessions: SessionStore;
  let channels: ChannelStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbita-read-task-channel-"));
    channels = new ChannelStore(join(dir, "channels"));
    sessions = new SessionStore(join(dir, "sessions"), undefined, channels);
    await sessions.ensureSession(meta(PARENT, "Image input branch"));
    await sessions.ensureSession(meta(CHILD, "Copybook white band", { parentId: PARENT }));
    for (const record of childRecords) await sessions.record(CHILD, record);
    const key = { parentId: PARENT, childId: CHILD };
    await channels.append(key, channelMessage("msg-task", "parent", "task", "Find the white band in the copybook Files panel.", 1000));
    await channels.append(key, channelMessage("msg-reply", "parent", "reply", "Only the session group, not the workspace one.", 2000));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readChild = {
    type: "readTaskRequest" as const,
    requestId: "r1",
    sessionId: PARENT,
    task: CHILD,
  };

  const report = (id: string, kind: ChannelMessage["kind"], text: string, createdAt: number): Promise<void> =>
    channels.append({ parentId: PARENT, childId: CHILD }, channelMessage(id, "child", kind, text, createdAt));

  // 这一条是这刀的由来：子会话的意义是替母会话省上下文，默认那次调用只给输出
  test("母会话读子会话（不带 rounds）：只给状态与回报全文，不给过程", async () => {
    await report("msg-q", "question", "Session group only, or both groups?", 1800);
    await report("msg-done", "done", "Fixed on fix/copybook-files-band.\nSee paper-themes.css.", 2600);
    const result = await applyReadTask(sessions, readChild, workspacesStub(), channels);
    assert.equal(result.ok, true);
    if (!result.ok || result.card === null) return assert.fail("应该有任务卡");
    assert.equal(result.card.sessionId, CHILD);
    assert.equal(result.card.roundCount, 2);
    assert.match(result.text, /Sub-session of "Image input branch" \(id: aaaaaaaa-[^)]+\) · status: done/);
    assert.match(result.text, /Reports to the parent \(2\):/);
    assert.match(result.text, /--- Report 1 · question · [^\n]+ ---\n\nSession group only, or both groups\?/);
    assert.match(result.text, /--- Report 2 · done · [^\n]+ ---\n\nFixed on fix\/copybook-files-band\.\nSee paper-themes\.css\./);
    // 过程与母会话自己发的东西都不给
    assert.doesNotMatch(result.text, /Looking at FilesPanel first/);
    assert.doesNotMatch(result.text, /Fixed the band in paper-themes\.css/);
    assert.doesNotMatch(result.text, /Find the white band/);
    assert.doesNotMatch(result.text, /Last \d+ rounds? in full/);
    // 真要看过程：给记录文件路径，并提示 rounds
    assert.ok(result.text.includes(sessions.recordPath(CHILD)), "要给记录文件路径");
    assert.match(result.text, /`rounds` parameter/);
  });

  test("还没回报：写 none yet，状态 running，照样给路径", async () => {
    const result = await applyReadTask(sessions, readChild, workspacesStub(), channels);
    assert.match(result.ok ? result.text : "", /status: running/);
    assert.match(result.ok ? result.text : "", /Reports to the parent: none yet\./);
    assert.ok(result.ok && result.text.includes(sessions.recordPath(CHILD)));
  });

  test("提问后在等回复：状态 waiting", async () => {
    await channels.append(
      { parentId: PARENT, childId: CHILD },
      channelMessage("msg-q2", "child", "question", "Which group?", 3000),
    );
    const result = await applyReadTask(sessions, readChild, workspacesStub(), channels);
    assert.match(result.ok ? result.text : "", /status: waiting/);
  });

  test("带 rounds：照旧给那几轮全文，母会话的任务与回复正文从通道账本补回", async () => {
    const result = await applyReadTask(sessions, { ...readChild, rounds: "1-2" }, workspacesStub(), channels);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /--- Round 1 ---/);
    assert.match(result.text, /Find the white band in the copybook Files panel\./);
    assert.match(result.text, /Only the session group, not the workspace one\./);
    assert.match(result.text, /Looking at FilesPanel first\./);
  });

  test("没有通道账本的子会话（从 Proma 导入）：没有回报可给，退回普通简报", async () => {
    const IMPORTED = "cccccccc-0000-0000-0000-000000000003";
    await sessions.ensureSession(meta(IMPORTED, "Imported child", { parentId: PARENT }));
    for (const record of roundsFixture(2)) await sessions.record(IMPORTED, record);
    const result = await applyReadTask(sessions, { ...readChild, task: IMPORTED }, workspacesStub(), channels);
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.text : "", /--- Last 2 rounds in full ---/);
    assert.doesNotMatch(result.ok ? result.text : "", /Sub-session of/);
  });

  test("普通 task（不是子会话）不受影响：照旧是简报", async () => {
    await sessions.record(PARENT, userItem("pu1", "investigate", 500));
    await sessions.record(PARENT, assistantItem("pa1", "Delegated it.", 600));
    const result = await applyReadTask(
      sessions,
      { ...readChild, sessionId: CHILD, task: PARENT },
      workspacesStub(),
      channels,
    );
    assert.match(result.ok ? result.text : "", /--- Last 1 round in full ---/);
    assert.match(result.ok ? result.text : "", /Delegated it\./);
  });

  test("通道账本读失败不拦 read_task：会话照读，正文如实写读不到", async () => {
    const broken: ChannelStoreReader = {
      load: async (): Promise<ChannelMessage[]> => {
        throw new Error("EACCES: permission denied");
      },
    };
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]): void => {
      logged.push(args);
    };
    try {
      const result = await applyReadTask(sessions, { ...readChild, rounds: "1" }, workspacesStub(), broken);
      assert.equal(result.ok, true);
      assert.match(result.ok ? result.text : "", /\(message text not found in the channel ledger\)/);
      assert.match(result.ok ? result.text : "", /Looking at FilesPanel first\./);
      // 不带 rounds：仍是只给输出的形状，如实说读不到——读失败不能变成把过程全灌回去的理由
      const overview = await applyReadTask(sessions, readChild, workspacesStub(), broken);
      assert.match(overview.ok ? overview.text : "", /status: unknown/);
      assert.match(overview.ok ? overview.text : "", /Reports to the parent: unavailable/);
      assert.doesNotMatch(overview.ok ? overview.text : "", /Looking at FilesPanel first/);
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 2, "读失败要落日志，不能静默");
  });
});

describe("applyReadTask（外部只读会话）", () => {
  const summary: ExternalSessionSummary = {
    ref: "ext:kimi-work:0123456789abcdef",
    source: "kimi-work",
    title: "External planning",
    cwd: "/external/project",
    createdAt: 100,
    updatedAt: 200,
  };
  const localSessions = {
    list: async (): Promise<SessionMeta[]> => [meta(S1, "Current"), meta(S2, "Local sibling")],
    load: async (): Promise<null> => null,
    recordPath: (id: string): string => `/tmp/${id}.jsonl`,
  };
  const request = (task?: string, rounds?: string): ReadTaskRequestEvent => ({
    type: "readTaskRequest",
    requestId: "external-request",
    sessionId: S1,
    ...(task === undefined ? null : { task }),
    ...(rounds === undefined ? null : { rounds }),
  });
  const reader = (list: ExternalSessionSummary[] = [summary]): ExternalSessionReader => ({
    list: async () => list,
    load: async (ref) => ({
      summary,
      meta: meta(ref, summary.title, { cwd: summary.cwd, createdAt: summary.createdAt, updatedAt: summary.updatedAt }),
      records: roundsFixture(2),
    }),
  });

  test("目录保留本地索引并附外部最近会话；列目录不读全文", async () => {
    let loads = 0;
    const external = reader();
    const load = external.load;
    external.load = async (ref) => {
      loads += 1;
      return load(ref);
    };
    const result = await applyReadTask(localSessions, request(), workspacesStub(), noChannels, external);
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.text : "", /Local sibling/);
    assert.match(result.ok ? result.text : "", /External sessions \(read-only/);
    assert.match(result.ok ? result.text : "", /External planning \(ref: ext:kimi-work:0123456789abcdef\)/);
    assert.equal(loads, 0);
  });

  test("精确 ref 读最新外部正文；rounds 复用轮切片；不挂本地跳转卡", async () => {
    const result = await applyReadTask(localSessions, request(summary.ref, "2"), workspacesStub(), noChannels, reader());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card, null);
    assert.match(result.text, /External Kimi Work session · read-only, not imported/);
    assert.match(result.text, /--- Round 2 ---/);
    assert.match(result.text, /answer 2/);
    assert.doesNotMatch(result.text, /answer 1/);
  });

  test("外部标题唯一可命中；重名返回 ref 消歧", async () => {
    const found = await applyReadTask(localSessions, request("external plan"), workspacesStub(), noChannels, reader());
    assert.equal(found.ok, true);
    assert.match(found.ok ? found.text : "", /External planning/);

    const other = { ...summary, ref: "ext:kimi-code:fedcba9876543210", source: "kimi-code" as const };
    const ambiguous = await applyReadTask(localSessions, request("External planning"), workspacesStub(), noChannels, reader([summary, other]));
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /matches several external sessions/);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /ext:kimi-code:fedcba9876543210/);
  });

  test("本地标题优先；本地已命中时不访问外部 reader", async () => {
    let externalLists = 0;
    const local = {
      ...localSessions,
      load: async (id: string) =>
        id === S2 ? { meta: meta(S2, "Local sibling"), transcript: roundsFixture(1) } : null,
    };
    const external: ExternalSessionReader = {
      list: async () => {
        externalLists += 1;
        return [{ ...summary, title: "Local sibling" }];
      },
      load: async () => {
        throw new Error("external load must not run");
      },
    };
    const result = await applyReadTask(local, request("Local sibling"), workspacesStub(), noChannels, external);
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.text : "", /answer 1/);
    assert.doesNotMatch(result.ok ? result.text : "", /External Kimi/);
    assert.equal(externalLists, 0);
  });

  test("外部目录失败不挡本地目录", async () => {
    const broken: ExternalSessionReader = {
      list: async () => {
        throw new Error("permission denied");
      },
      load: async () => null,
    };
    const result = await applyReadTask(localSessions, request(), workspacesStub(), noChannels, broken);
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.text : "", /Local sibling/);
    assert.match(result.ok ? result.text : "", /External sessions could not be listed: permission denied/);
  });
});
