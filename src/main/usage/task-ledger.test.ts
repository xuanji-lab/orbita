import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { TaskLedger, type TaskBackfillSource } from "./task-ledger.ts";
import { taskRecordOf, type StoredTask } from "./task-cost.ts";

const TZ = "Asia/Singapore";
const DAY1 = Date.UTC(2026, 9, 20, 4); // 2026-10-20 12:00 SGT
const DAY2 = Date.UTC(2026, 9, 21, 4);

function reply(id: string, timestamp: number, model: string, level: ThinkingLevel, cost = 0.01, provider = "p"): SessionRecord {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider, id: model },
    usage: {
      input: 100,
      output: 10,
      cacheRead: 1000,
      cacheWrite: 0,
      totalTokens: 1110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    timestamp,
    status: "complete",
    stopReason: "stop",
    thinkingLevel: level,
  };
}

function meta(id: string, createdAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: "",
    titleSource: "derived",
    stats: null,
    cwd: "/",
    workspaceId: null,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    providerId: "p",
    modelId: "m",
    mode: "plan",
    thinkingLevel: "high",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

function source(logs: Record<string, SessionRecord[]>, metas: SessionMeta[]): TaskBackfillSource & { listed: number } {
  const src = {
    listed: 0,
    list: async () => {
      src.listed += 1;
      return metas;
    },
    readRawLog: async (id: string) => logs[id] ?? [],
    readPiFile: async () => null,
  };
  return src;
}

/** 按会话分组的任务序列（会话之间的先后与回填 / 增量的喂入顺序有关，组内顺序才是口径） */
function bySession(tasks: readonly StoredTask[]): Record<string, StoredTask[]> {
  const out: Record<string, StoredTask[]> = {};
  for (const task of tasks) (out[task.sessionId] ??= []).push(task);
  return out;
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-task-ledger-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const logs = {
  a: [
    reply("a1", DAY1, "glm-5.3", "max", 0.1),
    { id: "u", role: "user", content: [{ type: "text", text: "继续" }], timestamp: DAY1 + 1 },
    reply("a2", DAY1 + 2, "glm-5.3", "max", 0.2),
    reply("a3", DAY2, "glm-5.3", "high", 0.3),
    reply("a4", DAY2 + 1, "k3", "high", 0.4, "kimi-coding"),
  ],
  b: [reply("b1", DAY1 + 5, "glm-5.3", "max", 1)],
  // 分支：复制了 a 的前缀（同样的消息 id），之后自己走
  branch: [reply("a1", DAY1, "glm-5.3", "max", 0.1), reply("c1", DAY2 + 5, "glm-5.3", "max", 2)],
  imported: [reply("z1", DAY1, "glm-5.3", "max", 99)],
} satisfies Record<string, SessionRecord[]>;
const metas = [meta("a", 1), meta("b", 2), meta("branch", 3), meta("imported", 4, { importedFrom: "/x.jsonl" })];

describe("TaskLedger", () => {
  test("增量记账与全量回填得出同一本账（会话交错落盘也一样）", async () => {
    const full = new TaskLedger(join(dir, "full.json"), { timeZone: TZ });
    await full.load();
    await full.backfill(source(logs, metas));

    const live = new TaskLedger(join(dir, "live.json"), { timeZone: TZ });
    await live.load();
    await live.backfill(source({}, []));
    // 按时间交错落盘：a1 b1 a2 … 与真实使用一样，几条会话的回复穿插着到
    const feed: [string, SessionRecord][] = [
      ["a", logs.a[0]!],
      ["b", logs.b[0]!],
      ["a", logs.a[2]!],
      ["branch", logs.branch[0]!],
      ["a", logs.a[3]!],
      ["a", logs.a[4]!],
      ["branch", logs.branch[1]!],
    ];
    for (const [session, record] of feed) {
      const item = taskRecordOf(record, record.role === "assistant" && "thinkingLevel" in record ? record.thinkingLevel : undefined);
      if (item !== null) await live.record(session, item);
    }
    assert.deepEqual(bySession(live.tasks()), bySession(full.tasks()));
    // 口径本身：a 切成 glm max（两天里的同一段先在 DAY1）/ glm high / k3 high 三段；分支只剩自己的 c1
    const a = bySession(full.tasks())["a"] ?? [];
    assert.deepEqual(a.map((t) => `${t.modelId}/${t.level}`), ["glm-5.3/max", "glm-5.3/high", "k3/high"]);
    assert.deepEqual(Object.keys(bySession(full.tasks())["branch"]?.[0]?.days ?? {}), ["2026-10-21"]);
    assert.equal(bySession(full.tasks())["imported"], undefined);
  });

  test("去重：同一条消息 id 只计一次（重放、回填后又落盘）", async () => {
    const ledger = new TaskLedger(join(dir, "t.json"), { timeZone: TZ });
    await ledger.load();
    await ledger.backfill(source({ b: logs.b }, [meta("b", 2)]));
    const b1 = taskRecordOf(logs.b[0]!, "max");
    assert.ok(b1 !== null);
    const before = ledger.version();
    await ledger.record("b", b1);
    await ledger.record("b", b1);
    const day = Object.values(ledger.tasks()[0]?.days ?? {})[0];
    assert.equal(day?.recordedCost, 1);
    // 重复的那条没改账面：版本不动（图的请求据此直接用上次的结果）
    assert.equal(ledger.version(), before);
    const b2 = taskRecordOf(reply("b2", DAY1 + 6, "glm-5.3", "max", 2), "max");
    assert.ok(b2 !== null);
    await ledger.record("b", b2);
    assert.equal(ledger.version(), before + 1);
  });

  test("回填只跑一次：第二次不扫；重启后读盘也不再扫", async () => {
    const file = join(dir, "t.json");
    const src = source(logs, metas);
    const ledger = new TaskLedger(file, { timeZone: TZ });
    await ledger.load();
    assert.notEqual(await ledger.backfill(src), null);
    assert.equal(await ledger.backfill(src), null);
    assert.equal(src.listed, 1);

    const restarted = new TaskLedger(file, { timeZone: TZ });
    await restarted.load();
    assert.equal(await restarted.backfill(src), null);
    assert.equal(src.listed, 1);
    assert.deepEqual(restarted.tasks(), ledger.tasks());
  });

  test("重启后同一会话接着同一型号 × 档：并进原来那一段，不另起", async () => {
    const file = join(dir, "t.json");
    const ledger = new TaskLedger(file, { timeZone: TZ });
    await ledger.load();
    await ledger.backfill(source({ b: logs.b }, [meta("b", 2)]));

    const restarted = new TaskLedger(file, { timeZone: TZ });
    await restarted.load();
    const next = taskRecordOf(reply("b2", DAY1 + 9, "glm-5.3", "max", 3), "max");
    assert.ok(next !== null);
    await restarted.record("b", next);
    assert.equal(restarted.tasks().length, 1);
    assert.equal(Object.values(restarted.tasks()[0]?.days ?? {})[0]?.recordedCost, 4);
  });

  test("坏文件：按空账重建，回填重新扫", async () => {
    const file = join(dir, "t.json");
    await writeFile(file, "{坏的", "utf8");
    const ledger = new TaskLedger(file, { timeZone: TZ });
    await ledger.load();
    const stats = await ledger.backfill(source({ b: logs.b }, [meta("b", 2)]));
    assert.equal(stats?.sessions, 1);
    assert.equal(ledger.tasks().length, 1);
  });

  test("没盖章、也没有 pi 本子可补的旧会话：记成档不可考（计 token、数进 untrusted）", async () => {
    const old = { ...logs.b[0]!, id: "o1" } as SessionRecord & { thinkingLevel?: ThinkingLevel };
    delete old.thinkingLevel;
    const ledger = new TaskLedger(join(dir, "t.json"), { timeZone: TZ });
    await ledger.load();
    const stats = await ledger.backfill(source({ o: [old] }, [meta("o", 1)]));
    assert.equal(stats?.untrustedSessions, 1);
    assert.equal(ledger.tasks()[0]?.level, null);
    assert.equal(ledger.untrustedSessions(), 1);
  });
});
