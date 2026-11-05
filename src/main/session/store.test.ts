import { test, describe, beforeEach, afterEach } from "node:test";
import { buildClosingScanPrompt } from "../../shared/wrapup-scan.ts";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { branchRoles, SessionStore } from "./store.ts";
import { ChannelStore } from "../channel/store.ts";
import { UNASSIGNED_PROVIDER_ID, SESSION_PAGE_RECORDS, type ChannelMarkRecord, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import type { ChannelMessage } from "../../shared/channel.ts";

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
  thinkingLevel: "medium",
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

  /**
   * D-3 的靶心：会话好端端躺在盘上，只因为目录权限坏了，
   * 侧栏以前会说「还没有任务」——用户据此去翻备份、去重装，而重装可能真把它们删了。
   *
   * 跳过用**注册期**写法（canChmodBlock ? test : test.skip），不用 options 的
   * `{ skip }`——bun 的 node:test 兼容层无视 options.skip、也无视 t.skip()，
   * 三种写法探针（2026-09-16）只有 test.skip() 真正亮 (skip)。root 无视权限位、
   * Windows 没有 chmod——那两个环境造不出 EACCES，用例跑了必假红。
   */
  const canChmodBlock = process.platform !== "win32" && process.getuid?.() !== 0;
  const chmodTest = canChmodBlock ? test : test.skip;
  chmodTest("目录读不出来时抛错，不谎报「一条都没有」", async () => {
    await store.ensureSession(meta());
    const sessions = join(dir, "sessions");
    await chmod(sessions, 0o000);
    try {
      await assert.rejects(store.list(), /EACCES/);
    } finally {
      await chmod(sessions, 0o700); // 不恢复的话 afterEach 的 rm 也删不掉
    }
  });

  test("建了就能列出来、能读回来", async () => {
    await store.ensureSession(meta());
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
    assert.deepEqual((await store.load(ID))?.meta.id, ID);
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  test("记一条就追加一行，并把 updatedAt 推到那条的时间", async () => {
    await store.ensureSession(meta());
    await store.record(ID, userItem("重做外壳"));
    await store.record(ID, assistantItem("好的"));
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 2);
    assert.equal(detail?.meta.updatedAt, 3000);
  });

  test("标题取第一条用户消息，之后不再改——否则会话会在侧栏里改名", async () => {
    await store.ensureSession(meta());
    await store.record(ID, userItem("第一句"));
    await store.record(ID, userItem("第二句", 4000));
    assert.equal((await store.load(ID))?.meta.title, "第一句");
  });

  test("assistant 消息不当标题用", async () => {
    await store.ensureSession(meta());
    await store.record(ID, assistantItem("我先说话"));
    assert.equal((await store.load(ID))?.meta.title, "");
  });

  // 首页会话卡（D-1）的三槽吃它：每条用户消息都记，新的在前，封顶 3 条
  test("用户消息记进 recentQueries，assistant 不记", async () => {
    await store.ensureSession(meta());
    await store.record(ID, userItem("第一问"));
    await store.record(ID, assistantItem("答"));
    await store.record(ID, userItem("第二问", 4000));
    await store.record(ID, userItem("第三问", 5000));
    await store.record(ID, userItem("第四问", 6000));
    assert.deepEqual((await store.load(ID))?.meta.recentQueries, ["第四问", "第三问", "第二问"]);
  });

  test("收尾扫描的机器提问不进 recentQueries", async () => {
    await store.ensureSession(meta());
    await store.record(ID, userItem("真问题"));
    await store.record(ID, userItem(buildClosingScanPrompt({ sinceTurn: 1, lastTurn: 1, turns: [] }), 4000));
    assert.deepEqual((await store.load(ID))?.meta.recentQueries, ["真问题"]);
  });

  test("收尾扫描轮压过的权限档不写回会话 meta（审核 F-4）", async () => {
    // 扫描轮在已有会话上 submit：主进程走 settleFirstTurn → ensureSession（带着压成 manual 的档）+ 落扫描提问
    await store.ensureSession(meta({ mode: "skip", piSessionFile: "/pi/a.jsonl" }));
    await store.ensureSession(meta({ mode: "manual", piSessionFile: "/pi/a.jsonl" }));
    await store.record(ID, userItem(buildClosingScanPrompt({ sinceTurn: 1, lastTurn: 1, turns: [] }), 4000));
    assert.equal((await store.load(ID))?.meta.mode, "skip");
  });

  test("列表按 updatedAt 倒序——新的在前", async () => {
    await store.ensureSession(meta({ id: ID, updatedAt: 1000 }));
    await store.ensureSession(meta({ id: OTHER, updatedAt: 5000 }));
    assert.deepEqual((await store.list()).map((m) => m.id), [OTHER, ID]);
  });

  test("meta 坏了就跳过这条，不让一条坏记录挡住整张列表", async () => {
    await store.ensureSession(meta({ id: ID }));
    await writeFile(join(dir, "sessions", `${OTHER}.meta.json`), "{ 这不是 JSON", "utf8");
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
  });

  // 只追加的文件断电时最后一行可能只写了一半
  test("日志里的半截行跳过，前面读到的照常返回", async () => {
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
    await store.setMode(ID, "skip");
    assert.equal((await store.load(ID))?.meta.mode, "skip");
  });

  test("setThinkingLevel 落盘——重开与下一轮开机的装配都读它", async () => {
    await store.ensureSession(meta());
    await store.setThinkingLevel(ID, "high");
    assert.equal((await store.load(ID))?.meta.thinkingLevel, "high");
  });

  test("setModel 落 meta——重开播种、分支继承读的就是它（C-4）", async () => {
    await store.ensureSession(meta());
    await store.setModel(ID, "other", "m2");
    const loaded = (await store.load(ID))?.meta;
    assert.equal(loaded?.providerId, "other");
    assert.equal(loaded?.modelId, "m2");
  });

  // 星标是价值标记，与置顶（排序）正交：翻转只动自己这一个字段，
  // 别把用户的置顶或归档悄悄带走
  test("setStarred 翻转星标，pinned / archived 不被波及", async () => {
    await store.ensureSession(meta({ pinned: true }));
    await store.setStarred(ID, true);
    let after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.starred, true);
    assert.equal(after?.pinned, true);
    assert.equal(after?.archived, false);
    await store.setStarred(ID, false);
    after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.starred, false);
    assert.equal(after?.pinned, true);
  });

  // 与 update 的既有语义一致：meta 不在就悄悄不做，不为它抛错或重建文件
  test("setStarred 对不存在的会话悄悄不做", async () => {
    await store.setStarred(ID, true);
    assert.deepEqual(await store.list(), []);
  });

  // 未读标记（2026-10-10 落盘）：标 / 清只动这一个字段；重启后读回还是它
  test("setUnread 标未读与清未读，别的字段不被波及", async () => {
    await store.ensureSession(meta({ pinned: true }));
    await store.setUnread(ID, { at: 1234, failed: true });
    let after = (await store.list()).find((m) => m.id === ID);
    assert.deepEqual(after?.unread, { at: 1234, failed: true });
    assert.equal(after?.pinned, true);
    await store.setUnread(ID, null);
    after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.unread, null);
  });

  // 完成状态机：翻到 done 的那一刻记下关闭时刻；reopen（回 open）清空——
  // closedAt 与 completion 同进退，不留「open 却带着关闭时刻」的半态
  test("setCompletion：done 记关闭时刻，reopen 清空，done_with_todos 也可写", async () => {
    await store.ensureSession(meta({ pinned: true }));
    await store.setStarred(ID, true);
    await store.setCompletion(ID, "done");
    let after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.completion, "done");
    assert.ok(typeof after?.closedAt === "number" && after.closedAt > 0);
    // 完成只动自己这对字段：置顶/星标/归档原样
    assert.equal(after?.pinned, true);
    assert.equal(after?.starred, true);
    assert.equal(after?.archived, false);

    await store.setCompletion(ID, "open"); // reopen
    after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.completion, "open");
    assert.equal(after?.closedAt, null);

    await store.setCompletion(ID, "done_with_todos");
    after = (await store.list()).find((m) => m.id === ID);
    assert.equal(after?.completion, "done_with_todos");
    assert.ok(typeof after?.closedAt === "number" && after.closedAt > 0);
  });

  // 重复 Mark done 不该刷新关闭时刻——「什么时候干完的」是历史事实，不是最后一次点击
  test("setCompletion 同态幂等：done 再 done 不改关闭时刻", async () => {
    await store.ensureSession(meta());
    await store.setCompletion(ID, "done");
    const first = (await store.load(ID))?.meta.closedAt;
    // 隔开毫秒：非幂等实现会在这里刷新出新的 Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.setCompletion(ID, "done");
    assert.equal((await store.load(ID))?.meta.closedAt, first);
  });

  // 遗留事项闭环：继续开出的会话记下它接的是哪条；收尾确认时取走（交给调用方标做完）并清空
  test("addResumedCarryover 去重；confirmWrapup 追加收尾记录、翻完成状态、取走在做的遗留事项", async () => {
    await store.ensureSession(meta({ starred: true }));
    await store.addResumedCarryover(ID, "c1");
    await store.addResumedCarryover(ID, "c1");
    await store.addResumedCarryover(ID, "c2");
    assert.deepEqual((await store.load(ID))?.meta.resumedCarryovers, ["c1", "c2"]);
    const wrapup = { id: "w1", at: 5, throughTurn: 3, items: [] };
    assert.deepEqual(await store.confirmWrapup(ID, wrapup, "done_with_todos"), { resumed: ["c1", "c2"] });
    const after = (await store.load(ID))?.meta;
    assert.equal(after?.resumedCarryovers, undefined);
    assert.deepEqual(after?.wrapups, [wrapup]);
    assert.equal(after?.completion, "done_with_todos");
    assert.equal(after?.starred, true);
    // 重开后再确认：收尾记录累加，在做的已清空
    await store.setCompletion(ID, "open");
    assert.deepEqual(await store.confirmWrapup(ID, { ...wrapup, id: "w2", throughTurn: 5 }, "done"), { resumed: [] });
    assert.deepEqual((await store.load(ID))?.meta.wrapups?.map((w) => w.id), ["w1", "w2"]);
    assert.equal(await store.confirmWrapup("00000000-0000-4000-8000-000000000000", wrapup, "done"), null);
  });

  // 与 setStarred 同一条语义：meta 不在就悄悄不做
  test("setCompletion 对不存在的会话悄悄不做", async () => {
    await store.setCompletion(ID, "done");
    assert.deepEqual(await store.list(), []);
  });

  // id 从 renderer 经 IPC 进来，直接拼路径的话一个 ../../ 就能写到别处
  test("非法 id 一律拒绝，不落在 sessions 目录之外", async () => {
    for (const bad of ["../../etc/passwd", "..", "a/b", "", "not-a-uuid", `${ID}/../x`]) {
      await assert.rejects(() => store.ensureSession(meta({ id: bad })), /invalid session id/);
      await assert.rejects(() => store.remove(bad), /invalid session id/);
    }
  });

  test("原子写不留临时文件", async () => {
    await store.ensureSession(meta());
    await store.record(ID, userItem("x"));
    const names = await readdir(join(dir, "sessions"));
    assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
  });

  test("日志是一行一条 JSON，人能直接读", async () => {
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
    await store.record(ID, userItem("旧消息"));
    const transcript = (await store.load(ID))?.transcript ?? [];
    assert.deepEqual(transcript.map((r) => r.role), ["user"]);
  });

  // ── C-3：auto-title ──

  test("needsAutoTitle：derived 要，user / auto / meta 没了都不要", async () => {
    await store.ensureSession(meta());
    assert.equal(await store.needsAutoTitle(ID), true);
    await store.setAutoTitle(ID, "模型起的");
    assert.equal(await store.needsAutoTitle(ID), false);
    await store.rename(ID, "用户起的");
    assert.equal(await store.needsAutoTitle(ID), false);
    assert.equal(await store.needsAutoTitle(OTHER), false);
  });

  test("setAutoTitle 落标题并标成 auto", async () => {
    await store.ensureSession(meta());
    await store.setAutoTitle(ID, "修复登录按钮");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "修复登录按钮");
    assert.equal(detail?.meta.titleSource, "auto");
  });

  test("setAutoTitle 不覆盖用户改过的名字", async () => {
    await store.ensureSession(meta());
    await store.rename(ID, "我的名字");
    await store.setAutoTitle(ID, "模型猜的名字");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "我的名字");
    assert.equal(detail?.meta.titleSource, "user");
  });

  test("setAutoTitle 的迟到标题不重复写：auto 之后整份丢弃", async () => {
    await store.ensureSession(meta());
    await store.setAutoTitle(ID, "第一个标题");
    await store.setAutoTitle(ID, "迟到的标题");
    assert.equal((await store.load(ID))?.meta.title, "第一个标题");
  });

  test("setAutoTitle 拿到空结果就不写，门禁保持 derived", async () => {
    await store.ensureSession(meta());
    await store.setAutoTitle(ID, "  \n ");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "");
    assert.equal(detail?.meta.titleSource, "derived");
    assert.equal(await store.needsAutoTitle(ID), true);
  });

  test("rename 改空也记成 user——用户清掉的名字不该自己长回来", async () => {
    await store.ensureSession(meta());
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

  /** 我们不落盘的空 error 回答：status=error 且内容为空 */
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
    await store.ensureSession(meta({ title: "读一下项目", piSessionFile: PI_FILE, pinned: true }));
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
    assert.equal(plan.meta.title, "读一下项目 (branch)");
    assert.equal(plan.meta.cwd, meta().cwd);
    assert.equal(plan.meta.piSessionFile, null);
    assert.equal(plan.meta.pinned, false);
  });

  test("prepareBranch：meta.stats 聚合前缀用量，contextUsage 如实为 null（A-2）", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    const withUsage = (
      id: string,
      text: string,
      output: number,
      costTotal: number,
    ): TranscriptItem => ({
      id,
      role: "assistant",
      content: [{ type: "text", text }],
      model: { provider: "zai", id: "glm-5.3" },
      timestamp: 3000,
      status: "complete",
      stopReason: "stop",
      usage: {
        input: 100,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100 + output,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: costTotal },
      },
    });
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, withUsage("a1", "答一", 50, 0.3));
    await store.record(ID, emptyError("e1"));
    await store.record(ID, item("u2", "user", "再问"));
    await store.record(ID, withUsage("a2", "答二", 70, 0.5));
    const plan = await store.prepareBranch(ID, "a2");

    // 累计是真历史：两条带 usage 的回答相加；error 尾巴（无 usage）自然不参与
    assert.deepEqual(plan.meta.stats, {
      tokens: { input: 200, output: 120, cacheRead: 0, cacheWrite: 0, total: 320 },
      cost: 0.8,
      // 余量取决于 pi 按裁剪后上下文现算，聚合不出来——如实 null，UI 显示未知
      contextUsage: null,
    });
  });

  test("prepareBranch：前缀没有任何 usage 就没有账本（stats: null）", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    const plan = await store.prepareBranch(ID, "a1");
    assert.equal(plan.meta.stats, null);
  });

  test("prepareBranch：锚点不存在 / 不是 assistant / 没有 pi 本子，都拒绝", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问题"));
    await store.record(ID, item("a1", "assistant", "回答"));
    await assert.rejects(() => store.prepareBranch(ID, "nope"), /Branch anchor message not found/);
    await assert.rejects(() => store.prepareBranch(ID, "u1"), /must be an agent reply/);
    await assert.rejects(
      () => store.prepareBranch("00000000-0000-4000-8000-000000000000", "a1"),
      /not found/,
    );

    await store.ensureSession(meta({ id: OTHER, piSessionFile: null }));
    await assert.rejects(() => store.prepareBranch(OTHER, "a1"), /not continued or branched/);
  });

  test("commitBranch：meta 补上 pi 文件、JSONL 逐行等于前缀、列表能看到新会话", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
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
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    const plan = await store.prepareBranch(ID, "a1");
    await assert.rejects(() => store.commitBranch(plan, null), /no branch session file/);
    assert.equal(await store.load(plan.newId), null);
  });
});

