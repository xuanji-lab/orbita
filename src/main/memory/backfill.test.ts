/**
 * 补蒸编排的回归网：状态机（start / pause / resume / cancel / 重启恢复）、
 * 预估、退避与失败计数、连续失败熔断、条目落盘（backfilled + 冲突自动 replace）、
 * 已蒸轮记账。真文件系统用临时目录，蒸馏问答与模型装配全是注入的桩。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChoreModelPayload, MemoryBackfillTurnInput, MemoryBackfillTurnResult, ProviderSecrets } from "../../shared/agent-ipc.ts";
import { MEMORY_GLOBAL_SCOPE, type MemoryBackfillStatus, type MemoryDraft } from "../../shared/memory.ts";
import type { ChannelKey, ChannelMessage } from "../../shared/channel.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import { DistilledTurnLedger, DISTILLED_TURNS_FILE } from "./backfill-ledger.ts";
import {
  BACKFILL_CONSECUTIVE_FAIL_LIMIT,
  MemoryBackfillService,
  backoffDelayMs,
  parseBackfillRange,
  parsePersistedStatus,
  type BackfillChannelReader,
  type BackfillModelSource,
  type BackfillSessionReader,
  type MemoryBackfillDeps,
} from "./backfill.ts";
import { MemoryStore } from "./store.ts";

/* ---------- 夹具 ---------- */

const NOW = 1_700_000_000_000;
let clock = NOW;

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `task-${id}`,
  titleSource: "derived",
  cwd: `/tmp/${id}`,
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

