import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@shared/agent-ipc";
import type { SessionMeta } from "@shared/session";
import { sortSessions } from "../../../../shared/session.ts";
import {
  applySessionMeta,
  SessionListRefreshQueue,
  sessionRefreshNeed,
} from "./session-list-refresh.ts";

/** 构造一条最小合法 SessionMeta：只有这里用到的字段有意义 */
const meta = (over: { id: string } & Partial<SessionMeta>): SessionMeta => ({
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
  updatedAt: 0,
  ...over,
});

const parent = meta({ id: "parent" });
const listed = [parent];

describe("sessionRefreshNeed —— 该不该刷、刷多少", () => {
  test("列表里的会话一轮跑完（phase idle）：只取这一条 meta，不整表重拉", () => {
    assert.deepEqual(
      sessionRefreshNeed({ type: "phase", sessionId: "parent", phase: "idle" }, listed),
      { kind: "meta", id: "parent" },
    );
  });

  test("列表里的会话开轮 / 压缩：不刷——轮中途 meta 没变，跑完再刷", () => {
    assert.equal(sessionRefreshNeed({ type: "phase", sessionId: "parent", phase: "turn" }, listed), "none");
    assert.equal(
      sessionRefreshNeed({ type: "phase", sessionId: "parent", phase: "compaction" }, listed),
      "none",
    );
  });

  // 这一条是这刀的由来：母会话还在跑时派出的子会话，首轮开跑的 phase 就是它
  // 第一次出现在 renderer 面前。不刷的话要等母会话这一轮跑完，Sub-sessions 入口才出现
  test("列表里没有的会话开轮（delegate 派出的子会话）：整表重拉", () => {
    assert.deepEqual(
      sessionRefreshNeed({ type: "phase", sessionId: "child", phase: "turn" }, listed),
      { kind: "full" },
    );
  });

  test("刷回来之后，同一条子会话后续的开轮只认列表里已有：不刷", () => {
    const refreshed = [parent, meta({ id: "child", parentId: "parent" })];
    assert.equal(
      sessionRefreshNeed({ type: "phase", sessionId: "child", phase: "turn" }, refreshed),
      "none",
    );
    // 跑完仍然只取它自己那一条
    assert.deepEqual(
      sessionRefreshNeed({ type: "phase", sessionId: "child", phase: "idle" }, refreshed),
      { kind: "meta", id: "child" },
    );
  });

  test("列表还没读回来（空）时来了 phase：整表重拉——宁多拉一次，不漏", () => {
    assert.deepEqual(
      sessionRefreshNeed({ type: "phase", sessionId: "parent", phase: "turn" }, []),
      { kind: "full" },
    );
  });

  test("模型标题到了 / 会话内换了模型：列表里有就只取这一条（主进程已落 meta，不等 idle）", () => {
    assert.deepEqual(
      sessionRefreshNeed({ type: "title", sessionId: "parent", title: "新标题" }, listed),
      { kind: "meta", id: "parent" },
    );
    assert.deepEqual(
      sessionRefreshNeed(
        { type: "model", sessionId: "parent", providerId: "zai", modelId: "glm-5.3" },
        listed,
      ),
      { kind: "meta", id: "parent" },
    );
  });

  test("标题 / 换模型来自列表里没有的会话：整表重拉（可能是别处新建或导入的）", () => {
    assert.deepEqual(
      sessionRefreshNeed({ type: "title", sessionId: "unknown", title: "新标题" }, listed),
      { kind: "full" },
    );
    assert.deepEqual(
      sessionRefreshNeed(
        { type: "model", sessionId: "unknown", providerId: "zai", modelId: "glm-5.3" },
        listed,
      ),
      { kind: "full" },
    );
  });

  test("其余事件：不刷——列表里没有的会话只认 phase（每轮至多几次），不认流式帧那类高频事件", () => {
    const events: AgentEvent[] = [
      { type: "retry", sessionId: "child", status: null },
      { type: "created", sessionId: "child", piSessionFile: null },
      { type: "failed", sessionId: null, message: "runtime exited" },
    ];
    for (const event of events) assert.equal(sessionRefreshNeed(event, listed), "none");
  });
});