describe("branchRoles —— channel-mark 计作 user（子会话 2026-09-23 不变量修正）", () => {
  const mark = (id: string): ChannelMarkRecord => ({
    role: "channel-mark",
    id,
    peerId: "child-1",
    messageId: "msg-1",
    from: "child",
    kind: "question",
    timestamp: 4000,
  });

  test("channel-mark 顶替的是 pi 本子里的一条 user 消息，按位对账要把它算作 user", () => {
    const records = [
      { id: "u1", role: "user", content: [{ type: "text", text: "问" }], timestamp: 1000 } as TranscriptItem,
      { id: "a1", role: "assistant", content: [{ type: "text", text: "答" }], model: { provider: "zai", id: "glm-5.3" }, timestamp: 2000, status: "complete", stopReason: "stop" } as TranscriptItem,
      mark("k1"),
      { id: "a2", role: "assistant", content: [{ type: "text", text: "收到" }], model: { provider: "zai", id: "glm-5.3" }, timestamp: 5000, status: "complete", stopReason: "stop" } as TranscriptItem,
    ];
    assert.deepEqual(branchRoles(records), ["user", "assistant", "user", "assistant"]);
  });

  test("普通 user/assistant 与空 error 回答的既有规则不受影响", () => {
    const emptyError = {
      id: "e1",
      role: "assistant",
      content: [],
      model: { provider: "zai", id: "glm-5.3" },
      timestamp: 3000,
      status: "error",
      stopReason: "error",
    } as TranscriptItem;
    const records = [
      { id: "u1", role: "user", content: [{ type: "text", text: "问" }], timestamp: 1000 } as TranscriptItem,
      emptyError,
      mark("k1"),
    ];
    assert.deepEqual(branchRoles(records), ["user", "user"]);
  });
});

