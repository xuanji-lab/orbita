/**
 * 日用量账本的测试（usage/ledger.ts）。
 *
 * 钉五件事：累计与切天（注入时区，不赌机器设置）、按 message id 去重
 * （含盘上重建后仍去重）、回填（含导入会话排除 / 只跑一次 / 回退轮照计）、
 * 坏文件安全回落、写入链并发下文件始终是完整 JSON（原子写 + 串行化）。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../session/store.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { UsageLedger } from "./ledger.ts";

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

const assistantWithUsage = (
  id: string,
  timestamp: number,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
) => ({
  id,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "ok" }],
  model: { provider: "zai", id: "glm-5.3" },
  timestamp,
  status: "complete" as const,
  stopReason: "stop" as const,
  usage: {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

/** 今天中午（UTC），测试里的「现在」——账本切天用的时区与它一致才稳定 */
const NOW = (() => {
  const today = new Date();
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0);
})();
const DAY = 86_400_000;

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-usage-"));
  file = join(dir, "usage-daily.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 固定时区的账本：全部用例用 UTC 切天，与 NOW 的取法配套 */
const ledgerUtc = (): UsageLedger => new UsageLedger(file, { timeZone: "UTC" });

const todayKeyUtc = (offsetDays = 0): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(NOW - offsetDays * DAY));

describe("UsageLedger —— 累计与切天", () => {
  test("按记录时间戳的本地日期累计；四项相加", async () => {
    const ledger = ledgerUtc();
    await ledger.recordUsage({
      id: "m1",
      timestamp: NOW - DAY,
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
    });
    await ledger.recordUsage({ id: "m2", timestamp: NOW, usage: { input: 10, output: 1 } });
    const week = ledger.week();
    assert.equal(week.length, 7);
    assert.deepEqual(week[6], { date: todayKeyUtc(), tokens: 11 });
    assert.deepEqual(week[5], { date: todayKeyUtc(1), tokens: 155 });
    // 没用过的日子是 0，不是缺席
    assert.deepEqual(week[0], { date: todayKeyUtc(6), tokens: 0 });
  });

  test("跨午夜：同一时刻在不同时区切到不同的天（账本用时区切，不赌机器）", async () => {
    // 锚到昨天 16:00 UTC（= 上海今天 00:00）：同一时刻 UTC 账本记「昨天」、上海账本记「今天」，
    // 两侧都落在各自 week() 的 7 天窗口（只到今天）内。不能锚今天——上海侧会落到「明天」，
    // 掉出窗口，测试就只在 UTC 16–24 点（上海 0–8 点）跑得过，其余时段必挂。
    const ts = new Date(NOW - DAY).setUTCHours(16, 0, 0, 0);
    const utc = new UsageLedger(join(dir, "utc.json"), { timeZone: "UTC" });
    const shanghai = new UsageLedger(join(dir, "sh.json"), { timeZone: "Asia/Shanghai" });
    await utc.recordUsage({ id: "m1", timestamp: ts, usage: { input: 5 } });
    await shanghai.recordUsage({ id: "m1", timestamp: ts, usage: { input: 5 } });
    const utcKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(ts));
    const shKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(ts));
    assert.notEqual(utcKey, shKey);
    assert.equal(utc.week().find((d) => d.tokens === 5)?.date, utcKey);
    assert.equal(shanghai.week().find((d) => d.tokens === 5)?.date, shKey);
  });

  test("四项全 0 的记录不落账、不写盘", async () => {
    const ledger = ledgerUtc();
    await ledger.recordUsage({ id: "m0", timestamp: NOW, usage: { input: 0, output: 0 } });
    assert.equal(ledger.week()[6]?.tokens, 0);
    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
  });
});

describe("UsageLedger —— 去重", () => {
  test("同一 message id 只计一次", async () => {
    const ledger = ledgerUtc();
    await ledger.recordUsage({ id: "m1", timestamp: NOW, usage: { input: 50 } });
    await ledger.recordUsage({ id: "m1", timestamp: NOW, usage: { input: 50 } });
    assert.equal(ledger.week()[6]?.tokens, 50);
  });

  test("去重表落盘：重开账本（重读文件）后同 id 仍不计", async () => {
    await ledgerUtc().recordUsage({ id: "m1", timestamp: NOW, usage: { input: 50 } });
    const reopened = ledgerUtc();
    await reopened.load();
    await reopened.recordUsage({ id: "m1", timestamp: NOW, usage: { input: 50 } });
    assert.equal(reopened.week()[6]?.tokens, 50);
  });

  test("并发落账串行化，文件始终是完整 JSON 且总额不丢不重", async () => {
    const ledger = ledgerUtc();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ledger.recordUsage({ id: `m${i}`, timestamp: NOW, usage: { input: 10 } }),
      ),
    );
    const raw = JSON.parse(await readFile(file, "utf8")) as { days: Record<string, number> };
    assert.equal(raw.days[todayKeyUtc()], 400);
    assert.equal(ledger.week()[6]?.tokens, 400);
  });
});