const userItem = (text: string, timestamp: number): SessionRecord => ({
  id: `u-${timestamp}`,
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const assistantItem = (text: string, timestamp: number): SessionRecord => ({
  id: `a-${timestamp}`,
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp,
  status: "complete",
  stopReason: "stop",
});

/** 造 n 轮记录（全部正常结束、时间递增）。 */
const rounds = (n: number, startAt: number): SessionRecord[] => {
  const records: SessionRecord[] = [];
  for (let i = 0; i < n; i++) {
    records.push(userItem(`问 ${i + 1}`, startAt + i * 1000));
    records.push(assistantItem(`答 ${i + 1}`, startAt + i * 1000 + 500));
  }
  return records;
};

/** 会话存储桩：metas + 每条的记录。 */
class FakeSessions implements BackfillSessionReader {
  private readonly entries: { meta: SessionMeta; records: SessionRecord[] }[];

  constructor(entries: { meta: SessionMeta; records: SessionRecord[] }[]) {
    this.entries = entries;
  }

  async list(): Promise<SessionMeta[]> {
    return this.entries.map((entry) => entry.meta);
  }
  async load(id: string): Promise<{ meta: SessionMeta; transcript: SessionRecord[] } | null> {
    const found = this.entries.find((entry) => entry.meta.id === id);
    return found === undefined ? null : { meta: found.meta, transcript: found.records };
  }
}

const noChannels: BackfillChannelReader = { load: async (_key: ChannelKey): Promise<ChannelMessage[]> => [] };

const PROVIDER: ProviderSecrets = { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k", models: [{ id: "glm-5.3" }] };
const CHORE: { provider: ProviderSecrets; modelId: string } = {
  provider: { ...PROVIDER, id: "zai-flash" },
  modelId: "glm-5.3-flash",
};

/** 蒸馏问答桩：脚本化（每次调用的行为 / 结果由测试排好），调用全记录。 */
class ScriptedDistill {
  readonly calls: { turns: MemoryBackfillTurnInput[]; choreModel?: ChoreModelPayload }[] = [];
  private readonly script: ((turns: readonly MemoryBackfillTurnInput[]) => Promise<MemoryBackfillTurnResult[]>)[] = [];
  private readonly waiting: {
    turns: readonly MemoryBackfillTurnInput[];
    resolve: (results: MemoryBackfillTurnResult[]) => void;
  }[] = [];

  /** 排一个脚本步：下一次调用用它。没排的调用默认全部成功、蒸 0 条。 */
  next(handler: (turns: readonly MemoryBackfillTurnInput[]) => Promise<MemoryBackfillTurnResult[]>): void {
    this.script.push(handler);
  }

  /** 取一个还挂着的调用（配合 block）：拿到后手动 resolve。 */
  takeWaiting(): { turns: readonly MemoryBackfillTurnInput[]; resolve: (results: MemoryBackfillTurnResult[]) => void } | undefined {
    return this.waiting.shift();
  }

  async backfillDistill(
    turns: readonly MemoryBackfillTurnInput[],
    choreModel?: ChoreModelPayload,
  ): Promise<MemoryBackfillTurnResult[]> {
    this.calls.push({ turns: [...turns], choreModel });
    const handler = this.script.shift();
    if (handler !== undefined) return handler(turns);
    return new Promise((resolve) => {
      // 没排脚本：挂起等测试手动放行（拿不到放行就当超时场景也不影响——测试都会排）
      this.waiting.push({ turns, resolve });
    });
  }
}

interface Ctx {
  service: MemoryBackfillService;
  distill: ScriptedDistill;
  broadcasts: MemoryBackfillStatus[];
  ledger: DistilledTurnLedger;
  memory: MemoryStore;
  dir: string;
  enabled: boolean;
}

let dir = "";

async function makeCtx(
  entries: { meta: SessionMeta; records: SessionRecord[] }[],
  options: {
    chore?: { provider: ProviderSecrets; modelId: string } | undefined;
    enabled?: boolean;
  } = {},
): Promise<Ctx> {
  const memory = new MemoryStore(join(dir, "memory"));
  const ledger = new DistilledTurnLedger(join(dir, "memory", DISTILLED_TURNS_FILE));
  await ledger.load();
  const distill = new ScriptedDistill();
  const broadcasts: MemoryBackfillStatus[] = [];
  const enabled = options.enabled ?? true;
  const models: BackfillModelSource = {
    readChoreModel: async () => options.chore,
    resolveProvider: async (providerId) => {
      if (providerId === "zai") return PROVIDER;
      throw new Error(`unknown provider "${providerId}"`);
    },
  };
  const deps: MemoryBackfillDeps = {
    sessions: new FakeSessions(entries),
    channels: noChannels,
    memory,
    ledger,
    models,
    distill,
    isMemoryEnabled: async () => enabled,
    broadcast: (status) => broadcasts.push(status),
    now: () => clock,
    stateFile: join(dir, "backfill-state.json"),
    backoffMs: () => 0,
  };
  const ctx: Ctx = { service: new MemoryBackfillService(deps), distill, broadcasts, ledger, memory, dir, enabled };
  lastCtx = ctx;
  return ctx;
}

let lastCtx: Ctx | undefined;

/** 让微任务跑几轮（循环收尾的确定性等待）。 */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 等条件成立（微任务轮询——测试里的循环全在微任务上跑，没有真实 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 用真实时限 + 小步 setTimeout 轮询：服务循环里是真文件 IO（原子写），
  // setImmediate 只推微任务会饿着线程池——轮数再多也等不到落盘完成
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), `waitFor 超时：status=${JSON.stringify(lastCtx?.service.statusSnapshot())}`);
}


beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-backfill-"));
  clock = NOW;
});

