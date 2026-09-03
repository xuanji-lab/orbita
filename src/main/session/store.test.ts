import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { SessionStore } from "./store.ts";
import type { SessionMeta } from "../../shared/session.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
const OTHER = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: ID,
  title: "",
  titleSource: "derived",
  stats: null,
  cwd: "/repo/orbita-lab",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  createdAt: 1000,
  updatedAt: 1000,
  ...patch,
  workspaceId: patch.workspaceId ?? null,
  piSessionFile: patch.piSessionFile ?? null,
  pinned: patch.pinned ?? false,
  archived: patch.archived ?? false,
  recentQueries: patch.recentQueries ?? [],
});

const userItem = (text: string, timestamp = 2000): TranscriptItem => ({
  id: "u1",
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistantItem = (text: string, timestamp = 3000): TranscriptItem => ({
  id: "a1",
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp,
  status: "complete",
  stopReason: "stop",
});

let dir = "";
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-session-"));
  store = new SessionStore(join(dir, "sessions"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("目录还不存在时列表是空的，不抛", async () => {
    assert.deepEqual(await store.list(), []);
  });

  // 读不了 ≠ 没有：吞成空列表会让用户以为会话全没了（D-3 真实教训）
  test("目录读不了就抛错，不吞成空列表", async () => {
    // 用同名文件顶替目录——readdir 打在文件上必炸，且不是 ENOENT
    await writeFile(join(dir, "sessions"), "not a dir", "utf8");
    const blocked = new SessionStore(join(dir, "sessions"));
    await assert.rejects(() => blocked.list());
  });

  test("建了就能列出来、能读回来", async () => {
    await store.create(meta());
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
    assert.deepEqual((await store.load(ID))?.meta.id, ID);
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  test("记一条就追加一行，并把 updatedAt 推到那条的时间", async () => {
    await store.create(meta());
    await store.record(ID, userItem("重做外壳"));
    await store.record(ID, assistantItem("好的"));
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 2);
    assert.equal(detail?.meta.updatedAt, 3000);
  });

  test("标题取第一条用户消息，之后不再改——否则会话会在侧栏里改名", async () => {
    await store.create(meta());
    await store.record(ID, userItem("第一句"));
    await store.record(ID, userItem("第二句", 4000));
    assert.equal((await store.load(ID))?.meta.title, "第一句");
  });

  test("assistant 消息不当标题用", async () => {
    await store.create(meta());
    await store.record(ID, assistantItem("我先说话"));
    assert.equal((await store.load(ID))?.meta.title, "");
  });

  // 首页会话卡（D-1）的三槽吃它：每条用户消息都记，新的在前，封顶 3 条
  test("用户消息记进 recentQueries，assistant 不记", async () => {
    await store.create(meta());
    await store.record(ID, userItem("第一问"));
    await store.record(ID, assistantItem("答"));
    await store.record(ID, userItem("第二问", 4000));
    await store.record(ID, userItem("第三问", 5000));
    await store.record(ID, userItem("第四问", 6000));
    assert.deepEqual((await store.load(ID))?.meta.recentQueries, ["第四问", "第三问", "第二问"]);
  });

  test("列表按 updatedAt 倒序——新的在前", async () => {
    await store.create(meta({ id: ID, updatedAt: 1000 }));
    await store.create(meta({ id: OTHER, updatedAt: 5000 }));
    assert.deepEqual((await store.list()).map((m) => m.id), [OTHER, ID]);
  });

  test("meta 坏了就跳过这条，不让一条坏记录挡住整张列表", async () => {
    await store.create(meta({ id: ID }));
    await writeFile(join(dir, "sessions", `${OTHER}.meta.json`), "{ 这不是 JSON", "utf8");
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
  });

  // 只追加的文件断电时最后一行可能只写了一半
  test("日志里的半截行跳过，前面读到的照常返回", async () => {
    await store.create(meta());
    await store.record(ID, userItem("完整的一行"));
    await writeFile(join(dir, "sessions", `${ID}.jsonl`), '{"id":"u1","role":"user"', { flag: "a" });
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 1);
  });

  test("meta 不在就不往日志里加，避免长出孤儿日志", async () => {
    await store.record(ID, userItem("没有会话"));
    assert.deepEqual(await readdir(join(dir, "sessions")).catch(() => []), []);
  });

  test("删掉两个文件都清干净", async () => {
    await store.create(meta());
    await store.record(ID, userItem("x"));
    await store.remove(ID);
    assert.deepEqual(await readdir(join(dir, "sessions")), []);
    assert.equal(await store.load(ID), null);
  });

  /**
   * `remove()` 先删 transcript 后删 meta，为的是崩在两次 rm 之间时残留是**看得见**的那一种。
   * 顺序本身没法从外面观测，所以这里验的是它想避免的后果：
   * 一个没有 meta 的 .jsonl 既列不出来、也没有任何入口能删掉它。
   */
  test("没有 meta 的 .jsonl 是隐形的——列不出来，所以也删不掉", async () => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${ID}.jsonl`), '{"id":"u1"}\n', "utf8");
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.load(ID), null);
  });

  test("setMode 落盘——重开会话不该静默换档", async () => {
    await store.create(meta());
    await store.setMode(ID, "skip");
    assert.equal((await store.load(ID))?.meta.mode, "skip");
  });

  test("setModel 落 meta——重开播种、分支继承读的就是它（C-4）", async () => {
    await store.create(meta());
    await store.setModel(ID, "other", "m2");
    const loaded = (await store.load(ID))?.meta;
    assert.equal(loaded?.providerId, "other");
    assert.equal(loaded?.modelId, "m2");
  });

  // id 从 renderer 经 IPC 进来，直接拼路径的话一个 ../../ 就能写到别处
  test("非法 id 一律拒绝，不落在 sessions 目录之外", async () => {
    for (const bad of ["../../etc/passwd", "..", "a/b", "", "not-a-uuid", `${ID}/../x`]) {
      await assert.rejects(() => store.create(meta({ id: bad })), /invalid session id/);
      await assert.rejects(() => store.remove(bad), /invalid session id/);
    }
  });

  test("原子写不留临时文件", async () => {
    await store.create(meta());
    await store.record(ID, userItem("x"));
    const names = await readdir(join(dir, "sessions"));
    assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
  });

  test("日志是一行一条 JSON，人能直接读", async () => {
    await store.create(meta());
    await store.record(ID, userItem("看得懂吗"));
    const raw = await readFile(join(dir, "sessions", `${ID}.jsonl`), "utf8");
    assert.equal(raw.trimEnd().split("\n").length, 1);
    assert.equal(JSON.parse(raw.trim()).role, "user");
  });

  // ── 刀 0-3：界碑与消息共用一个日志 ──

  const compacted = {
    role: "compacted" as const,
    id: "c1",
    summary: "## Goal",
    tokensBefore: 85000,
    timestamp: 4000,
  };

  test("混合日志回读：界碑认成界碑，消息照旧", async () => {
    await store.create(meta());
    await store.record(ID, userItem("之前", 2000));
    await store.record(ID, compacted);
    await store.record(ID, userItem("之后", 5000));
    const transcript = (await store.load(ID))?.transcript ?? [];
    assert.deepEqual(
      transcript.map((r) => r.role),
      ["user", "compacted", "user"],
    );
    assert.equal(transcript[1] !== undefined && "tokensBefore" in transcript[1] ? transcript[1].tokensBefore : undefined, 85000);
  });

  test("坏掉的界碑行跳过，不当消息也不崩", async () => {
    await store.create(meta());
    await store.record(ID, userItem("完整的一行"));
    await writeFile(
      join(dir, "sessions", `${ID}.jsonl`),
      `${JSON.stringify({ role: "compacted", id: "bad" })}\n`,
      { flag: "a" },
    );
    const transcript = (await store.load(ID))?.transcript ?? [];
    assert.deepEqual(transcript.map((r) => r.role), ["user"]);
  });

  test("刀 0-3 之前的旧日志原样读出——没有界碑就没有界碑", async () => {
    await store.create(meta());
    await store.record(ID, userItem("旧消息"));
    const transcript = (await store.load(ID))?.transcript ?? [];
    assert.deepEqual(transcript.map((r) => r.role), ["user"]);
  });

  // ── C-3：auto-title ──

  test("needsAutoTitle：derived 要，user / auto / meta 没了都不要", async () => {
    await store.create(meta());
    assert.equal(await store.needsAutoTitle(ID), true);
    await store.setAutoTitle(ID, "模型起的");
    assert.equal(await store.needsAutoTitle(ID), false);
    await store.rename(ID, "用户起的");
    assert.equal(await store.needsAutoTitle(ID), false);
    assert.equal(await store.needsAutoTitle(OTHER), false);
  });

  test("setAutoTitle 落标题并标成 auto", async () => {
    await store.create(meta());
    await store.setAutoTitle(ID, "修复登录按钮");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "修复登录按钮");
    assert.equal(detail?.meta.titleSource, "auto");
  });

  test("setAutoTitle 不覆盖用户改过的名字", async () => {
    await store.create(meta());
    await store.rename(ID, "我的名字");
    await store.setAutoTitle(ID, "模型猜的名字");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "我的名字");
    assert.equal(detail?.meta.titleSource, "user");
  });

  test("setAutoTitle 的迟到标题不重复写：auto 之后整份丢弃", async () => {
    await store.create(meta());
    await store.setAutoTitle(ID, "第一个标题");
    await store.setAutoTitle(ID, "迟到的标题");
    assert.equal((await store.load(ID))?.meta.title, "第一个标题");
  });

  test("setAutoTitle 拿到空结果就不写，门禁保持 derived", async () => {
    await store.create(meta());
    await store.setAutoTitle(ID, "  \n ");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "");
    assert.equal(detail?.meta.titleSource, "derived");
    assert.equal(await store.needsAutoTitle(ID), true);
  });

  test("rename 改空也记成 user——用户清掉的名字不该自己长回来", async () => {
    await store.create(meta());
    await store.record(ID, userItem("第一句"));
    await store.rename(ID, "");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "第一句");
    assert.equal(detail?.meta.titleSource, "user");
  });
});

// ── C-2：会话分支 ──

describe("SessionStore.branch", () => {
  const PI_FILE = "C:/pi-sessions/source.jsonl";

  /** 可指定 id 的记录工厂——分支按锚点 id 定位，固定 id 的公共工厂不够用 */
  const item = (id: string, role: "user" | "assistant", text: string): TranscriptItem =>
    role === "user"
      ? { id, role: "user", content: [{ type: "text", text }], timestamp: 2000 }
      : {
          id,
          role: "assistant",
          content: [{ type: "text", text }],
          model: { provider: "zai", id: "glm-5.3" },
          timestamp: 3000,
          status: "complete",
          stopReason: "stop",
        };

  /** pi 不落盘的失败尾巴：status=error 且内容为空 */
  const emptyError = (id: string): TranscriptItem => ({
    id,
    role: "assistant",
    content: [],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp: 3000,
    status: "error",
    stopReason: "error",
  });

  test("prepareBranch：前缀含锚点、角色序列对、meta 继承且标题带后缀", async () => {
    await store.create(meta({ title: "读一下项目", piSessionFile: PI_FILE, pinned: true }));
    await store.record(ID, item("u1", "user", "第一句"));
    await store.record(ID, item("a1", "assistant", "第一次回答"));
    await store.record(ID, emptyError("e1"));
    await store.record(ID, item("u2", "user", "第二句"));
    await store.record(ID, item("a2", "assistant", "第二次回答"));
    await store.record(ID, item("u3", "user", "第三句（不该带进分支）"));

    const plan = await store.prepareBranch(ID, "a2");
    assert.deepEqual(
      plan.records.map((r) => r.id),
      ["u1", "a1", "e1", "u2", "a2"],
    );
    // 空 error 消息不入角色序列（pi 不落它）；tool / compacted 也不入
    assert.deepEqual(plan.roles, ["user", "assistant", "user", "assistant"]);
    assert.equal(plan.sourcePiSessionFile, PI_FILE);
    assert.match(plan.newId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(plan.meta.id, plan.newId);
    assert.equal(plan.meta.title, "读一下项目（分支）");
    assert.equal(plan.meta.cwd, meta().cwd);
    assert.equal(plan.meta.piSessionFile, null);
    assert.equal(plan.meta.pinned, false);
  });

  test("prepareBranch：锚点不存在 / 不是 assistant / 没有 pi 本子，都拒绝", async () => {
    await store.create(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问题"));
    await store.record(ID, item("a1", "assistant", "回答"));
    await assert.rejects(() => store.prepareBranch(ID, "nope"), /找不到/);
    await assert.rejects(() => store.prepareBranch(ID, "u1"), /agent 的回答/);
    await assert.rejects(
      () => store.prepareBranch("00000000-0000-4000-8000-000000000000", "a1"),
      /not found/,
    );

    await store.create(meta({ id: OTHER, piSessionFile: null }));
    await assert.rejects(() => store.prepareBranch(OTHER, "a1"), /不能分支/);
  });

  test("commitBranch：meta 补上 pi 文件、JSONL 逐行等于前缀、列表能看到新会话", async () => {
    await store.create(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    const plan = await store.prepareBranch(ID, "a1");

    await store.commitBranch(plan, "C:/pi-sessions/branch.jsonl");
    const detail = await store.load(plan.newId);
    assert.equal(detail?.meta.piSessionFile, "C:/pi-sessions/branch.jsonl");
    assert.deepEqual(detail?.transcript.map((r) => r.id), ["u1", "a1"]);
    // 列表里有它，源会话也原封不动
    const listed = await store.list();
    assert.deepEqual(
      listed.map((m) => m.id).sort(),
      [ID, plan.newId].sort(),
    );
    assert.equal((await store.load(ID))?.transcript.length, 2);
  });

  test("commitBranch：pi 没给文件就拒绝，什么也不落", async () => {
    await store.create(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    const plan = await store.prepareBranch(ID, "a1");
    await assert.rejects(() => store.commitBranch(plan, null), /没有产出分支文件/);
    assert.equal(await store.load(plan.newId), null);
  });
});

// ── A-1 回归：meta 的「读-改-写」必须串行（wafo 2026-09-03 实测）──

describe("meta 并发写入", () => {
  test("标题落盘不会被同时在跑的用量落盘冲回 derived", async () => {
    const store = new SessionStore(dir);
    await store.create(meta());
    // 真实时序：标题生成是一次 LLM 调用（几秒），这几秒里 record 与 setStats 都在写 meta。
    // 不串行的话，它们手里的旧快照会把 titleSource 冲回 derived，
    // 于是下一条消息又生成一次标题——用户看到「已经命名好的会话又被重命名」。
    await Promise.all([
      store.setAutoTitle(ID, "模型起的名字"),
      store.setStats(ID, {
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: 0.1,
        contextUsage: null,
      }),
      store.record(ID, userItem("u1", 1000)),
    ]);
    const after = (await store.list())[0];
    assert.equal(after?.title, "模型起的名字");
    assert.equal(after?.titleSource, "auto");
    // 三份改动都要在，谁也不该被谁抹掉
    assert.equal(after?.stats?.cost, 0.1);
    assert.equal(after?.updatedAt, 1000);
  });

  test("门禁仍然有效：已 auto 的标题，迟到的第二个标题不覆盖", async () => {
    const store = new SessionStore(dir);
    await store.create(meta());
    await store.setAutoTitle(ID, "先到的");
    await store.setAutoTitle(ID, "迟到的");
    assert.equal((await store.list())[0]?.title, "先到的");
  });

  test("用户改过名之后，模型标题永不覆盖", async () => {
    const store = new SessionStore(dir);
    await store.create(meta());
    await store.rename(ID, "我自己起的");
    await store.setAutoTitle(ID, "模型起的");
    const after = (await store.list())[0];
    assert.equal(after?.title, "我自己起的");
    assert.equal(after?.titleSource, "user");
  });

  test("删会话时在途的写入不会把 meta 又写回来", async () => {
    const store = new SessionStore(dir);
    await store.create(meta());
    const inflight = store.setStats(ID, {
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
      contextUsage: null,
    });
    await store.remove(ID);
    await inflight.catch(() => undefined);
    assert.deepEqual(await store.list(), []);
  });
});