// ── 工作台生命周期：stat / 删除连带 / 分支拷贝（2026-09-22 裁决）──

describe("SessionStore.workbench", () => {
  const PI_FILE = "C:/pi-sessions/source.jsonl";

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

  test("workbenchStat 三态：不存在 / 空目录 / 嵌套两个文件（目录不计）", async () => {
    // 不存在：exists=false、fileCount=0，path 照给（renderer 不自己拼路径）
    let stat = await store.workbenchStat(ID);
    assert.deepEqual(stat, { path: join(dir, "workbenches", ID), exists: false, fileCount: 0 });

    // 空目录：存在但没文件
    await mkdir(join(dir, "workbenches", ID), { recursive: true });
    stat = await store.workbenchStat(ID);
    assert.deepEqual({ exists: stat.exists, fileCount: stat.fileCount }, { exists: true, fileCount: 0 });

    // 嵌套：子目录里的文件也数，目录本身不数
    await mkdir(join(dir, "workbenches", ID, "plan"), { recursive: true });
    await writeFile(join(dir, "workbenches", ID, "a.txt"), "x", "utf8");
    await writeFile(join(dir, "workbenches", ID, "plan", "p.md"), "y", "utf8");
    stat = await store.workbenchStat(ID);
    assert.equal(stat.fileCount, 2);
  });

  test("remove 连带删工作台（先删账本后删工作台）", async () => {
    await store.ensureSession(meta());
    await mkdir(join(dir, "workbenches", ID, "plan"), { recursive: true });
    await writeFile(join(dir, "workbenches", ID, "plan", "p.md"), "y", "utf8");
    await store.remove(ID);
    assert.deepEqual(await readdir(join(dir, "sessions")), []);
    assert.equal((await store.workbenchStat(ID)).exists, false);
  });

  test("remove 对没有工作台的会话也照常（rm force 吞 ENOENT）", async () => {
    await store.ensureSession(meta());
    await store.remove(ID);
    assert.equal((await store.workbenchStat(ID)).exists, false);
  });

  test("branch 后新 id 的工作台是源的完整拷贝，源不动", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    await mkdir(join(dir, "workbenches", ID, "sub"), { recursive: true });
    await writeFile(join(dir, "workbenches", ID, "root.txt"), "a", "utf8");
    await writeFile(join(dir, "workbenches", ID, "sub", "b.txt"), "b", "utf8");

    const plan = await store.prepareBranch(ID, "a1");
    await store.commitBranch(plan, "C:/pi-sessions/branch.jsonl");

    const stat = await store.workbenchStat(plan.newId);
    assert.equal(stat.exists, true);
    assert.equal(stat.fileCount, 2);
    // 内容一致（不只是数量对）
    assert.equal(await readFile(join(dir, "workbenches", plan.newId, "root.txt"), "utf8"), "a");
    assert.equal(await readFile(join(dir, "workbenches", plan.newId, "sub", "b.txt"), "utf8"), "b");
    // 源不动：拷贝不是移动
    assert.equal((await store.workbenchStat(ID)).fileCount, 2);
  });

  test("branch 的源没有工作台时，新的也不存在（不预建）", async () => {
    await store.ensureSession(meta({ piSessionFile: PI_FILE }));
    await store.record(ID, item("u1", "user", "问"));
    await store.record(ID, item("a1", "assistant", "答"));
    const plan = await store.prepareBranch(ID, "a1");
    await store.commitBranch(plan, "C:/pi-sessions/branch.jsonl");
    assert.equal((await store.workbenchStat(plan.newId)).exists, false);
  });
});

// ── 子会话：后代收集与级联删（2026-09-22/23 裁决）──