afterEach(async () => {
  // 循环收尾的最后一次原子写可能与删除赛跑：给 rm 配重试，别让清理误报
  await settle(10);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const okResult = (sessionId: string, turn: number, drafts: MemoryDraft[]): MemoryBackfillTurnResult => ({
  sessionId,
  turn,
  ok: true,
  entries: drafts,
});

/* ---------- 预估 ---------- */

describe("estimate", () => {
  test("子会话排除、归档与导入的会话包括、已蒸跳过、token 粗估、choreModel 带出", async () => {
    const ctx = await makeCtx(
      [
        { meta: meta("normal"), records: rounds(3, NOW - 1000) },
        { meta: meta("archived", { archived: true }), records: rounds(2, NOW - 2000) },
        { meta: meta("child", { parentId: "parent" }), records: rounds(4, NOW - 3000) },
        { meta: meta("old", { workspaceId: "ws-a" }), records: rounds(1, NOW - 120 * 24 * 60 * 60 * 1000) },
      ],
      { chore: CHORE },
    );
    await ctx.ledger.record("normal", 1); // 第一轮已蒸
    const estimate = await ctx.service.estimate("all");
    assert.equal(estimate.range, "all");
    // normal（3 轮里 1 轮已蒸 → 2 待）+ archived（2 待）+ old（1 待，120 天前也在 all 里）
    assert.equal(estimate.sessions, 3);
    assert.equal(estimate.turns, 5);
    assert.equal(estimate.skippedTurns, 1);
    assert.deepEqual(estimate.choreModel, { providerId: "zai-flash", modelId: "glm-5.3-flash" });
  });

  test("1m 范围把一个月前的轮截掉；没配家务活模型 choreModel 为 null", async () => {
    const ctx = await makeCtx([
      { meta: meta("s"), records: [...rounds(1, NOW - 40 * 24 * 60 * 60 * 1000), ...rounds(1, NOW - 1000)] },
    ]);
    const estimate = await ctx.service.estimate("1m");
    assert.equal(estimate.turns, 1);
    assert.equal(estimate.choreModel, null);
  });
});

/* ---------- start 与执行循环 ---------- */

describe("start / runLoop", () => {
  test("开关关着拒绝（started=false，error 写原因）；跑着 / 暂停中不另起", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { enabled: false });
    const refused = await ctx.service.start("all");
    assert.equal(refused.started, false);
    assert.match(refused.status.error ?? "", /会话记忆/);

    const on = await makeCtx([{ meta: meta("s"), records: rounds(2, NOW) }]);
    // 挂起第一批，让任务停在 running
    const started = await on.service.start("all");
    assert.equal(started.started, true);
    await waitFor(() => on.distill.calls.length === 1);
    const again = await on.service.start("all");
    assert.equal(again.started, false);
    on.distill.takeWaiting()?.resolve([okResult("s", 1, []), okResult("s", 2, [])]);
    await waitFor(() => on.service.statusSnapshot().state === "done");
  });

  test("全链路：条目带 backfilled / turn / 出处落对作用域，冲突自动 replace，账本记满，进度推送", async () => {
    const ctx = await makeCtx(
      [
        { meta: meta("ws", { workspaceId: "ws-a" }), records: rounds(2, NOW - 10_000) },
        { meta: meta("home"), records: rounds(1, NOW - 5000) },
      ],
      { chore: CHORE },
    );
    // 预置一条会被推翻的旧记忆（ws-a 作用域）
    const [old] = await ctx.memory.append(ctx.memory.tokenOf("ws-a"), "ancient", 1, [
      { text: "用户用 npm 管包", keywords: ["npm"], timestamp: NOW - 999_999 },
    ]);
    assert.ok(old !== undefined);
    ctx.distill.next(async (turns) => [
      okResult("ws", 1, [
        { text: "用户改用 bun 管包，不再用 npm", keywords: ["bun"], timestamp: NOW - 10_000, supersedes: old.id },
        { text: "项目用 vitest 跑测试", keywords: ["vitest"], timestamp: NOW - 10_000 },
      ]),
      okResult("ws", 2, []),
    ]);
    ctx.distill.next(async (turns) => [okResult("home", 1, [{ text: "Home 的一条", keywords: [], timestamp: NOW - 5000 }])]);

    const started = await ctx.service.start("all");
    assert.equal(started.started, true);
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    const status = ctx.service.statusSnapshot();
    assert.equal(status.totalTurns, 3);
    assert.equal(status.doneTurns, 3);
    assert.equal(status.totalSessions, 2);
    assert.equal(status.doneSessions, 2);
    assert.equal(status.newEntries, 3);
    assert.equal(status.replaced, 1);
    assert.equal(status.failedTurns, 0);

    // 条目落盘：backfilled + turn + 出处会话 + 作用域归 workspaceId
    const wsEntries = await ctx.memory.list(ctx.memory.tokenOf("ws-a"));
    assert.equal(wsEntries.length, 3); // 旧 1 + 新 2
    const superseding = wsEntries.find((entry) => entry.supersedes === old.id);
    assert.ok(superseding !== undefined);
    assert.equal(superseding.backfilled, true);
    assert.equal(superseding.sessionId, "ws");
    assert.equal(superseding.turn, 1);
    assert.equal(superseding.conflictResolution, "replace");
    assert.equal(old.status, undefined); // 解析后的旧条目要看盘上的
    const reloadedOld = (await ctx.memory.list(ctx.memory.tokenOf("ws-a"))).find((entry) => entry.id === old.id);
    assert.equal(reloadedOld?.status, "superseded");
    assert.equal(reloadedOld?.supersededBy, superseding?.id);
    // 逐字去重照常生效：蒸出与已有逐字相同的条目不重复落
    const homeEntries = await ctx.memory.list(ctx.memory.tokenOf("/tmp/home"));
    assert.equal(homeEntries.length, 1);
    assert.equal(homeEntries[0]?.backfilled, true);

    // 账本：3 轮全记（含蒸出 0 条的那轮）
    assert.equal(ctx.ledger.has("ws", 1), true);
    assert.equal(ctx.ledger.has("ws", 2), true);
    assert.equal(ctx.ledger.has("home", 1), true);

    // choreModel 随批带给 agent 进程
    assert.equal(ctx.distill.calls[0]?.choreModel?.modelId, "glm-5.3-flash");

    // 再跑一次：全部跳过，直接 done
    const second = await ctx.service.start("all");
    assert.equal(second.started, true);
    assert.equal(second.status.state, "done");
    assert.equal(second.status.totalTurns, 0);
  });

  test("没配 choreModel 时各轮带自己的 fallback（会话模型）；装配失败就没有", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { chore: undefined });
    ctx.distill.next(async () => [okResult("s", 1, [])]);
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    const input = ctx.distill.calls[0]?.turns[0];
    assert.equal(input?.fallback?.modelId, "glm-5.3");
    assert.equal(input?.fallback?.provider.id, "zai");
  });

  test("supersedes 指向不存在的 id（模型幻觉）：条目照落、不落标、不计数", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { chore: CHORE });
    ctx.distill.next(async () => [
      okResult("s", 1, [{ text: "一条新记忆", keywords: [], timestamp: NOW, supersedes: "mem_nonexistent" }]),
    ]);
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    assert.equal(ctx.service.statusSnapshot().replaced, 0);
    const entries = await ctx.memory.list(ctx.memory.tokenOf("/tmp/s"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.supersedes, undefined);
    assert.equal(entries[0]?.conflictResolution, undefined);
  });
});

