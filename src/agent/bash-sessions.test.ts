/**
 * 会话表与环形缓冲的单元测试。
 *
 * 真正的进程生命周期（签到 / 杀树 / 寿命）在 `bash-observe.test.ts` 里用真子进程验；
 * 这里只验「不需要真进程」的那半边：缓冲截断的精确边界、不限并发、结束回调恰好一次、
 * 归属隔离与删会话收尾。全部用可注入的毫秒数，不真等 10 分钟。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  BashSession,
  RESULT_TAIL_LINES,
  SESSION_LIFETIME_MS,
  SESSION_RETENTION_MS,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
  TOOL_TAIL_LINES,
  TailBuffer,
  bindBashSessionToolCall,
  killAllSessions,
  listSessions,
  registerSession,
  stopOwnedSessions,
  stopSession,
  withBashReminder,
  type BashSessionEnd,
  type RegisterSessionInput,
} from "./bash-sessions.ts";

const fakeChild = { pid: 424242 } as unknown as ChildProcess;

function register(overrides: Partial<RegisterSessionInput> = {}): BashSession {
  return registerSession({
    child: fakeChild,
    command: "sleep 60",
    buffer: new TailBuffer(),
    startedAt: Date.now(),
    lastDataAt: Date.now(),
    killTree: () => {},
    ...overrides,
  });
}

/** 收集结束回调，并断言「恰好一次」 */
function collect(): { results: BashSessionEnd[]; onEnd: (result: BashSessionEnd) => void } {
  const results: BashSessionEnd[] = [];
  return { results, onEnd: (result) => results.push(result) };
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

describe("会话表 —— 不限并发、记录命令全文", () => {
  test("默认寿命 / 保留期 / 结果尾部行数是契约值", () => {
    assert.equal(SESSION_LIFETIME_MS, 4 * 60 * 60 * 1000);
    assert.equal(SESSION_RETENTION_MS, 10 * 60 * 1000);
    assert.equal(RESULT_TAIL_LINES, 200);
    assert.equal(TOOL_TAIL_LINES, 40);
  });

  test("不限并发：同时登记 12 个会话全部成功，没有任何拒绝路径", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => register({ command: `sleep ${index + 1}` }));
    assert.equal(new Set(sessions.map((session) => session.id)).size, 12);
    assert.equal(listSessions().length, 12);
  });

  test("listSessions 报告运行 / 结束与命令全文", () => {
    const first = register({ command: "npm run build" });
    const second = register({ command: "bun run test" });
    const running = listSessions().find((session) => session.id === first.id);
    assert.equal(running?.status, "running");
    assert.equal(running?.command, "npm run build");
    second.end(0);
    const finished = listSessions().find((session) => session.id === second.id);
    assert.equal(finished?.status, "finished");
    assert.equal(finished?.exitCode, 0);
    assert.equal(finished?.command, "bun run test");
  });
});