describe("SessionStore.descendants / 级联删", () => {
  const CHILD = "d1e2f3a4-5b6c-4d7e-8f90-1a2b3c4d5e6f";
  const SIBLING = "f3a4b5c6-7d8e-4f90-a123-3c4d5e6f7081";
  const GRANDCHILD = "e2f3a4b5-6c7d-4e8f-9012-2b3c4d5e6f70";

  const taskMessage = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
    id: "m1",
    from: "parent",
    author: "model",
    kind: "task",
    text: "去把外壳重做",
    delivery: "followUp",
    createdAt: 1,
    ...overrides,
  });

  test("descendants：递归收集子与孙，不含自己", async () => {
    await store.ensureSession(meta({ id: ID }));
    await store.ensureSession(meta({ id: CHILD, parentId: ID }));
    await store.ensureSession(meta({ id: GRANDCHILD, parentId: CHILD }));
    assert.deepEqual([...(await store.descendants(ID))].sort(), [CHILD, GRANDCHILD].sort());
    assert.deepEqual(await store.descendants(CHILD), [GRANDCHILD]);
    assert.deepEqual(await store.descendants(GRANDCHILD), []);
  });

  test("workbenchStat 求和：自己 + 全部后代的工作台文件数；exists 是任一存在，path 仍是自己的", async () => {
    await store.ensureSession(meta({ id: ID }));
    await store.ensureSession(meta({ id: CHILD, parentId: ID }));
    // 自己没有工作台，子有——exists 仍该是 true
    await mkdir(join(dir, "workbenches", CHILD), { recursive: true });
    await writeFile(join(dir, "workbenches", CHILD, "a.txt"), "x", "utf8");
    const stat = await store.workbenchStat(ID);
    assert.equal(stat.exists, true);
    assert.equal(stat.fileCount, 1);
    assert.equal(stat.path, join(dir, "workbenches", ID));
  });

  test("remove 级联：删父连带删子、孙，各自的工作台与通道文件都没了", async () => {
    const channels = new ChannelStore(join(dir, "channels"));
    const withChannels = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"), channels);
    await withChannels.ensureSession(meta({ id: ID }));
    await withChannels.ensureSession(meta({ id: CHILD, parentId: ID }));
    await withChannels.ensureSession(meta({ id: GRANDCHILD, parentId: CHILD }));
    await mkdir(join(dir, "workbenches", CHILD), { recursive: true });
    await writeFile(join(dir, "workbenches", CHILD, "a.txt"), "x", "utf8");
    await channels.append({ parentId: ID, childId: CHILD }, taskMessage());
    await channels.append({ parentId: CHILD, childId: GRANDCHILD }, taskMessage({ id: "m2" }));

    await withChannels.remove(ID);

    assert.equal(await withChannels.load(ID), null);
    assert.equal(await withChannels.load(CHILD), null);
    assert.equal(await withChannels.load(GRANDCHILD), null);
    assert.equal((await withChannels.workbenchStat(CHILD)).exists, false);
    assert.deepEqual(await channels.load({ parentId: ID, childId: CHILD }), []);
    assert.deepEqual(await channels.load({ parentId: CHILD, childId: GRANDCHILD }), []);
  });

  /**
   * 删除顺序回归：`remove()` 必须后代先、自己最后（可见的残留优于隐形的
   * 残留，同 removeOne 前的顺序纪律）。反过来先删自己的话，两条单条清理
   * 之间崩溃会让没删完的后代变成「parentId 指向不存在的会话」的隐形残留。
   *
   * 用一个只在处理 ID（父）这一步才抛错的 ChannelStore 子类模拟「中途崩溃」：
   * 若顺序是对的（子先于父），CHILD 在崩溃发生前已经被完整删掉；若顺序反了
   * （父先于子，旧的 bug），错误会在最开始就抛出，CHILD 完全没被处理过——
   * 下面对 CHILD 的断言会在那种情况下失败，从而把顺序钉住。
   */
  test("清理顺序是后代先、自己最后——中途失败时已处理的后代先于自己被删掉", async () => {
    class FailOnParent extends ChannelStore {
      async removeForParent(parentId: string): Promise<void> {
        if (parentId === ID) throw new Error("模拟处理到父这一步时崩溃");
        return super.removeForParent(parentId);
      }
    }
    const failingChannels = new FailOnParent(join(dir, "channels"));
    const storeWithFailure = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"), failingChannels);
    await storeWithFailure.ensureSession(meta({ id: ID }));
    await storeWithFailure.ensureSession(meta({ id: CHILD, parentId: ID }));

    await assert.rejects(() => storeWithFailure.remove(ID), /模拟处理到父这一步时崩溃/);

    // 子已经被完整删掉（后代先处理完）；父的自身清理没跑到，还在——
    // 中途崩溃后父依然可见，不是「parentId 指向不存在的会话」那种隐形残留
    assert.equal(await storeWithFailure.load(CHILD), null);
    assert.notEqual(await storeWithFailure.load(ID), null);
  });

  test("只删子：父留着、兄弟不受影响，只删那一份通道文件", async () => {
    const channels = new ChannelStore(join(dir, "channels"));
    const withChannels = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"), channels);
    await withChannels.ensureSession(meta({ id: ID }));
    await withChannels.ensureSession(meta({ id: CHILD, parentId: ID }));
    await withChannels.ensureSession(meta({ id: SIBLING, parentId: ID }));
    await channels.append({ parentId: ID, childId: CHILD }, taskMessage());
    await channels.append({ parentId: ID, childId: SIBLING }, taskMessage({ id: "m2" }));

    await withChannels.remove(CHILD);

    assert.notEqual(await withChannels.load(ID), null);
    assert.equal(await withChannels.load(CHILD), null);
    assert.notEqual(await withChannels.load(SIBLING), null);
    assert.deepEqual(await channels.load({ parentId: ID, childId: CHILD }), []);
    assert.equal((await channels.load({ parentId: ID, childId: SIBLING })).length, 1);
  });

  test("remove 不传 channels 时（旧调用点）只删会话本身，不碰通道文件", async () => {
    // 顶层 store（beforeEach 建的）没有注入 channels——remove 应静默跳过级联那两步
    await store.ensureSession(meta({ id: ID }));
    await store.ensureSession(meta({ id: CHILD, parentId: ID }));
    await store.remove(ID);
    assert.equal(await store.load(ID), null);
    // 子的 meta 一起被级联删了（级联不依赖 channels 是否注入）
    assert.equal(await store.load(CHILD), null);
  });

  // parentId 成环只可能来自手改 meta（正常生产者——delegate、导入器——都不会造出
  // 环），但手改是真实存在的输入源：递归不能因此无限展开撑爆栈。
  test("descendants 在成环的 meta 下也能返回且不挂（防环）", async () => {
    await store.ensureSession(meta({ id: ID, parentId: CHILD }));
    await store.ensureSession(meta({ id: CHILD, parentId: ID })); // 互指成环
    const result = await store.descendants(ID);
    assert.deepEqual([...result].sort(), [CHILD]); // 环上只收一次，不含自己
  });

  test("remove 在成环的 meta 下也能结束（防环），两条都被删掉", async () => {
    await store.ensureSession(meta({ id: ID, parentId: CHILD }));
    await store.ensureSession(meta({ id: CHILD, parentId: ID })); // 互指成环
    await store.remove(ID);
    assert.equal(await store.load(ID), null);
    assert.equal(await store.load(CHILD), null);
  });
});

// ── A-1 回归：meta 的「读-改-写」必须串行（wafo 2026-09-03 实测）──