describe("applySessionMeta —— 单条替换必须与整表重拉逐条一致", () => {
  const pinned = meta({ id: "pinned", pinned: true, updatedAt: 1 });
  const older = meta({ id: "older", updatedAt: 10 });
  const newer = meta({ id: "newer", updatedAt: 20 });
  const current = [pinned, newer, older];

  test("替换后按 sortSessions 重排（置顶在前，其余 updatedAt 倒序），与整表重拉逐条一致", () => {
    // older 跑完一轮，updatedAt 越过 newer——增量替换后它要跳到 newer 前面
    const changed = { ...older, title: "跑完了", updatedAt: 30 };
    const incremental = applySessionMeta(current, "older", changed);
    const full = sortSessions([pinned, newer, changed]);
    assert.deepEqual(incremental, full);
    assert.deepEqual(incremental.map((entry) => entry.id), ["pinned", "older", "newer"]);
  });

  test("替换 title / updatedAt / 星标 / 完成态，列表长度不变", () => {
    const changed = { ...newer, title: "新标题", starred: true, updatedAt: 40 };
    const next = applySessionMeta(current, "newer", changed);
    assert.equal(next.length, current.length);
    assert.deepEqual(next[1], changed);
  });

  test("meta 为 null（会话被删 / meta 坏了）：从列表移除，其余照旧排", () => {
    assert.deepEqual(
      applySessionMeta(current, "newer", null).map((entry) => entry.id),
      ["pinned", "older"],
    );
    // 不在列表里的 id 取回 null：幂等，不炸
    assert.deepEqual(applySessionMeta(current, "gone", null), current);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询到条件成立（定时器 / Promise 链是异步的），超时报出等的是什么 */
async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 500) throw new Error(`等不到：${what}`);
    await sleep(2);
  }
}

/**
 * 可控端口：默认整表读回 `initial`、单条从 `metas` 里取；需要卡住某次读盘时
 * 用 `holdAll` / `holdMeta` 换成手动 resolve 的 Promise。
 */
function makeQueue(options: {
  initial?: SessionMeta[];
  metas?: Map<string, SessionMeta | null>;
  delayMs?: number;
  loadAll?: () => Promise<SessionMeta[]>;
  loadMeta?: (id: string) => Promise<SessionMeta | null>;
}) {
  const calls = { all: 0, meta: [] as string[] };
  const applied: Array<
    { kind: "all"; list: SessionMeta[] } | { kind: "meta"; id: string; meta: SessionMeta | null }
  > = [];
  const errors: unknown[] = [];
  const queue = new SessionListRefreshQueue({
    delayMs: options.delayMs ?? 1,
    loadAll:
      options.loadAll ??
      (() => {
        calls.all += 1;
        return Promise.resolve(options.initial ?? []);
      }),
    loadMeta:
      options.loadMeta ??
      ((id) => {
        calls.meta.push(id);
        return Promise.resolve(options.metas?.get(id) ?? null);
      }),
    onAll: (list) => applied.push({ kind: "all", list }),
    onMeta: (id, got) => applied.push({ kind: "meta", id, meta: got }),
    onError: (cause) => errors.push(cause),
  });
  return { queue, calls, applied, errors };
}

describe("SessionListRefreshQueue", () => {
  test("已有会话 idle 只出 meta、不整表重拉", async () => {
    const changed = { ...parent, title: "跑完了", updatedAt: 99 };
    const h = makeQueue({ initial: [parent], metas: new Map([["parent", changed]]) });
    h.queue.requestMeta("parent");
    await until(() => h.applied.length === 1, "meta 回填");
    assert.equal(h.calls.all, 0);
    assert.deepEqual(h.calls.meta, ["parent"]);
    assert.deepEqual(h.applied, [{ kind: "meta", id: "parent", meta: changed }]);
    h.queue.dispose();
  });

  test("列表里没有的会话 phase：整表重拉，子会话随列表出现（delegate 回归）", async () => {
    const child = meta({ id: "child", parentId: "parent", updatedAt: 5 });
    const h = makeQueue({ initial: [child, parent] });
    // 事件层的判定：列表里没有 child → full
    const need = sessionRefreshNeed({ type: "phase", sessionId: "child", phase: "turn" }, [parent]);
    assert.deepEqual(need, { kind: "full" });
    if (need.kind === "full") h.queue.requestFull();
    await until(() => h.applied.length === 1, "整表回填");
    assert.equal(h.calls.all, 1);
    assert.equal(h.calls.meta.length, 0);
    const applied = h.applied[0];
    assert.ok(applied?.kind === "all");
    assert.deepEqual(applied.list.map((entry) => entry.id), ["child", "parent"]);
    h.queue.dispose();
  });

  test("后台会话跑完（idle）：只取那条 meta，标题与时间跟着更新", async () => {
    const before = [meta({ id: "bg", updatedAt: 1 })];
    const after = { ...before[0]!, title: "后台跑完", updatedAt: 50 };
    const h = makeQueue({ initial: before, metas: new Map([["bg", after]]) });
    h.queue.requestMeta("bg");
    await until(() => h.applied.length === 1, "meta 回填");
    assert.deepEqual(h.applied[0], { kind: "meta", id: "bg", meta: after });
    assert.equal(h.calls.all, 0);
    h.queue.dispose();
  });

  test("标题事件只取这一条：列表与正开着的顶栏用同一份 meta", async () => {
    const retitled = { ...parent, title: "模型起的标题", titleSource: "auto" as const };
    const h = makeQueue({ initial: [parent], metas: new Map([["parent", retitled]]) });
    h.queue.requestMeta("parent");
    await until(() => h.applied.length === 1, "meta 回填");
    assert.deepEqual((h.applied[0] as { meta: SessionMeta }).meta, retitled);
    h.queue.dispose();
  });

  test("突发合并：窗口内多次整表请求只读一次", async () => {
    const h = makeQueue({ delayMs: 25, initial: [parent] });
    h.queue.requestFull();
    h.queue.requestFull();
    h.queue.requestFull();
    await until(() => h.applied.length === 1, "整表回填");
    await sleep(20);
    assert.equal(h.calls.all, 1);
    assert.equal(h.applied.length, 1);
    h.queue.dispose();
  });

  test("在途期间来的请求：等这次结束后补拉一次，不再等窗口", async () => {
    const resolvers: Array<(list: SessionMeta[]) => void> = [];
    const h = makeQueue({
      delayMs: 25,
      loadAll: () => {
        h.calls.all += 1;
        return new Promise<SessionMeta[]>((resolve) => resolvers.push(resolve));
      },
    });
    h.queue.requestFull();
    await until(() => h.calls.all === 1, "第一次整表开跑");
    // 在途期间连来两次：合并成一次补拉
    h.queue.requestFull();
    h.queue.requestFull();
    resolvers[0]?.([parent]);
    await until(() => h.calls.all === 2, "补拉");
    assert.equal(h.applied.length, 1);
    resolvers[1]?.([parent]);
    await until(() => h.applied.length === 2, "第二次回填");
    await sleep(10);
    assert.equal(h.calls.all, 2);
    h.queue.dispose();
  });

  test("meta 按 id 去重：同一条在途 / 排队时不重复拉", async () => {
    const resolvers = new Map<string, (value: SessionMeta | null) => void>();
    const h = makeQueue({
      delayMs: 25,
      loadMeta: (id) => {
        h.calls.meta.push(id);
        return new Promise<SessionMeta | null>((resolve) => resolvers.set(id, resolve));
      },
    });
    h.queue.requestMeta("child");
    h.queue.requestMeta("child");
    await until(() => h.calls.meta.length === 1, "meta 开跑");
    h.queue.requestMeta("child"); // 在途期间再来：不重复
    resolvers.get("child")?.(meta({ id: "child" }));
    await until(() => h.applied.length === 1, "meta 回填");
    await sleep(10);
    assert.deepEqual(h.calls.meta, ["child"]);
    h.queue.dispose();
  });

  test("整表请求吞掉同窗口的 meta 请求（全量读一定覆盖这一条）", async () => {
    const h = makeQueue({ delayMs: 25, initial: [parent] });
    h.queue.requestMeta("parent");
    h.queue.requestFull();
    await until(() => h.applied.length === 1, "整表回填");
    await sleep(10);
    assert.equal(h.calls.all, 1);
    assert.deepEqual(h.calls.meta, []);
    h.queue.dispose();
  });

  test("读失败：报错但不调用 onAll / onMeta，列表交给调用方保留", async () => {
    const cause = new Error("EACCES");
    const h = makeQueue({
      loadAll: () => {
        h.calls.all += 1;
        return Promise.reject(cause);
      },
    });
    h.queue.requestFull();
    await until(() => h.errors.length === 1, "错误回调");
    assert.equal(h.applied.length, 0);
    assert.equal(h.errors[0], cause);
    h.queue.dispose();
  });

  test("dispose 后窗口里的请求不再落地", async () => {
    const h = makeQueue({ delayMs: 25, initial: [parent] });
    h.queue.requestFull();
    h.queue.dispose();
    await sleep(60);
    assert.equal(h.calls.all, 0);
    assert.equal(h.applied.length, 0);
  });

  // React StrictMode 在开发环境把 effect 跑成 setup → cleanup → setup：同一个队列实例
  // 会先被 dispose 一次。没有 revive 时开发模式下增量刷新永久失效（生产不双挂载，
  // 所以打包版性能测量验不出来；2026-11-10 隔离 dev 实例 E2E 抓到）。
  test("StrictMode 双挂载：dispose 后 revive 仍能继续刷新", async () => {
    const changed = { ...parent, title: "双挂载后", updatedAt: 120 };
    const h = makeQueue({ initial: [parent], metas: new Map([["parent", changed]]) });
    h.queue.dispose();
    h.queue.revive();
    h.queue.requestMeta("parent");
    await until(() => h.applied.length === 1, "revive 后的 meta 回填");
    assert.deepEqual(h.calls.meta, ["parent"]);
    assert.deepEqual(h.applied[0], { kind: "meta", id: "parent", meta: changed });
    h.queue.dispose();
  });
});
