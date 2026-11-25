import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, SubmitAgentInput } from "../../shared/agent-ipc.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { REPLY_QUEUE_MAX, ReplyQueue, type MobileReply, type ReplyObserver } from "./replies.ts";
import { SessionPhases } from "../agent/run-state.ts";

const A = "0199a0aa-6bb0-7cc0-8000-00000000000a";
const B = "0199a0aa-6bb0-7cc0-8000-00000000000b";
const PHONE = "0123456789abcdef0123456789abcdef";
const OTHER_PHONE = "fedcba9876543210fedcba9876543210";

const metaOf = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: "一条任务",
  titleSource: "auto",
  cwd: "/repo/orbita",
  workspaceId: "ws-1",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "high",
  piSessionFile: "/data/pi-sessions/abc.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 2,
  ...patch,
});

/** 假的世界：meta 表、submitTurn、运行态表，以及回执的记录 */
class World {
  readonly metas = new Map<string, SessionMeta>([
    [A, metaOf(A)],
    [B, metaOf(B)],
  ]);
  readonly phases = new SessionPhases();
  readonly submitted: SubmitAgentInput[] = [];
  readonly sent: { reply: MobileReply; sessionId: string }[] = [];
  readonly failed: { reply: MobileReply; sessionId: string; code: string; message: string }[] = [];
  /** submitTurn 的替身：默认立刻成功；用例可以换掉 */
  onSubmit: (input: SubmitAgentInput) => Promise<void> = () => Promise.resolve();
  readonly queue: ReplyQueue;

  constructor() {
    this.queue = new ReplyQueue(
      {
        readMeta: async (id) => this.metas.get(id) ?? null,
        submitTurn: (input) => {
          this.submitted.push(input);
          return this.onSubmit(input);
        },
        isRunning: (id) => this.phases.isRunning(id),
      },
      this.observer(),
    );
  }

  private observer(): ReplyObserver {
    return {
      sent: (reply, sessionId) => void this.sent.push({ reply, sessionId }),
      failed: (reply, sessionId, error) => void this.failed.push({ reply, sessionId, code: error.code, message: error.message }),
    };
  }

}

