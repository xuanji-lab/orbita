/**
 * 会话表与环形缓冲的单元测试。
 *
 * 真正的进程生命周期（签到 / 杀树 / 寿命）在 `bash-observe.test.ts` 里用真子进程验；
 * 这里只验「不需要真进程」的那半边：缓冲截断的精确边界、并发上限、poll 的等待与
 * 提前返回、结束后的保留与 GC。全部用可注入的毫秒数，不真等 10 分钟。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  BashSession,
  MAX_SESSIONS,
  SESSION_LIFETIME_MS,
  SESSION_RETENTION_MS,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
  TailBuffer,
  killAllSessions,
  listSessions,
  pollSession,
  registerSession,
  stopSession,
} from "./bash-sessions.ts";

const fakeChild = { pid: 424242 } as unknown as ChildProcess;

function register(overrides: {
  lifetimeMs?: number;
  maxSessions?: number;
  retentionMs?: number;
  signal?: AbortSignal;
  owner?: string;
} = {}): BashSession {
  const result = registerSession({
    child: fakeChild,
    buffer: new TailBuffer(),
    startedAt: Date.now(),
    lastDataAt: Date.now(),
    killTree: () => {},
    ...overrides,
  });
  assert.ok(result.ok, "expected the session to register");
  return result.session;
}

afterEach(() => {
  killAllSessions();
});

describe("TailBuffer —— 先到先丢，保留尾部", () => {
  test("行数上限：3000 行只留最后 2000 行", () => {
    const buffer = new TailBuffer();
    for (let index = 1; index <= 3000; index += 1) {
      buffer.append(Buffer.from(`line ${index}\n`, "utf8"));
    }
    assert.ok(buffer.lines <= TAIL_MAX_LINES, `lines=${buffer.lines}`);
    const tail = buffer.tail(40).split("\n");
    assert.equal(tail.length, 40);
    assert.equal(tail[0], "line 2961");
    assert.equal(tail[39], "line 3000");
    assert.doesNotMatch(buffer.text(), /^line 1\n/);
  });

  test("字节上限：超过 256 KB 的块只留尾部，且行数统计只算保留部分", () => {
    const buffer = new TailBuffer();
    const head = Buffer.alloc(TAIL_MAX_BYTES - 32, 0x61); // 一行没有的填充
    buffer.append(head);
    buffer.append(Buffer.from("\n" + "b".repeat(64) + "END_MARKER\n", "utf8"));
    const appended = head.length + 1 + 64 + "END_MARKER\n".length;
    assert.equal(buffer.bytes, TAIL_MAX_BYTES, `应精确截到上限（append=${appended}）`);
    assert.match(buffer.tail(10), /END_MARKER/);
  });

  test("超长单行也不越界：256 KB 里截断，tail 仍给出可读的尾部", () => {
    const buffer = new TailBuffer();
    buffer.append(Buffer.from("x".repeat(TAIL_MAX_BYTES + 1000) + "-TAIL\n", "utf8"));
    assert.ok(buffer.bytes <= TAIL_MAX_BYTES, `bytes=${buffer.bytes}`);
    assert.match(buffer.tail(5), /-TAIL/);
  });

  test("未满时逐字节保留，尾行不带多余空行", () => {
    const buffer = new TailBuffer();
    buffer.append(Buffer.from("a\nb\nc\n", "utf8"));
    assert.equal(buffer.text(), "a\nb\nc\n");
    assert.equal(buffer.tail(40), "a\nb\nc");
    assert.equal(buffer.lines, 3);
  });
});

describe("会话表 —— 上限与查询", () => {
  test("默认上限与寿命常量是契约值", () => {
    assert.equal(MAX_SESSIONS, 8);
    assert.equal(SESSION_LIFETIME_MS, 4 * 60 * 60 * 1000);
    assert.equal(SESSION_RETENTION_MS, 10 * 60 * 1000);
  });

  test("并发上限：满了就拒绝，并给出可读的 max 文案", () => {
    register({ maxSessions: 1 });
    const second = registerSession({
      child: fakeChild,
      buffer: new TailBuffer(),
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      killTree: () => {},
      maxSessions: 1,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.message, /Too many detached bash sessions.*max 1/);
    assert.equal(listSessions().length, 1);
  });

  test("已结束的会话不占并发名额", async () => {
    const first = register({ maxSessions: 1 });
    first.end(0);
    const second = registerSession({
      child: fakeChild,
      buffer: new TailBuffer(),
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      killTree: () => {},
      maxSessions: 1,
    });
    assert.equal(second.ok, true);
  });

  test("listSessions 报告运行 / 结束，不消费「新行」", () => {
    const session = register();
    session.append(Buffer.from("hello\n", "utf8"));
    const [summary] = listSessions();
    assert.equal(summary?.id, session.id);
    assert.equal(summary?.status, "running");
    assert.equal(session.unreadLines, 1);
    listSessions();
    assert.equal(session.unreadLines, 1, "list 不该把行算成看过了");
  });
});

describe("poll —— 等待与提前返回", () => {
  test("新输出提前返回，+N 行如实", async () => {
    const session = register();
    setTimeout(() => session.append(Buffer.from("tick 1\ntick 2\n", "utf8")), 80);
    const startedAt = Date.now();
    const snapshot = await pollSession(session.id, 3_000);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1_500, `应提前返回（实测 ${elapsed}ms）`);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.newLines, 2);
    assert.match(snapshot.tail, /tick 2/);
  });

  test("没有新输出就等满，idle 随时间增长", async () => {
    const session = register();
    const startedAt = Date.now();
    const snapshot = await pollSession(session.id, 300);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 250, `应等满 300ms（实测 ${elapsed}ms）`);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.newLines, 0);
    assert.ok(snapshot.idleMs >= 250, `idle 应增长（实测 ${snapshot.idleMs}ms）`);
  });

  test("命令结束 → finished + 退出码，poll 立刻返回", async () => {
    const session = register();
    setTimeout(() => session.end(0), 50);
    const startedAt = Date.now();
    const snapshot = await pollSession(session.id, 3_000);
    assert.ok(Date.now() - startedAt < 1_500);
    assert.equal(snapshot.status, "finished");
    assert.equal(snapshot.exitCode, 0);
  });

  test("不存在的 id → too-old，不抛错", async () => {
    const snapshot = await pollSession("b9999", 10);
    assert.equal(snapshot.status, "too-old");
    assert.equal(snapshot.newLines, 0);
  });

  test("stopSession：杀 → killed，且返回可读原因", async () => {
    const session = register();
    const snapshot = await stopSession(session.id, 50);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.endReason, "stop");
    assert.equal(await stopSession("b9999"), null);
  });
});

describe("生命周期 —— 寿命、保留、abort", () => {
  test("寿命上限：到点杀，并把原因写进缓冲", async () => {
    const session = register({ lifetimeMs: 120 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snapshot = await pollSession(session.id, 10);
    assert.equal(snapshot.status, "killed");
    assert.equal(snapshot.endReason, "lifetime");
    assert.match(snapshot.tail, /kind=cap reason=lifetime/);
    assert.match(snapshot.tail, /lifetime limit/);
  });

  test("结束后保留可查，超过保留期 GC", async () => {
    const session = register({ retentionMs: 100 });
    session.end(3);
    const kept = await pollSession(session.id, 10);
    assert.equal(kept.status, "finished");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const gone = await pollSession(session.id, 10);
    assert.equal(gone.status, "too-old");
    assert.equal(listSessions().length, 0);
  });

  test("abort 原 signal → 会话被判 killed，原因 abort", async () => {
    const controller = new AbortController();
    const session = register({ signal: controller.signal });
    controller.abort();
    const snapshot = await pollSession(session.id, 10);
    assert.equal(snapshot.status, "killed");
    assert.equal(snapshot.endReason, "abort");
  });

  test("killAllSessions：进程退出时清空整张表，会话定时器一并撤掉", () => {
    register({ lifetimeMs: 60_000 });
    register({ lifetimeMs: 60_000 });
    assert.equal(listSessions().length, 2);
    killAllSessions();
    assert.equal(listSessions().length, 0);
  });
});

describe("归属隔离 —— 同一个进程里的多条 Orbita 会话", () => {
  test("A 看不见、也停不掉 B 的会话", async () => {
    const a = register({ owner: "sess-a" });
    const b = register({ owner: "sess-b" });

    // list：各看各的
    assert.deepEqual(listSessions("sess-a").map((x) => x.id), [a.id]);
    assert.deepEqual(listSessions("sess-b").map((x) => x.id), [b.id]);

    // poll：别人的 id 当作不存在（不泄漏「有这条命令」）
    const peek = await pollSession(b.id, 0, "sess-a");
    assert.equal(peek.status, "too-old");

    // stop：停不掉别人
    assert.equal(await stopSession(b.id, 0, "sess-a"), null);
    assert.equal(b.endedAt, undefined, "B 的会话不该被 A 停掉");
  });

  test("并发上限按归属计：A 占满不该堵住 B", () => {
    register({ owner: "sess-a", maxSessions: 1 });
    const full = registerSession({
      child: fakeChild, buffer: new TailBuffer(), startedAt: Date.now(), lastDataAt: Date.now(),
      killTree: () => {}, owner: "sess-a", maxSessions: 1,
    });
    assert.equal(full.ok, false, "A 的第二条应被自己的上限拒绝");
    const other = registerSession({
      child: fakeChild, buffer: new TailBuffer(), startedAt: Date.now(), lastDataAt: Date.now(),
      killTree: () => {}, owner: "sess-b", maxSessions: 1,
    });
    assert.equal(other.ok, true, "B 不该被 A 的预算影响");
  });
});