describe("meta 并发写入", () => {
  /**
   * 首轮的真实时序：主进程收到 `created` 后同步发起 `ensureSession`，下一个端口消息
   * 就是首条用户消息的 `record`——两者几乎同时在飞，谁都没 await 谁。
   *
   * 修之前 `record` 直接 `readMeta`，在 `ensureSession` 写盘之前就读到 null 并 return，
   * 首条用户消息既不进 JSONL 也不填标题（2026-09-12 实测：会话磁盘上只剩 assistant，
   * 侧栏永远显示 New task，重开会话比当时少一截）。
   */
  test("建 meta 与首条用户消息并发：记录不丢，标题照样 derive", async () => {
    const store = new SessionStore(dir);
    // 故意不 await：复现两者并发入链的那一拍
    const created = store.ensureSession(meta());
    await store.record(ID, userItem("帮我看看目录结构", 2000));
    await created;

    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 1, "首条用户消息必须在盘上");
    assert.equal(detail?.transcript[0]?.role, "user");
    assert.equal(detail?.meta.title, "帮我看看目录结构", "标题由首条用户消息 derive");
  });

  test("ensureSession 对已存在的会话只校准 pi 本子，不盖已有字段", async () => {
    const store = new SessionStore(dir);
    await store.ensureSession(meta({ piSessionFile: null }));
    await store.setAutoTitle(ID, "已经起好的名字");
    // 续轮又来一次：带着一份刚拼的初始 meta（title 空、titleSource derived）
    await store.ensureSession(meta({ piSessionFile: "/pi/s1.jsonl" }));

    const after = (await store.list())[0];
    assert.equal(after?.piSessionFile, "/pi/s1.jsonl", "pi 本子要校准");
    assert.equal(after?.title, "已经起好的名字", "标题不能被初始 meta 盖回空");
    assert.equal(after?.titleSource, "auto");
  });

  test("标题落盘不会被同时在跑的用量落盘冲回 derived", async () => {
    const store = new SessionStore(dir);
    await store.ensureSession(meta());
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
    await store.ensureSession(meta());
    await store.setAutoTitle(ID, "先到的");
    await store.setAutoTitle(ID, "迟到的");
    assert.equal((await store.list())[0]?.title, "先到的");
  });

  test("用户改过名之后，模型标题永不覆盖", async () => {
    const store = new SessionStore(dir);
    await store.ensureSession(meta());
    await store.rename(ID, "我自己起的");
    await store.setAutoTitle(ID, "模型起的");
    const after = (await store.list())[0];
    assert.equal(after?.title, "我自己起的");
    assert.equal(after?.titleSource, "user");
  });

  test("删会话时在途的写入不会把 meta 又写回来", async () => {
    const store = new SessionStore(dir);
    await store.ensureSession(meta());
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

describe("SessionStore · 附图原图", () => {
  const png = { type: "image" as const, data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" };

  test("存下原图并铸引用，按引用读回同一份字节", async () => {
    await store.ensureSession(meta());
    const [sent] = await store.saveOriginals(ID, [png]);
    assert.match(sent?.original ?? "", new RegExp(`^${ID}/[0-9a-f-]{36}\\.png$`));
    assert.equal(sent?.data, png.data);
    assert.deepEqual(await store.readOriginal(sent?.original), png);
  });

  test("renderer 带来的 original 不认，一律重铸", async () => {
    const [sent] = await store.saveOriginals(ID, [{ ...png, original: "../../etc/passwd" } as typeof png]);
    assert.notEqual(sent?.original, "../../etc/passwd");
    assert.match(sent?.original ?? "", new RegExp(`^${ID}/`));
  });

  test("原图在会话目录下，list 不把它当会话", async () => {
    await store.ensureSession(meta());
    await store.saveOriginals(ID, [png]);
    assert.ok((await readdir(join(dir, "sessions"))).includes(`${ID}.attachments`));
    assert.deepEqual((await store.list()).map((m) => m.id), [ID]);
  });

  test("不合格的引用与不存在的文件都读成 null", async () => {
    assert.equal(await store.readOriginal("../x.png"), null);
    assert.equal(await store.readOriginal(42), null);
    assert.equal(await store.readOriginal(`${ID}/5b0d1a52-8c7e-4c52-9d0b-3f6a2b1c9e10.png`), null);
  });

  test("准入之外的格式不存盘、不带引用（agent 进程会整条拒掉）", async () => {
    const [sent] = await store.saveOriginals(ID, [{ ...png, mimeType: "image/heic" }]);
    assert.equal(sent?.original, undefined);
  });

  test("删会话连带删原图", async () => {
    await store.ensureSession(meta());
    const [sent] = await store.saveOriginals(ID, [png]);
    await store.remove(ID);
    assert.equal(await store.readOriginal(sent?.original), null);
    assert.equal((await readdir(join(dir, "sessions"))).includes(`${ID}.attachments`), false);
  });
});

describe("SessionStore · 文件引用落盘", () => {
  test("external 的复制进 <uuid>/<原名> 子目录，文件名保留、内容一致、原文件不动", async () => {
    await store.ensureSession(meta());
    const source = join(dir, "outside", "notes.txt");
    await mkdir(join(dir, "outside"), { recursive: true });
    await writeFile(source, "hello attachment");
    const [sent] = await store.saveExternalFiles(ID, [
      { path: source, name: "notes.txt", kind: "file", origin: "external" },
    ]);
    assert.equal(sent?.name, "notes.txt");
    assert.equal(sent?.kind, "file");
    // 副本在会话目录的 uuid 子目录里、末段是原文件名（uuid.txt 谁也认不出是什么）
    assert.match(sent?.path ?? "", new RegExp(`[\\\\/]${ID}\\.attachments[\\\\/][0-9a-f-]{36}[\\\\/]notes\\.txt$`));
    assert.equal(await readFile(sent?.path ?? "", "utf8"), "hello attachment");
    assert.equal(await readFile(source, "utf8"), "hello attachment");
  });

  test("目录名带点、文件无扩展名（…/guanhong.li/Makefile）不再误截扩展名", async () => {
    await store.ensureSession(meta());
    const source = join(dir, "guanhong.li", "Makefile");
    await mkdir(join(dir, "guanhong.li"), { recursive: true });
    await writeFile(source, "make it");
    const [sent] = await store.saveExternalFiles(ID, [
      { path: source, name: "Makefile", kind: "file", origin: "external" },
    ]);
    assert.match(sent?.path ?? "", new RegExp(`[\\\\/]Makefile$`));
    assert.equal(await readFile(sent?.path ?? "", "utf8"), "make it");
  });

  test("workspace 的原位置引用不复制，路径 realpath 成规范形", async () => {
    const source = join(dir, "workspace-root", "a.ts");
    await mkdir(join(dir, "workspace-root"), { recursive: true });
    await writeFile(source, "export {};");
    const [sent] = await store.saveExternalFiles(ID, [
      { path: source, name: "a.ts", kind: "file", origin: "workspace" },
    ]);
    assert.equal(sent?.path, await realpath(source));
    const attachments = join(dir, "sessions", `${ID}.attachments`);
    await assert.rejects(readFile(join(attachments, "a.ts")), Error);
  });

  test("external 的目录不复制、按原位置引用；盘上没有的路径原样带上不抛错", async () => {
    const externalDir = join(dir, "outside-dir");
    await mkdir(externalDir, { recursive: true });
    const [dirRef] = await store.saveExternalFiles(ID, [
      { path: externalDir, name: "outside-dir", kind: "dir", origin: "external" },
    ]);
    assert.equal(dirRef?.kind, "dir");
    assert.equal(dirRef?.path, await realpath(externalDir));
    const [missing] = await store.saveExternalFiles(ID, [
      { path: join(dir, "gone.txt"), name: "gone.txt", kind: "file", origin: "external" },
    ]);
    assert.equal(missing?.path, join(dir, "gone.txt"));
  });

  test("超过复制上限的 external 文件不复制、按原位置引用；未超限的照旧复制（注入小阈值，不真写 100MB）", async () => {
    await store.ensureSession(meta());
    await mkdir(join(dir, "outside"), { recursive: true });
    const big = join(dir, "outside", "big.bin");
    await writeFile(big, "0123456789"); // 10 字节
    const small = join(dir, "outside", "small.txt");
    await writeFile(small, "abc");
    const [bigSent, smallSent] = await store.saveExternalFiles(
      ID,
      [
        { path: big, name: "big.bin", kind: "file", origin: "external" },
        { path: small, name: "small.txt", kind: "file", origin: "external" },
      ],
      5, // 上限 5 字节：big 超限、small 不超
    );
    // 超限的按原位置引用（realpath 规范形），不进会话附件目录
    assert.equal(bigSent?.kind, "file");
    assert.equal(bigSent?.path, await realpath(big));
    // 未超限的照旧复制进 <uuid>/原名 子目录
    assert.match(smallSent?.path ?? "", new RegExp(`[\\\\/]${ID}\\.attachments[\\\\/][0-9a-f-]{36}[\\\\/]small\\.txt$`));
    assert.equal(await readFile(smallSent?.path ?? "", "utf8"), "abc");
  });
});

describe("SessionStore.assignModel（给导入的会话分配模型）", () => {
  test("占位会话写入目标，importedModel 原样保留", async () => {
    await store.ensureSession(
      meta({ id: ID, providerId: UNASSIGNED_PROVIDER_ID, modelId: "glm-5.3", importedModel: "glm-5.3" }),
    );
    assert.equal(await store.assignModel(ID, "zai", "glm-5.3"), true);
    const after = await store.readMeta(ID);
    assert.equal(after?.providerId, "zai");
    assert.equal(after?.modelId, "glm-5.3");
    // 分配不抹掉「原来用的是谁」的记录
    assert.equal(after?.importedModel, "glm-5.3");
  });

  test("已是真实 provider 的会话不覆盖（用户手选过的绝不碰），返回 false", async () => {
    await store.ensureSession(meta({ id: ID, providerId: "kimi", modelId: "kimi-k3" }));
    assert.equal(await store.assignModel(ID, "zai", "glm-5.3"), false);
    const after = await store.readMeta(ID);
    assert.equal(after?.providerId, "kimi");
    assert.equal(after?.modelId, "kimi-k3");
  });

  test("meta 不在（刚被删）静默 false，不抛错", async () => {
    assert.equal(await store.assignModel("no-such-session", "zai", "glm-5.3"), false);
  });
});

// ── 源侧分页：尾窗与 loadOlder ──

/**
 * 一条真实会话的形状：每轮 = 一条 user + 一条 assistant + n 条工具行。
 * 工具行占多数是实测的样子（25MB 那条会话里 tool 结果的字节数占绝对多数），
 * 窗口切点落在工具行中间正是要防的 case。
 */
const turnBlock = (n: number, tools: number): SessionRecord[] => {
  const records: SessionRecord[] = [
    { id: `u${n}`, role: "user", content: [{ type: "text", text: `第 ${n} 问` }], timestamp: 1000 + n } as TranscriptItem,
    {
      id: `a${n}`,
      role: "assistant",
      content: [{ type: "text", text: `第 ${n} 答` }],
      model: { provider: "zai", id: "glm-5.3" },
      timestamp: 1000 + n,
      status: "complete",
      stopReason: "stop",
    } as TranscriptItem,
  ];
  for (let i = 0; i < tools; i += 1) {
    records.push({
      id: `t${n}-${i}`,
      role: "tool",
      toolCallId: `call-${n}-${i}`,
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "ok" }],
      timestamp: 1000 + n,
      status: "complete",
      isError: false,
    } as TranscriptItem);
  }
  return records;
};

/** 直接落一份 JSONL（record() 每条一次原子写，几百条的构造太慢） */
const seedLog = async (id: string, records: readonly SessionRecord[]): Promise<void> => {
  await seedRawLog(id, records.map((record) => JSON.stringify(record)));
};

/**
 * 按行落任意原始内容（坏行 / CRLF / 无尾换行 / 空文件的构造用）。
 * trailingNewline=false 时不补最后那个 \n，模拟断电写了一半的形状。
 */
const seedRawLog = async (id: string, lines: readonly string[], trailingNewline = true): Promise<void> => {
  await store.ensureSession(meta({ id }));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(
    join(dir, "sessions", `${id}.jsonl`),
    lines.length === 0 ? "" : `${lines.join("\n")}${trailingNewline ? "\n" : ""}`,
    "utf8",
  );
};

describe("SessionStore · 窗口分页", () => {
  test("长会话只回尾窗：一页条数、起点对齐 user、hasMore 为真", async () => {
    // 240 轮 × 5 条 = 1200 条；切点 1200-500 = 700 恰好落在轮首（u140）
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 1200);
    assert.equal(detail?.window.hasMore, true);
    assert.equal(detail?.transcript.length, SESSION_PAGE_RECORDS);
    assert.equal(detail?.transcript[0]?.id, "u140");
    assert.equal(detail?.transcript.at(-1)?.id, "t239-2");
  });

  test("切点落在工具行中间：窗口起点向前对齐到下一条 user（不留无主的半轮）", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    // 切点 1200-498 = 702 = t140-2（工具行）→ 对齐到 u141（705）
    const detail = await store.loadWindow(ID, 498);
    assert.equal(detail?.transcript[0]?.id, "u141");
    assert.equal(detail?.transcript[0]?.role, "user");
    assert.equal(detail?.transcript.length, 1200 - 705);
    // 被对齐吃掉的那几条不算丢：下一页还会取到
    assert.equal(detail?.window.hasMore, true);
  });

  test("窗口里一条 user 都没有（尾段全在同一轮里）：往回落到最后一条 user", async () => {
    // u0 + 599 条工具行 = 600 条，切点 100 之后没有 user
    const records: SessionRecord[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "问" }], timestamp: 1000 } as TranscriptItem,
    ];
    for (let i = 0; i < 599; i += 1) {
      records.push({
        id: `t${i}`,
        role: "tool",
        toolCallId: `call-${i}`,
        toolName: "bash",
        input: {},
        content: [{ type: "text", text: "ok" }],
        timestamp: 2000 + i,
        status: "complete",
        isError: false,
      } as TranscriptItem);
    }
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    // 宁可比一页稍大，也不给一段没有 user 的历史
    assert.equal(detail?.transcript.length, 600);
    assert.equal(detail?.transcript[0]?.role, "user");
    assert.equal(detail?.window.hasMore, false);
  });

  test("channel-mark 也是轮边界：切点落在它之前就从它开始", async () => {
    const records: SessionRecord[] = [
      ...turnBlock(0, 8),
      {
        role: "channel-mark",
        id: "k1",
        peerId: "child-1",
        messageId: "msg-1",
        from: "child",
        kind: "question",
        timestamp: 5000,
      },
      ...turnBlock(1, 19).slice(1), // 第二轮：只留 assistant + 工具行
    ];
    await seedLog(ID, records);
    // 31 条（10 + 标记 + 20），切点 31-25 = 6：6..9 无 user，第一条边界是 k1（下标 10）
    const detail = await store.loadWindow(ID, 25);
    assert.equal(detail?.transcript[0]?.role, "channel-mark");
    assert.equal(detail?.transcript[0]?.id, "k1");
  });

  test("compactionsBefore 只数窗口之前、生效视图里的压缩界碑", async () => {
    const boundary = (id: string, timestamp: number): SessionRecord => ({
      role: "compacted",
      id,
      summary: "## Goal",
      tokensBefore: 90_000,
      timestamp,
    });
    // 界碑与 user 一样是轮首；前 140 轮里插两块，尾窗里再插一块
    const records = Array.from({ length: 240 }, (_, n) => [
      ...(n === 30 ? [boundary("c30", 1029)] : []),
      ...(n === 90 ? [boundary("c90", 1089)] : []),
      ...(n === 200 ? [boundary("c200", 1199)] : []),
      ...turnBlock(n, 3),
    ]).flat();
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.hasMore, true);
    assert.equal(detail?.window.compactionsBefore, 2);
    assert.equal(detail?.transcript.filter((record) => record.role === "compacted").length, 1);
  });

  test("短会话整份进窗：compactionsBefore 为 0", async () => {
    await seedLog(ID, [
      { role: "compacted", id: "c1", summary: "s", tokensBefore: 1, timestamp: 999 },
      ...turnBlock(0, 2),
    ]);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.compactionsBefore, 0);
  });

  test("短会话不足一窗：全量返回，hasMore 为假", async () => {
    await seedLog(ID, turnBlock(0, 2));
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 4);
    assert.equal(detail?.window.hasMore, false);
    assert.deepEqual(detail?.transcript.map((record) => record.id), ["u0", "a0", "t0-0", "t0-1"]);
  });

  test("空会话（没有 JSONL）：空窗口，不是 null", async () => {
    await store.ensureSession(meta());
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 0);
    assert.equal(detail?.window.hasMore, false);
    assert.deepEqual(detail?.transcript, []);
  });

  test("meta 不在就是 null（与 load 同一条规矩）", async () => {
    assert.equal(await store.loadWindow(OTHER), null);
  });

  test("loadOlder：按 before 定位前一段，到头的那一页 hasMore 为假", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.transcript[0]?.id, "u140");

    const page1 = await store.loadOlder(ID, "u140", SESSION_PAGE_RECORDS);
    // 700 - 500 = 200 = u40（对齐后仍是轮首）
    assert.equal(page1.records[0]?.id, "u40");
    assert.equal(page1.records.length, SESSION_PAGE_RECORDS);
    assert.equal(page1.records.at(-1)?.id, "t139-2");
    assert.equal(page1.hasMore, true);

    const page2 = await store.loadOlder(ID, "u40", SESSION_PAGE_RECORDS);
    assert.equal(page2.records[0]?.id, "u0");
    assert.equal(page2.records.length, 200);
    assert.equal(page2.hasMore, false);

    // 拼回去正好是全量、且顺序不乱
    const rebuilt = [...page2.records, ...page1.records, ...(detail?.transcript ?? [])];
    assert.deepEqual(rebuilt.map((record) => record.id), records.map((record) => record.id));
  });

  test("loadOlder：锚点在盘上找不到（会话刚被回退）就回空页，不按旧下标切一段", async () => {
    await seedLog(ID, turnBlock(0, 2));
    const page = await store.loadOlder(ID, "不存在的记录 id", SESSION_PAGE_RECORDS);
    assert.deepEqual(page.records, []);
    assert.equal(page.hasMore, false);
  });

  test("loadOlder：锚点就是第一条时回空页、hasMore 为假", async () => {
    await seedLog(ID, turnBlock(0, 2));
    const page = await store.loadOlder(ID, "u0", SESSION_PAGE_RECORDS);
    assert.deepEqual(page.records, []);
    assert.equal(page.hasMore, false);
  });

  test("折叠语义不变：窗口从 fold 后的生效视图取，不是盘上的原始行", async () => {
    // 10 轮（50 条）+ 回退界碑（目标 = u5）+ 后两轮：生效视图只有 u5 之前 + 界碑 + 后两轮
    const records: SessionRecord[] = [
      ...Array.from({ length: 10 }, (_, n) => turnBlock(n, 3)).flat(),
      {
        role: "revert",
        id: "r1",
        targetMessageId: "u5",
        restored: [],
        timestamp: 9000,
      },
      ...turnBlock(10, 3),
      ...turnBlock(11, 3),
    ];
    await seedLog(ID, records);
    const effective = await store.load(ID);
    // 生效视图：25 条（u0..t4-2）+ 界碑 + 10 条 = 36 条
    assert.equal(effective?.transcript.length, 36);
    assert.equal(effective?.transcript.some((record) => record.id === "u5"), false);

    const detail = await store.loadWindow(ID, 30);
    assert.equal(detail?.window.total, 36);
    assert.equal(detail?.transcript[0]?.id, "u2"); // 切点 6 → 向前对齐到 u2（10）
    assert.equal(detail?.transcript.some((record) => record.role === "revert"), true);
    assert.equal(detail?.transcript.some((record) => record.id === "u5"), false);
    assert.equal(detail?.window.hasMore, true);
  });
});