const reply = (requestId: string, text = `话 ${requestId}`, source = PHONE): MobileReply => ({ requestId, text, source });
const idle = (sessionId: string): AgentEvent => ({ type: "phase", sessionId, phase: "idle" });
const running = (sessionId: string): AgentEvent => ({ type: "phase", sessionId, phase: "turn" });
/** 泵的顺序：phase 事件到了先更表，再给订阅者 */
const feed = (world: World, event: AgentEvent): void => {
  if (event.type === "phase") world.phases.set(event.sessionId, event.phase);
  world.queue.onAgentEvent(event);
};
/** 让排到链上的环都跑完（含 dispatch 里的 await） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("回一句：空闲时立刻发", () => {
  test("queued: false；开工上下文照会话 meta 拼，text 就是手机发来的那一句", async () => {
    const world = new World();
    const outcome = await world.queue.submit(A, reply("r1", "继续做"));
    assert.deepEqual(outcome, { queued: false, position: 0 });
    await flush();
    assert.equal(world.submitted.length, 1);
    assert.deepEqual(world.submitted[0], {
      sessionId: A,
      cwd: "/repo/orbita",
      workspaceId: "ws-1",
      resume: { piSessionFile: "/data/pi-sessions/abc.jsonl" },
      providerId: "zai",
      modelId: "glm-5.3",
      mode: "plan",
      thinkingLevel: "high",
      text: "继续做",
    });
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1"]);
    assert.deepEqual(world.failed, []);
  });

  test("在飞的那一条还没确认开跑之前，紧跟来的第二条排队，不直发（否则撞 already running）", async () => {
    const world = new World();
    let release: () => void = () => undefined;
    world.onSubmit = () => new Promise<void>((resolve) => (release = resolve));
    assert.deepEqual(await world.queue.submit(A, reply("r1")), { queued: false, position: 0 });
    // r1 的 submitTurn 还没返回：运行态表里这条会话还是 idle
    assert.equal(world.phases.isRunning(A), false);
    assert.deepEqual(await world.queue.submit(A, reply("r2")), { queued: true, position: 1 });
    release();
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1"]);
    assert.equal(world.submitted.length, 1);
    assert.equal(world.queue.pendingCount(A), 2);
  });
});

describe("回一句：在跑时排队、idle 一到按序发", () => {
  test("桌面端正开着这条会话：排队；它的 idle 一到按先后发，一次只发一条", async () => {
    const world = new World();
    feed(world, running(A));
    assert.deepEqual(await world.queue.submit(A, reply("r1")), { queued: true, position: 1 });
    assert.deepEqual(await world.queue.submit(A, reply("r2")), { queued: true, position: 2 });
    assert.deepEqual(await world.queue.submit(A, reply("r3")), { queued: true, position: 3 });
    assert.equal(world.submitted.length, 0);

    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1"]);
    // r1 在飞：r2 不跟着一起出去
    assert.equal(world.submitted.length, 1);

    feed(world, running(A));
    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2"]);

    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2", "r3"]);
    assert.deepEqual(world.submitted.map((input) => input.text), ["话 r1", "话 r2", "话 r3"]);
    // r3 的那一轮还在跑：槽要到它的 idle 才收
    assert.equal(world.queue.pendingCount(A), 1);
    feed(world, idle(A));
    await flush();
    assert.equal(world.queue.pendingCount(A), 0);
  });

  test("别的会话的 idle 不动这条的队列", async () => {
    const world = new World();
    feed(world, running(A));
    await world.queue.submit(A, reply("r1"));
    feed(world, idle(B));
    await flush();
    assert.equal(world.submitted.length, 0);
    feed(world, idle(A));
    await flush();
    assert.equal(world.submitted.length, 1);
  });

  test("idle 之后 runtime 还没收尾完（表里还在跑）就再等下一个 idle", async () => {
    const world = new World();
    world.phases.set(A, "turn");
    await world.queue.submit(A, reply("r1"));
    // 订阅者先于表收到 idle（表由泵更）：此刻表里还在跑，不投
    world.queue.onAgentEvent(idle(A));
    await flush();
    assert.equal(world.submitted.length, 0);
    world.phases.set(A, "idle");
    world.queue.onAgentEvent(idle(A));
    await flush();
    assert.equal(world.submitted.length, 1);
  });
});

describe("回一句：agent 侧的失败回到发起的手机", () => {
  test("回合级失败（重试耗尽）：在飞的那一条回 unavailable，带着原文；排着的下一条照常往下投", async () => {
    const world = new World();
    feed(world, running(A));
    await world.queue.submit(A, reply("r1"));
    await world.queue.submit(A, reply("r2"));
    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1"]);
    feed(world, running(A));
    // 泵里的顺序：failed 先到，idle 后到（那一轮此时还没收尾，表里仍在跑）
    world.queue.onAgentEvent({ type: "failed", sessionId: A, message: "Failed after 3 retries: 429 rate limited", turn: true });
    await flush();
    assert.equal(world.failed.length, 1);
    assert.equal(world.failed[0]?.reply.requestId, "r1");
    assert.equal(world.failed[0]?.reply.source, PHONE);
    assert.equal(world.failed[0]?.sessionId, A);
    assert.equal(world.failed[0]?.code, "unavailable");
    assert.match(world.failed[0]?.message ?? "", /429 rate limited/);
    // runtime 还没收尾完：r2 不投
    assert.equal(world.submitted.length, 1);
    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2"]);
  });

  test("没有在飞的回复时收到回合级失败（桌面端那轮挂了）：与手机无关，不回", async () => {
    const world = new World();
    feed(world, running(A));
    await world.queue.submit(A, reply("r1"));
    world.queue.onAgentEvent({ type: "failed", sessionId: A, message: "boom", turn: true });
    await flush();
    assert.deepEqual(world.failed, []);
    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1"]);
  });

  test("开轮本身出错（撞 already running）：发出后几秒内的操作级失败算这一条的", async () => {
    const world = new World();
    await world.queue.submit(A, reply("r1"));
    await flush();
    world.queue.onAgentEvent({ type: "failed", sessionId: A, message: "session is already running a turn" });
    await flush();
    assert.equal(world.failed.length, 1);
    assert.equal(world.failed[0]?.reply.requestId, "r1");
    assert.equal(world.failed[0]?.code, "unavailable");
    assert.match(world.failed[0]?.message ?? "", /already running/);
    // 失败之后这条会话回到空闲：后面来的回复可以直发
    assert.deepEqual(await world.queue.submit(A, reply("r2")), { queued: false, position: 0 });
  });

  test("发出好几秒之后才来的操作级失败是别的操作的（桌面上换模型没成），不冤枉回复", async () => {
    const world = new World();
    await world.queue.submit(A, reply("r1"));
    await flush();
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      world.queue.onAgentEvent({ type: "failed", sessionId: A, message: "unknown model" });
      await flush();
      assert.deepEqual(world.failed, []);
    } finally {
      Date.now = realNow;
    }
  });

  test("submitTurn 自己抛了（服务商关了、没有密钥）：回 unavailable，并接着投下一条", async () => {
    const world = new World();
    let calls = 0;
    world.onSubmit = async () => {
      calls += 1;
      if (calls === 1) throw new Error("This provider is turned off (智谱).");
    };
    await world.queue.submit(A, reply("r1"));
    // r1 还在装配，r2 排在后面
    await world.queue.submit(A, reply("r2"));
    await flush();
    assert.equal(world.failed.length, 1);
    assert.equal(world.failed[0]?.reply.requestId, "r1");
    assert.match(world.failed[0]?.message ?? "", /这句话没有发出去：This provider is turned off/);
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r2"]);
  });

  test("会话不在了回 not_found；续不了的会话（没有 pi 本子）回 unavailable；都不开轮", async () => {
    const world = new World();
    world.metas.delete(B);
    world.metas.set(A, metaOf(A, { piSessionFile: null }));
    await world.queue.submit(B, reply("gone"));
    await world.queue.submit(A, reply("readonly"));
    await flush();
    assert.equal(world.submitted.length, 0);
    assert.deepEqual(
      world.failed.map((entry) => [entry.reply.requestId, entry.code, entry.message]),
      [
        ["gone", "not_found", "这条任务已经不在了"],
        ["readonly", "unavailable", "这条任务只能看、不能接着聊（它没有可续的对话状态）"],
      ],
    );
    assert.deepEqual(world.sent, []);
    // 失败之后两条会话都回到空闲
    assert.equal(world.queue.pendingCount(A), 0);
    assert.equal(world.queue.pendingCount(B), 0);
  });

  test("runtime 整个没了：在飞的失败；排着的等下一次投递时机", async () => {
    const world = new World();
    await world.queue.submit(A, reply("r1"));
    await world.queue.submit(A, reply("r2"));
    await flush();
    // 泵会在这条事件之后清空运行态表
    world.queue.onAgentEvent({ type: "failed", sessionId: null, message: "agent runtime exited" });
    world.phases.clear();
    await flush();
    assert.deepEqual(world.failed.map((entry) => [entry.reply.requestId, entry.code]), [["r1", "unavailable"]]);
    assert.match(world.failed[0]?.message ?? "", /agent 进程退出了：agent runtime exited/);
    // r1 发出过、又没跑完：先 sent 后 failed，两个回执都到（failed 是终态）
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2"]);
    // r2 排着：runtime 没了之后这条会话算空闲，接着投（会把 runtime 重新拉起来）
  });
});

describe("回一句：排满了", () => {
  test("在跑时每条会话最多排 5 条，第 6 条回 busy，说清前面还有几句", async () => {
    const world = new World();
    feed(world, running(A));
    for (let i = 1; i <= REPLY_QUEUE_MAX; i += 1) {
      assert.deepEqual(await world.queue.submit(A, reply(`r${i}`)), { queued: true, position: i });
    }
    const sixth = await world.queue.submit(A, reply("r6"));
    assert.equal("error" in sixth && sixth.error.code, "busy");
    assert.equal("error" in sixth && sixth.error.message, "这条任务还有 5 句没发出去，等一等再回");
    // 别的会话不受影响
    assert.deepEqual(await world.queue.submit(B, reply("b1")), { queued: false, position: 0 });
  });
});

describe("回一句：停止", () => {
  test("停一条会话：待发的逐条回 unavailable，在飞的那一条不动，之后的 idle 不再投", async () => {
    const world = new World();
    feed(world, running(A));
    await world.queue.submit(A, reply("r1"));
    await world.queue.submit(A, reply("r2"));
    await world.queue.submit(A, reply("r3"));
    await world.queue.submit(B, reply("b1"));
    feed(world, idle(A));
    await flush();
    // b1 所在的会话空闲，先发出去了
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["b1", "r1"]);

    const dropped = await world.queue.cancel(A, { code: "unavailable", message: "这一轮被停掉了" });
    assert.equal(dropped, 2);
    assert.deepEqual(
      world.failed.map((entry) => [entry.reply.requestId, entry.reply.source, entry.code]),
      [
        ["r2", PHONE, "unavailable"],
        ["r3", PHONE, "unavailable"],
      ],
    );
    // 被停的那一轮收尾了：队列已空，什么都不发
    feed(world, idle(A));
    await flush();
    assert.equal(world.submitted.length, 2);
    assert.equal(world.queue.pendingCount(A), 0);
  });

  test("停止之后这条会话回到空闲：新来的回复直发", async () => {
    const world = new World();
    await world.queue.cancel(A, { code: "unavailable", message: "x" });
    assert.deepEqual(await world.queue.submit(A, reply("after")), { queued: false, position: 0 });
  });
});

describe("回一句：退出与杂项", () => {
  test("退出：待发的与在飞的都回失败，之后不再接新的", async () => {
    const world = new World();
    await world.queue.submit(A, reply("r1"));
    await world.queue.submit(A, reply("r2"));
    await flush();
    world.queue.cancelAll({ code: "unavailable", message: "电脑要退出了" });
    // 在飞的 r1 与排着的 r2 按入队先后逐条回
    assert.deepEqual(world.failed.map((entry) => entry.reply.requestId), ["r1", "r2"]);
    const late = await world.queue.submit(A, reply("late"));
    assert.equal("error" in late && late.error.code, "unavailable");
    // 已经排到链上的 idle 也不再投
    feed(world, idle(A));
    await flush();
    assert.equal(world.submitted.length, 1);
  });

  test("回执送不出去（观察者抛错）不影响队列", async () => {
    const queue = new ReplyQueue(
      {
        readMeta: async (id) => (id === A ? metaOf(A) : null),
        submitTurn: () => Promise.resolve(),
        isRunning: () => false,
      },
      {
        sent: () => {
          throw new Error("连接没了");
        },
        failed: () => {
          throw new Error("连接没了");
        },
      },
    );
    assert.deepEqual(await queue.submit(A, reply("r1")), { queued: false, position: 0 });
    await queue.submit(A, reply("r2"));
    await flush();
    queue.onAgentEvent({ type: "failed", sessionId: A, message: "x", turn: true });
    await flush();
    // 队列自己照常运转：r1 失败后 r2 发了出去（submitTurn 被调了两次）
    assert.equal(queue.pendingCount(A), 1);
  });

  test("两台手机各收各的回执：source 原样带回去", async () => {
    const world = new World();
    feed(world, running(A));
    await world.queue.submit(A, reply("p1", "第一台的话", PHONE));
    await world.queue.submit(A, reply("p2", "第二台的话", OTHER_PHONE));
    await world.queue.cancel(A, { code: "unavailable", message: "停" });
    assert.deepEqual(
      world.failed.map((entry) => entry.reply.source),
      [PHONE, OTHER_PHONE],
    );
  });

  test("空下来的会话不留槽；槽是在链尾收的，前后脚来的下一个仍排在同一条链上", async () => {
    const world = new World();
    await world.queue.submit(A, reply("r1"));
    await flush();
    feed(world, idle(A));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(world.queue.pendingCount(A), 0);
    // r1 的 idle 事件与新来的回复前后脚到：r2 排在 idle 后面，看到的是空闲，直发
    world.queue.onAgentEvent(idle(A));
    assert.deepEqual(await world.queue.submit(A, reply("r2")), { queued: false, position: 0 });
    // r2 在飞：r3 只能排队
    assert.deepEqual(await world.queue.submit(A, reply("r3")), { queued: true, position: 1 });
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2"]);
    feed(world, idle(A));
    await flush();
    assert.deepEqual(world.sent.map((entry) => entry.reply.requestId), ["r1", "r2", "r3"]);
  });
});