describe("结束回调 —— 恰好一次、内容完整", () => {
  test("自然结束：命令全文 / 退出码 / 耗时 / 尾部输出 / toolCallId 一次给全", () => {
    const end = collect();
    const session = register({ command: "make all", onEnd: end.onEnd, startedAt: Date.now() - 5_000 });
    session.append(Buffer.from("line 1\nline 2\ndone\n", "utf8"));
    bindBashSessionToolCall(session.id, "call-42");
    session.end(0);
    // 幂等：重复 end 不再回调
    session.end(0);
    assert.equal(end.results.length, 1);
    const result = end.results[0];
    assert.ok(result !== undefined);
    assert.equal(result.id, session.id);
    assert.equal(result.command, "make all");
    assert.equal(result.toolCallId, "call-42");
    assert.equal(result.status, "finished");
    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.ok(result.elapsedMs >= 5_000, `elapsedMs=${result.elapsedMs}`);
    assert.equal(result.output, "line 1\nline 2\ndone");
    assert.equal(result.endReason, undefined);
  });

  test("stopSession：杀 → killed + stop 原因，回调带 cancelled=true", async () => {
    const end = collect();
    const session = register({ command: "sleep 600", onEnd: end.onEnd });
    const summary = await stopSession(session.id, 50);
    assert.equal(summary?.status, "killed");
    assert.equal(summary?.endReason, "stop");
    assert.equal(end.results.length, 1);
    assert.equal(end.results[0]?.status, "killed");
    assert.equal(end.results[0]?.endReason, "stop");
    assert.equal(end.results[0]?.cancelled, true);
  });

  test("寿命上限：到点杀，原因 lifetime，并把上限说明写进输出", async () => {
    const end = collect();
    const session = register({ command: "sleep 600", onEnd: end.onEnd, lifetimeMs: 30, killSettleMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await session.waitForEnd(300);
    assert.equal(end.results.length, 1);
    assert.equal(end.results[0]?.endReason, "lifetime");
    assert.match(end.results[0]?.output ?? "", /lifetime limit/);
  });

  test("abort：原 signal 触发 → killed + abort 原因", async () => {
    const controller = new AbortController();
    const end = collect();
    const session = register({ command: "sleep 600", onEnd: end.onEnd, signal: controller.signal, killSettleMs: 20 });
    controller.abort();
    await session.waitForEnd(300);
    assert.equal(end.results[0]?.status, "killed");
    assert.equal(end.results[0]?.endReason, "abort");
  });

  test("杀完子进程一直不报退出：stopSession 的时限到了也照样结一次结果（不吞记录）", async () => {
    const end = collect();
    const session = register({ command: "stuck", onEnd: end.onEnd });
    const summary = await stopSession(session.id, 10);
    assert.equal(summary?.status, "killed");
    assert.equal(end.results.length, 1);
  });
});

describe("归属隔离 —— 同一个进程里的多条 Orbita 会话", () => {
  test("A 看不见、也停不掉 B 的会话", async () => {
    const a = register({ command: "a", owner: "A" });
    const b = register({ command: "b", owner: "B" });
    assert.deepEqual(
      listSessions("A").map((session) => session.id),
      [a.id],
    );
    assert.equal(await stopSession(b.id, 10, "A"), null);
    assert.equal(listSessions("B")[0]?.status, "running");
    await stopSession(a.id, 10, "A");
  });

  test("stopOwnedSessions：停掉 A 的全部后台命令，B 的一条不动", async () => {
    const a1 = register({ command: "a1", owner: "A" });
    const a2 = register({ command: "a2", owner: "A" });
    const b = register({ command: "b", owner: "B" });
    assert.equal(await stopOwnedSessions("A", 10), 2);
    assert.equal(a1.endedAt !== undefined, true);
    assert.equal(a2.endedAt !== undefined, true);
    assert.equal(b.endedAt, undefined);
  });

  test("没有后台命令的会话：无事可做，回 0", async () => {
    assert.equal(await stopOwnedSessions("missing", 10), 0);
  });
});

describe("下轮提醒 —— 有 / 没有 running 会话", () => {
  test("没有 running 会话：prompt 逐字不变", () => {
    assert.equal(withBashReminder("你好", []), "你好");
  });

  test("有一个 running 会话：尾部追加一句提醒，说明结果会自己回来", () => {
    const session = register({ command: "npm run build", owner: "A" });
    const prompt = withBashReminder("继续", listSessions("A"));
    assert.match(prompt, /background bash session b\d+ \(running/);
    assert.match(prompt, /written back when it finishes/);
    assert.match(prompt, /bash_list/);
    assert.doesNotMatch(prompt, /bash_poll/);
    assert.ok(session.id !== "");
  });

  test("多个 running 会话合并成一句（不分段，不刷屏）", () => {
    register({ command: "a", owner: "A" });
    register({ command: "b", owner: "A" });
    const prompt = withBashReminder("继续", listSessions("A"));
    assert.equal(prompt.split("\n\n").length, 2);
    assert.match(prompt, /background bash sessions/);
  });
});