/* ---------- 退避与失败计数 ---------- */

describe("退避与失败计数", () => {
  test("backoffDelayMs 指数增长（2s → 8s）", () => {
    assert.equal(backoffDelayMs(1), 2_000);
    assert.equal(backoffDelayMs(2), 8_000);
    assert.equal(backoffDelayMs(3), 32_000);
  });

  test("失败重试两次后成功：不计 failedTurns，账本只记成功那次", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { chore: CHORE });
    let attempt = 0;
    for (let i = 0; i < 2; i++) {
      ctx.distill.next(async () => {
        attempt += 1;
        return [{ sessionId: "s", turn: 1, ok: false, error: "429" }];
      });
    }
    ctx.distill.next(async () => [okResult("s", 1, [])]);
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    assert.equal(attempt, 2);
    assert.equal(ctx.distill.calls.length, 3);
    assert.equal(ctx.service.statusSnapshot().failedTurns, 0);
    assert.equal(ctx.ledger.has("s", 1), true);
  });

  test("重试耗尽：计 failedTurns、不记账（下次补蒸再试）、任务仍走完", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(2, NOW) }], { chore: CHORE });
    // 第 1 轮失败、第 2 轮照常成功（脚本步要覆盖批内全部轮）
    const failFirst = async (turns: readonly MemoryBackfillTurnInput[]): Promise<MemoryBackfillTurnResult[]> =>
      turns.map((turn) =>
        turn.turn === 1
          ? { sessionId: "s", turn: 1, ok: false as const, error: "boom" }
          : okResult(turn.sessionId, turn.turn, []),
      );
    for (let i = 0; i < 3; i++) ctx.distill.next(failFirst);
    ctx.distill.next(async (turns) => turns.map((turn) => okResult(turn.sessionId, turn.turn, [])));
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    const status = ctx.service.statusSnapshot();
    assert.equal(status.failedTurns, 1);
    assert.equal(status.doneTurns, 2);
    assert.equal(ctx.ledger.has("s", 1), false);
    assert.equal(ctx.ledger.has("s", 2), true);
  });

  test("连续 8 轮蒸不成：任务置 failed 并带一句原因", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(BACKFILL_CONSECUTIVE_FAIL_LIMIT, NOW) }], {
      chore: CHORE,
    });
    // 整批失败（脚本步对批内每轮都回失败），服务自己重排（backoff 0）
    const alwaysFail = async (turns: readonly MemoryBackfillTurnInput[]): Promise<MemoryBackfillTurnResult[]> =>
      turns.map((turn) => ({ sessionId: turn.sessionId, turn: turn.turn, ok: false, error: "provider is down" }));
    for (let i = 0; i < BACKFILL_CONSECUTIVE_FAIL_LIMIT * 3; i++) ctx.distill.next(alwaysFail);
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "failed");
    const status = ctx.service.statusSnapshot();
    assert.match(status.error ?? "", /连续 8 轮蒸馏失败/);
    assert.equal(status.failedTurns, BACKFILL_CONSECUTIVE_FAIL_LIMIT);
  });

  test("agent 进程整批抛出（退出 / 超时）：按失败尝试计重试", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { chore: CHORE });
    ctx.distill.next(async () => {
      throw new Error("agent runtime exited with code 1");
    });
    ctx.distill.next(async () => [okResult("s", 1, [])]);
    await ctx.service.start("all");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    assert.equal(ctx.service.statusSnapshot().failedTurns, 0);
  });
});