describe("SessionStore · 窗口分页的行级语义", () => {
  // 这一组锁的是 readLogEntries 逐行落地与 foldReverts 的细粒度语义——
  // 换流式实现前后都必须逐位不变。

  test("中段的坏行（JSON 断裂）被跳过：total 与尾窗都当它不存在，落在窗口字节区间里的坏行也不进窗", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    const lines = records.map((record) => JSON.stringify(record));
    // 一条断在半截的行：在窗口之前（100）与窗口区间内（1150）各放一条
    lines[100] = '{"id":"broken-1","role":"assistant","content":[{"type":"text","text":"断在半截';
    lines[1150] = '{"id":"broken-2","role":"user","content":[{"type":"text","text":"也断';
    await seedRawLog(ID, lines);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 1198);
    // 生效视图去掉两条坏行后，切点 1198-500=698 对回原始下标 699（t139-2，工具行），
    // 向前对齐到 u140（699）：窗口 499 条，坏行不在其中
    assert.equal(detail?.transcript[0]?.id, "u140");
    assert.equal(detail?.transcript.length, 499);
    const ids = new Set(detail?.transcript.map((record) => record.id));
    assert.equal(ids.has("broken-1"), false);
    assert.equal(ids.has("broken-2"), false);
  });

  test("末尾没有换行的最后一行（合法 JSON）照常进窗", async () => {
    const records = [...turnBlock(0, 1), ...turnBlock(1, 1)];
    await seedRawLog(ID, records.map((record) => JSON.stringify(record)), false);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 6);
    assert.equal(detail?.transcript.at(-1)?.id, "t1-0");
  });

  test("末尾写了一半的行（断电形状）被跳过，前面的照常返回", async () => {
    const records = turnBlock(0, 1);
    await seedRawLog(
      ID,
      [...records.map((record) => JSON.stringify(record)), '{"id":"half","role":"user","content":[{"type":"text"'],
      false,
    );
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 3);
    assert.deepEqual(detail?.transcript.map((record) => record.id), ["u0", "a0", "t0-0"]);
  });

  test("CRLF 行结尾照常解析；只有 \r 的行与空白行不算记录", async () => {
    const records = [...turnBlock(0, 1), ...turnBlock(1, 1)];
    const lines = [
      `${JSON.stringify(records[0])}\r`, // \r 留在行尾，JSON.parse 容忍
      "\r", // 只有 \r 的行：trim 后是空行
      "   ", // 空白行
      "",
      JSON.stringify(records[1]),
      `${JSON.stringify(records[2])}\r`,
      `${JSON.stringify(records[3])}\r`,
      `${JSON.stringify(records[4])}\r`,
      `${JSON.stringify(records[5])}\r`,
    ];
    await seedRawLog(ID, lines);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 6);
    assert.deepEqual(
      detail?.transcript.map((record) => record.id),
      ["u0", "a0", "t0-0", "u1", "a1", "t1-0"],
    );
  });

  test("空文件（0 字节）与没有文件同待遇：空窗口；分页锚点找不到回空页", async () => {
    await seedRawLog(ID, []);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 0);
    assert.deepEqual(detail?.transcript, []);
    const page = await store.loadOlder(ID, "u0", 10);
    assert.deepEqual(page, { records: [], hasMore: false });
  });

  test("行首 BOM 的第一行 JSON.parse 失败被跳过（与旧读取同款行为）", async () => {
    const first = JSON.stringify({
      id: "u-bom",
      role: "user",
      content: [{ type: "text", text: "带 BOM 的行" }],
      timestamp: 1000,
    });
    await seedRawLog(ID, [`\u{feff}${first}`, ...turnBlock(0, 1).map((record) => JSON.stringify(record))]);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 3);
    assert.equal(detail?.transcript.some((record) => record.id === "u-bom"), false);
  });

  test("长着特殊角色的脸但字段不齐的行跳过；字段齐的界碑照常进窗并折叠", async () => {
    const lines = [
      JSON.stringify({ role: "compacted", id: "c-bad", tokensBefore: 1, timestamp: 1 }), // 缺 summary
      JSON.stringify({ role: "compacted", id: "c1", summary: "s", tokensBefore: 1, timestamp: 2 }),
      ...turnBlock(0, 1).map((record) => JSON.stringify(record)),
      JSON.stringify({ role: "revert", id: "r-bad", timestamp: 3 }), // 缺 targetMessageId / restored
      JSON.stringify({ role: "channel-mark", id: "k-bad", peerId: "p" }), // 缺 messageId / from / kind
      JSON.stringify({ role: "file-turn", id: "f-bad", changes: "nope", timestamp: 4 }), // changes 不是数组
      JSON.stringify({ role: "undo", id: "z-bad", restored: [], timestamp: 5 }), // 缺 turnId
      JSON.stringify({ role: "revert", id: "r1", targetMessageId: "u0", restored: [], timestamp: 6 }),
    ];
    await seedRawLog(ID, lines);
    const detail = await store.loadWindow(ID);
    // 只有 c1、turn 0 的三条与 r1 落地；r1 把视图折到 u0 之前 → [c1, r1]
    assert.equal(detail?.window.total, 2);
    assert.deepEqual(
      detail?.transcript.map((record) => record.role),
      ["compacted", "revert"],
    );
  });

  test("回退目标不在生效视图（已被更早的回退折掉）：只留界碑不折叠", async () => {
    const records: SessionRecord[] = [
      ...turnBlock(0, 0),
      ...turnBlock(1, 0),
      { role: "revert", id: "rv1", targetMessageId: "u1", restored: [], timestamp: 9000 },
      { role: "revert", id: "rv2", targetMessageId: "u1", restored: [], timestamp: 9001 },
    ];
    await seedLog(ID, records);
    // rv1 折掉 u1 及之后 → [u0, a0, rv1]；rv2 找不到 u1 → 不折叠只留界碑
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 4);
    assert.deepEqual(
      detail?.transcript.map((record) => record.id),
      ["u0", "a0", "rv1", "rv2"],
    );
  });

  test("窗口内含回退界碑：被折掉的行也落在同一段字节里，但不进窗", async () => {
    const records: SessionRecord[] = [
      ...turnBlock(0, 1),
      ...turnBlock(1, 1),
      ...turnBlock(2, 1),
      { role: "revert", id: "r1", targetMessageId: "a1", restored: [], timestamp: 9000 },
    ];
    await seedLog(ID, records);
    // rv 折到 a1 之前：生效视图 = [u0, a0, t0-0, u1, r1]，共 5 条；窗口从 u0 起，
    // 字节区间横跨被折掉的 a1..t2-0，返回的必须只有生效视图那 5 条
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 5);
    assert.deepEqual(
      detail?.transcript.map((record) => record.id),
      ["u0", "a0", "t0-0", "u1", "r1"],
    );
  });

  test("loadOlder 切点落在轮中间：起点向前对齐到下一条 user，被对齐吃掉的下一页还会取到", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    // before=u100（下标 500），limit=98：切点 402 = t80-2（工具行）→ 对齐到 u81（405）
    const page1 = await store.loadOlder(ID, "u100", 98);
    assert.equal(page1.records[0]?.id, "u81");
    assert.equal(page1.records.length, 95);
    assert.equal(page1.records.at(-1)?.id, "t99-2");
    assert.equal(page1.hasMore, true);
    // 下一页从 u81 往前取：对齐吃掉的 402..404（t80-0..t80-2）在这一页里回来
    const page2 = await store.loadOlder(ID, "u81", 98);
    assert.equal(page2.records[0]?.id, "u62");
    assert.equal(page2.records.length, 95);
    assert.equal(page2.records.some((record) => record.id === "t80-0"), true);
  });

  test("loadOlder 的锚点可以是界碑类记录（channel-mark 也在生效视图里按 id 定位）", async () => {
    const records: SessionRecord[] = [
      ...turnBlock(0, 8),
      {
        role: "channel-mark",
        id: "k1",
        peerId: "child-1",
        messageId: "msg-1",
        from: "child",
        kind: "question",
        timestamp: 5000,
      },
      ...turnBlock(1, 19).slice(1),
    ];
    await seedLog(ID, records);
    const page = await store.loadOlder(ID, "k1", 10);
    assert.equal(page.records[0]?.id, "u0");
    assert.equal(page.records.length, 10);
    assert.equal(page.records.at(-1)?.id, "t0-7");
    assert.equal(page.hasMore, false);
  });

  test("limit 的坏值与上限：0 / 负数 / 小数按 1 条再对齐，NaN 用默认 500，超上限夹到 2000", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    // 1 条 → 切点 1199（工具行）→ 前面没有 user、回溯到本轮轮首 u239
    for (const bad of [0, -3, 1.9]) {
      const detail = await store.loadWindow(ID, bad);
      assert.equal(detail?.transcript[0]?.id, "u239", `limit=${bad}`);
      assert.equal(detail?.transcript.length, 5, `limit=${bad}`);
      assert.equal(detail?.window.hasMore, true, `limit=${bad}`);
    }
    // NaN → 默认 500 条，切点 700 恰好是 u140 的轮首
    const nan = await store.loadWindow(ID, Number.NaN);
    assert.equal(nan?.transcript.length, 500);
    assert.equal(nan?.transcript[0]?.id, "u140");
    // 超上限 → 夹到 2000，整条会话进窗
    const huge = await store.loadWindow(ID, 5000);
    assert.equal(huge?.transcript.length, 1200);
    assert.equal(huge?.window.hasMore, false);
  });

  test("整条会话一条 user 也没有：起点不对齐，按切点切", async () => {
    const records: SessionRecord[] = [];
    for (let i = 0; i < 600; i += 1) {
      records.push({
        id: `t${i}`,
        role: "tool",
        toolCallId: `call-${i}`,
        toolName: "bash",
        input: {},
        content: [{ type: "text", text: "ok" }],
        timestamp: 2000 + i,
        status: "complete",
        isError: false,
      } as TranscriptItem);
    }
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 600);
    assert.equal(detail?.transcript.length, 500);
    assert.equal(detail?.transcript[0]?.id, "t100");
    assert.equal(detail?.window.hasMore, true);
  });

  test("几 MB 的多字节大行跨流式块边界：窗口内完整返回", async () => {
    const big = "果".repeat(600_000); // 1.8MB 的 utf8，跨多个 256KB 读块
    const records: SessionRecord[] = [
      ...turnBlock(0, 0),
      {
        id: "b1",
        role: "assistant",
        content: [{ type: "text", text: big }],
        model: { provider: "zai", id: "glm-5.3" },
        timestamp: 4000,
        status: "complete",
        stopReason: "stop",
      } as TranscriptItem,
      ...turnBlock(1, 0),
    ];
    await seedLog(ID, records);
    const detail = await store.loadWindow(ID);
    assert.equal(detail?.window.total, 5);
    const bigRecord = detail?.transcript.find((record) => record.id === "b1");
    const text =
      bigRecord !== undefined && bigRecord.role === "assistant"
        ? bigRecord.content.find((block) => block.type === "text")
        : undefined;
    assert.equal(text !== undefined && text.type === "text" ? text.text.length : 0, 600_000);
  });
});