describe("UsageLedger —— 回填", () => {
  let store: SessionStore;

  const freshStore = (): SessionStore => {
    const s = new SessionStore(join(dir, "sessions"));
    return s;
  };

  test("扫非导入会话的原始日志；导入会话（importedFrom）不进账", async () => {
    store = freshStore();
    await store.ensureSession(meta());
    await store.record(ID, assistantWithUsage("m1", NOW - DAY, { input: 100, output: 10 }));
    // 导入会话：token 花在别的应用
    await store.ensureSession(
      meta({ id: OTHER, importedFrom: "/proma/sdk-config/sessions/x.jsonl" }),
    );
    await store.record(
      OTHER,
      assistantWithUsage("imported-1", NOW - DAY, { input: 999_999, output: 1 }),
    );

    const ledger = ledgerUtc();
    await ledger.backfill(store);
    assert.equal(ledger.week()[5]?.tokens, 110);
    assert.equal(ledger.week()[6]?.tokens, 0);
  });

  test("回退轮次照计（原始日志不折叠 revert 界碑——钱花了）", async () => {
    store = freshStore();
    await store.ensureSession(meta());
    await store.record(ID, assistantWithUsage("m1", NOW, { input: 100, output: 10 }));
    await store.record(ID, {
      role: "revert",
      id: "rv1",
      timestamp: NOW + 1000,
      targetMessageId: "u1",
      restored: [],
    });
    const ledger = ledgerUtc();
    await ledger.backfill(store);
    assert.equal(ledger.week()[6]?.tokens, 110);
  });

  test("分支复制的同 id 历史只计一次", async () => {
    store = freshStore();
    await store.ensureSession(meta());
    const shared = assistantWithUsage("m1", NOW, { input: 100, output: 10 });
    await store.record(ID, shared);
    // 分支：另一条会话的日志里躺着同一条 assistant 记录（commitBranch 的原样拷贝）
    await store.ensureSession(meta({ id: OTHER }));
    await store.record(OTHER, shared);

    const ledger = ledgerUtc();
    await ledger.backfill(store);
    assert.equal(ledger.week()[6]?.tokens, 110);
  });

  test("backfilled 标记落盘：重开账本不再扫（也不重复计）", async () => {
    store = freshStore();
    await store.ensureSession(meta());
    await store.record(ID, assistantWithUsage("m1", NOW, { input: 100, output: 10 }));

    const first = ledgerUtc();
    await first.backfill(store);
    // 第二次（模拟重启后重读文件）
    const reopened = ledgerUtc();
    await reopened.load();
    await reopened.backfill(store);
    assert.equal(reopened.week()[6]?.tokens, 110);
  });

  test("回填后，落账路径再来同一条记录（扫描已计过）不重复计", async () => {
    store = freshStore();
    await store.ensureSession(meta());
    const item = assistantWithUsage("m1", NOW, { input: 100, output: 10 });
    await store.record(ID, item);
    const ledger = ledgerUtc();
    await ledger.backfill(store);
    await ledger.recordUsage({ id: item.id, timestamp: item.timestamp, usage: item.usage });
    assert.equal(ledger.week()[6]?.tokens, 110);
  });
});

describe("UsageLedger —— 坏文件安全回落", () => {
  test("半截 JSON：当空账本，回填重建", async () => {
    await writeFile(file, '{"version":1,"days":{"2026-10-0', "utf8");
    const store = new SessionStore(join(dir, "sessions"));
    await store.ensureSession(meta());
    await store.record(ID, assistantWithUsage("m1", NOW, { input: 100, output: 10 }));

    const ledger = ledgerUtc();
    await ledger.load();
    await ledger.backfill(store);
    assert.equal(ledger.week()[6]?.tokens, 110);
  });

  test("形状不对（version 2）：同样安全回落", async () => {
    await writeFile(file, '{"version":2,"days":{}}', "utf8");
    const ledger = ledgerUtc();
    await ledger.load();
    await ledger.recordUsage({ id: "m1", timestamp: NOW, usage: { input: 7 } });
    assert.equal(ledger.week()[6]?.tokens, 7);
  });

  test("坏键 / 坏值逐个跳过，好条目保留", async () => {
    await ledgerUtc().recordUsage({ id: "m1", timestamp: NOW, usage: { input: 50 } });
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      days: Record<string, number>;
      seen: Record<string, string>;
    };
    raw.days["not-a-date"] = 123;
    raw.days[todayKeyUtc(1)] = "many" as unknown as number;
    raw.seen["bad-entry"] = "yesterday";
    await writeFile(file, JSON.stringify(raw), "utf8");

    const reopened = ledgerUtc();
    await reopened.load();
    assert.equal(reopened.week()[6]?.tokens, 50);
    assert.equal(reopened.week()[5]?.tokens, 0);
  });
});

describe("UsageLedger —— 变更推送", () => {
  test("落账与回填完成后各推一份新的 7 天快照", async () => {
    const seen: number[][] = [];
    const ledger = ledgerUtc();
    ledger.onChange((days) => seen.push(days.map((d) => d.tokens)));
    await ledger.recordUsage({ id: "m1", timestamp: NOW, usage: { input: 5 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.[6], 5);

    const store = new SessionStore(join(dir, "sessions"));
    await store.ensureSession(meta());
    await store.record(ID, assistantWithUsage("m2", NOW, { input: 100, output: 10 }));
    await ledger.backfill(store);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.[6], 115);
  });
});
