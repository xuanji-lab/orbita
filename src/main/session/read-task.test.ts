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
  type RoundsSelection,
  type WorkspaceStoreReader,
} from "./read-task.ts";
import { SessionStore } from "./store.ts";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";
import type { TranscriptItem } from "@earendil-works/pi-protocol";

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
    const result = await applyReadTask(sessions, event({ task: "fix composer" }), noWorkspaces);
    assert.equal(result.ok, true);
    if (!result.ok || result.card === null) return assert.fail("简报应该有任务卡");
    assert.equal(result.card.sessionId, S2);
    assert.equal(result.card.roundCount, 3);
    assert.match(result.text, /--- Last 3 rounds in full ---/);
  });

  test("rounds 有值 → 只取指定轮", async () => {
    const result = await applyReadTask(sessions, event({ task: S2, rounds: "1" }), noWorkspaces);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.text, /--- Round 1 ---/);
    assert.doesNotMatch(result.text, /answer 3/);
  });

  test("读自己、无匹配、歧义都报错且错误可指导改道", async () => {
    const self = await applyReadTask(sessions, event({ task: "fix sidebar" }), noWorkspaces);
    assert.match(self.ok ? "" : self.error, /is the current task/);
    const missing = await applyReadTask(sessions, event({ task: "nope" }), noWorkspaces);
    assert.match(missing.ok ? "" : missing.error, /No task matches/);
    const ambiguous = await applyReadTask(sessions, event({ task: "fix" }), noWorkspaces);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /matches several tasks/);
  });

  test("notFound / ambiguous 的报错都附兄弟索引，模型一次改道", async () => {
    const missing = await applyReadTask(sessions, event({ task: "nope" }), noWorkspaces);
    const missingError = missing.ok ? "" : missing.error;
    assert.match(missingError, /Tasks outside any workspace: 2 other tasks/);
    assert.match(missingError, new RegExp(`Fix composer drag \\(id: ${S2}\\)`));
    const ambiguous = await applyReadTask(sessions, event({ task: "fix" }), noWorkspaces);
    assert.match(ambiguous.ok ? "" : ambiguous.error, /Tasks outside any workspace: 2 other tasks/);
  });

  test("task 缺席 / 空白 → 目录模式，card 为 null", async () => {
    const listed = await applyReadTask(sessions, event({ task: undefined }), noWorkspaces);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.card, null);
    assert.match(listed.text, /Tasks outside any workspace: 2 other tasks/);
    assert.doesNotMatch(listed.text, /Fix sidebar fold/);
    const blank = await applyReadTask(sessions, event({ task: "   " }), noWorkspaces);
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
    };
    const result = await applyReadTask(
      scoped,
      event({ task: undefined }),
      workspacesStub(workspace(W1, "orbita"), workspace(W2, "other")),
    );
    assert.match(result.ok ? result.text : "", /Workspace "orbita": 1 other task,/);
    assert.doesNotMatch(result.ok ? result.text : "", /Elsewhere/);
  });

  test("list 之后目标被删（竞态防御）：load null 报「已不存在」", async () => {
    const racy = {
      list: async () => [meta(S2, "Fix composer drag")],
      load: async () => null,
    } as unknown as SessionStore;
    const result = await applyReadTask(racy, event({ task: "fix composer" }), noWorkspaces);
    assert.match(result.ok ? "" : result.error, /no longer exists/);
  });
});