/* ---------- 暂停 / 继续 / 取消 ---------- */

describe("pause / resume / cancel", () => {
  test("暂停：状态立即翻 paused，在飞那批蒸完落盘，剩余轮留着；继续接上并完成", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(4, NOW) }], { chore: CHORE });
    // 第一批 3 轮挂起，第二批 1 轮还没发
    await ctx.service.start("all");
    await waitFor(() => ctx.distill.calls.length === 1);
    const paused = ctx.service.pause();
    assert.equal(paused.state, "paused");
    // 在飞的照常落盘
    ctx.distill.takeWaiting()?.resolve([
      okResult("s", 1, [{ text: "第一条", keywords: [], timestamp: NOW }]),
      okResult("s", 2, []),
      okResult("s", 3, []),
    ]);
    await waitFor(() => ctx.service.statusSnapshot().doneTurns === 3);
    // 等循环收尾（不会再发新批）
    await settle(10);
    assert.equal(ctx.distill.calls.length, 1);

    // 继续：重收计划，已蒸的 3 轮跳过，只蒸第 4 轮
    ctx.distill.next(async () => [okResult("s", 4, [])]);
    const resumed = await ctx.service.resume();
    assert.equal(resumed.state, "running");
    await waitFor(() => ctx.service.statusSnapshot().state === "done");
    const status = ctx.service.statusSnapshot();
    assert.equal(status.doneTurns, 4);
    assert.equal(status.totalTurns, 4); // resume 抬总量盖住新收的轮
    assert.equal(status.newEntries, 1);
  });

  test("取消：清队翻 cancelled；已落条目保留；done/cancelled 后能重新 start", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(3, NOW) }], { chore: CHORE });
    await ctx.service.start("all");
    await waitFor(() => ctx.distill.calls.length === 1);
    const cancelled = ctx.service.cancel();
    assert.equal(cancelled.state, "cancelled");
    ctx.distill.takeWaiting()?.resolve([okResult("s", 1, [{ text: "已付的钱", keywords: [], timestamp: NOW }]), okResult("s", 2, []), okResult("s", 3, [])]);
    await waitFor(() => ctx.ledger.has("s", 3));
    assert.equal((await ctx.memory.list(ctx.memory.tokenOf("/tmp/s"))).length, 1);

    // cancelled 之后重新 start：全新任务
    ctx.distill.next(async () => []);
    const restarted = await ctx.service.start("1m");
    assert.equal(restarted.started, true);
    assert.equal(restarted.status.totalTurns, 0);
    assert.equal(restarted.status.state, "done");
  });
});