// ── 两遍之间的原子替换：两遍必须读到同一份文件 ──

describe("SessionStore · 窗口分页两遍之间的原子替换", () => {
  // commitImportUpdate（再导入落盘）用 temp+rename 原子替换整个日志。第二遍另开 fd
  // 重 open 路径时，替换恰好插进两遍之间会读到新文件、配的却是第一遍在旧文件上建好
  // 的索引；替换文件与原文件逐行同字节长时甚至不触发兑底，直接漏出「新记录 +
  // 旧 total / hasMore」的混合世界。两遍共用同一个 fd 后，rename 换的是路径指向的
  // inode、换不动已打开的 fd：两遍必是同一份文件，返回打开那一刻的完整旧快照。

  /**
   * 在第一遍（scanEffectiveIndex）返回之后、第二遍回读之前把日志原子替换掉，
   * 复现「替换恰好插进两遍之间」。scanEffectiveIndex 是私有方法，按运行时形状包一层
   * （两版签名都是首参 path，修后多传一个 fd）。
   */
  const raceStoreWithReplacement = (replacement: string): SessionStore => {
    const racer = new SessionStore(join(dir, "sessions"));
    const holder = racer as unknown as {
      scanEffectiveIndex: (path: string, fd?: number) => Promise<unknown>;
    };
    const scan = holder.scanEffectiveIndex.bind(racer);
    let pending: string | null = replacement;
    holder.scanEffectiveIndex = async (path, fd) => {
      const index = await scan(path, fd);
      if (pending !== null) {
        await rename(pending, path);
        pending = null;
      }
      return index;
    };
    return racer;
  };

  test("替换成逐行同字节长、不同 id 的文件：返回打开那一刻的完整旧快照，不再新记录配旧索引", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    // 每行同字节长（行界与字节偏移与原文件全对得上）、id 换成另一套——这是修前唯一
    // 不触发兑底、直接把错配漏出去的形状
    const swapId = (id: string): string => (id[0] === "u" ? "p" : id[0] === "a" ? "q" : "r") + id.slice(1);
    const replacement = join(dir, "replacement.jsonl");
    await writeFile(
      replacement,
      `${records.map((record) => JSON.stringify({ ...record, id: swapId(record.id) })).join("\n")}\n`,
      "utf8",
    );
    const detail = await raceStoreWithReplacement(replacement).loadWindow(ID);
    // 窗口统计按第一遍（旧文件）算：1200 条、切点 700 对齐 u140、还有更多
    assert.equal(detail?.window.total, 1200);
    assert.equal(detail?.window.hasMore, true);
    assert.equal(detail?.transcript.length, 500);
    // 记录也必须整个来自旧文件——修前这里是 p140…（新文件的记录），total / hasMore
    // 却按旧文件算
    assert.equal(detail?.transcript[0]?.id, "u140");
    assert.equal(detail?.transcript.at(-1)?.id, "t239-2");
    const stranger = detail?.transcript.find(
      (record) => record.id.startsWith("p") || record.id.startsWith("q") || record.id.startsWith("r"),
    );
    assert.equal(stranger, undefined, "窗口里混进了替换文件的记录");
  });

  test("替换成更短的不同形状文件：同样只认打开时那份（旧快照）；下一次 load 才是新世界", async () => {
    const records = Array.from({ length: 240 }, (_, n) => turnBlock(n, 3)).flat();
    await seedLog(ID, records);
    const replacement = join(dir, "replacement.jsonl");
    await writeFile(
      replacement,
      `${turnBlock(0, 1).map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const racer = raceStoreWithReplacement(replacement);
    const detail = await racer.loadWindow(ID);
    assert.equal(detail?.window.total, 1200);
    assert.equal(detail?.transcript.length, 500);
    assert.equal(detail?.transcript[0]?.id, "u140");
    // 不再注替换，下一次 load 打开的就是替换后的文件
    const fresh = await racer.loadWindow(ID);
    assert.equal(fresh?.window.total, 3);
    assert.deepEqual(
      fresh?.transcript.map((record) => record.id),
      ["u0", "a0", "t0-0"],
    );
  });
});