/* ---------- 重启恢复与状态持久化 ---------- */

describe("状态持久化", () => {
  test("running 重启后恢复成 paused；坏状态文件当没有任务", async () => {
    const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }]);
    await writeFile(
      join(dir, "backfill-state.json"),
      JSON.stringify({
        state: "running",
        range: "3m",
        totalSessions: 2,
        doneSessions: 1,
        totalTurns: 10,
        doneTurns: 4,
        newEntries: 6,
        replaced: 1,
        failedTurns: 0,
        startedAt: NOW - 5000,
        updatedAt: NOW - 1000,
      }),
      "utf8",
    );
    await ctx.service.loadPersisted();
    assert.equal(ctx.service.statusSnapshot().state, "paused");
    assert.equal(ctx.service.statusSnapshot().range, "3m");
    assert.equal(ctx.service.statusSnapshot().doneTurns, 4);
    // 落盘的是恢复后的 paused
    const persisted = JSON.parse(await readFile(join(dir, "backfill-state.json"), "utf8")) as MemoryBackfillStatus;
    assert.equal(persisted.state, "paused");

    const fresh = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }]);
    await writeFile(join(dir, "backfill-state.json"), "{broken", "utf8");
    await fresh.service.loadPersisted();
    assert.equal(fresh.service.statusSnapshot().state, "idle");
  });

  test("parsePersistedStatus：形状不对返回 null；可选字段缺省成 null", () => {
    assert.equal(parsePersistedStatus(null), null);
    assert.equal(parsePersistedStatus({ state: "weird" }), null);
    assert.equal(parsePersistedStatus({ state: "done", range: "2m" }), null); // range 非法
    const parsed = parsePersistedStatus({
      state: "done",
      range: null,
      totalSessions: 0,
      doneSessions: 0,
      totalTurns: 0,
      doneTurns: 0,
      newEntries: 0,
      replaced: 0,
      failedTurns: 0,
    });
    assert.ok(parsed !== null);
    assert.equal(parsed.startedAt, null);
    assert.equal(parsed.updatedAt, null);
  });
});

/* ---------- 入参与全局作用域 ---------- */

describe("parseBackfillRange", () => {
  test("认 { range } 对象与裸字符串；非法值抛", () => {
    assert.equal(parseBackfillRange({ range: "1m" }), "1m");
    assert.equal(parseBackfillRange("all"), "all");
    assert.throws(() => parseBackfillRange({ range: "2m" }));
    assert.throws(() => parseBackfillRange(undefined));
  });
});

test("冲突候选跨作用域（旧条目在全局）也能自动 replace", async () => {
  const ctx = await makeCtx([{ meta: meta("s"), records: rounds(1, NOW) }], { chore: CHORE });
  const globalToken = ctx.memory.tokenOf(MEMORY_GLOBAL_SCOPE);
  const [old] = await ctx.memory.append(globalToken, "ancient", 1, [
    { text: "全局里的旧决定", keywords: [], timestamp: NOW - 999_999 },
  ]);
  assert.ok(old !== undefined);
  ctx.distill.next(async () => [
    okResult("s", 1, [{ text: "推翻全局旧决定的新决定", keywords: [], timestamp: NOW, supersedes: old.id }]),
  ]);
  await ctx.service.start("all");
  await waitFor(() => ctx.service.statusSnapshot().state === "done");
  assert.equal(ctx.service.statusSnapshot().replaced, 1);
  const globalEntries = await ctx.memory.list(globalToken);
  assert.equal(globalEntries.find((entry) => entry.id === old.id)?.status, "superseded");
});
