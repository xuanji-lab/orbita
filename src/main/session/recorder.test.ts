import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { composeChannelPrompt } from "../../shared/channel.ts";
import { createSessionRecorder } from "./recorder.ts";
import { SessionStore } from "./store.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";

const user = {
  id: "u1",
  role: "user" as const,
  content: [{ type: "text" as const, text: "重做外壳" }],
  timestamp: 1000,
};

const assistant = (status: "complete" | "aborted") =>
  status === "aborted"
    ? {
        id: "a1",
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "我正说到一半" }],
        model: { provider: "zai", id: "glm-5.3" },
        timestamp: 2000,
        status: "aborted" as const,
        stopReason: "aborted" as const,
      }
    : {
        id: "a1",
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "说完了" }],
        model: { provider: "zai", id: "glm-5.3" },
        timestamp: 2000,
        status: "complete" as const,
        stopReason: "stop" as const,
      };

const progress = (p: Extract<AgentEvent, { type: "progress" }>["progress"]): AgentEvent => ({
  type: "progress",
  sessionId: ID,
  progress: p,
});

let dir = "";
let store: SessionStore;
let record: (event: AgentEvent) => void;

/**
 * 事件是同步发的、写盘是异步的：**等条件成立**再断言，不用固定 sleep。
 *
 * 固定 20ms 在 `node --test` 按文件并行、整仓一起跑时不够（Windows 上写盘尤其慢）：
 * 断言会读到写盘前的旧值，afterEach 的 rm 还会撞上正在写的文件（ENOTEMPTY）。
 * 超时不在这里抛——让下面的断言报出真实的 actual/expected 更好读。
 *
 * 「什么都不该落」的用例仍然用 settle：那些事件被 recorder 同步丢掉，没有写盘要等。
 */
const settleUntil = async (ready: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await ready())) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** 等到 transcript 落了 count 条 */
const transcriptLanded = (count: number) => async (): Promise<boolean> =>
  ((await store.load(ID))?.transcript.length ?? -1) === count;

/** 「什么都不该落」：给写盘留出宽裕的一轮（已落定的写不会因为等得久就变多） */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-recorder-"));
  store = new SessionStore(join(dir, "sessions"));
  record = createSessionRecorder(store);
  await store.ensureSession({
    id: ID,
    title: "",
    titleSource: "derived",
    stats: null,
    cwd: "/repo",
    workspaceId: null,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    providerId: "zai",
    modelId: "glm-5.3",
    mode: "plan",
    thinkingLevel: "medium",
    createdAt: 1,
    updatedAt: 1,
  });
});
afterEach(async () => {
  // Windows 上删一个“里面刚被写过”的目录会报 ENOTEMPTY（异步写落定的瞬间刚好撞上）。
  // 重试几次，别让清理把一条已经通过的用例变红。
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (cause) {
      if (attempt >= 5) throw cause;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe("createSessionRecorder", () => {
  test("用户消息走 item_started 落盘——它出生即完成，不会再有 finished", async () => {
    record(progress({ type: "item_started", item: user }));
    await settleUntil(transcriptLanded(1));
    assert.equal((await store.load(ID))?.transcript.length, 1);
  });

  test("assistant 走 item_finished 落盘", async () => {
    record(progress({ type: "item_finished", item: assistant("complete") }));
    await settleUntil(transcriptLanded(1));
    assert.equal((await store.load(ID))?.transcript.length, 1);
  });

  test("流式中的 assistant 不落盘——否则同一条会被写很多遍", async () => {
    record(progress({ type: "item_started", item: assistant("complete") }));
    record(progress({ type: "item_updated", item: assistant("complete") }));
    record(
      progress({ type: "assistant_delta", messageId: "a1", contentIndex: 0, kind: "text", delta: "x" }),
    );
    await settle();
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  /**
   * 这条是修正一次错误判断留下的。pi 的 agent-loop 在 abort 时**先无条件发 message_end**、
   * 之后才判 stopReason === "aborted"，所以半截回答照样走终态帧。
   * 不落的话，重开会话看到的会比当时屏幕上少一截——用户已经读过那半句了。
   */
  test("被打断的半截回答照样落盘，靠 status 区分而不是靠存不存", async () => {
    record(progress({ type: "item_finished", item: assistant("aborted") }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item !== undefined, true);
    assert.equal(item !== undefined && "status" in item ? item.status : undefined, "aborted");
  });

  // 空 error 回答：auto_retry 的失败尝试（以及非流式阶段被 interrupt 打断）经
  // message_end 发一条 status=error、content 为空的终态帧。pi 自己的本子会收它，
  // 我们刻意不收（空条目没有上下文价值）；由此产生的两本账差异，由分支对账侧
  // 对 pi 条目施加同一谓词抵消（store.ts isEmptyErrorAssistant / branch-cut.ts 同名 entry 版）。
  const retryTail = {
    id: "a2",
    role: "assistant" as const,
    content: [],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp: 3000,
    status: "error" as const,
    stopReason: "error" as const,
  };

  test("空 error 回答不落盘——status=error 且内容为空", async () => {
    record(progress({ type: "item_finished", item: retryTail }));
    await settle();
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  test("带内容的 error assistant 照样落盘——真失败要有尸体可查", async () => {
    const halfSaid = { ...retryTail, id: "a3", content: [{ type: "text" as const, text: "说到一半断了" }] };
    record(progress({ type: "item_finished", item: halfSaid }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item !== undefined && "status" in item ? item.status : undefined, "error");
  });

  test("非 progress 事件一概不管", async () => {
    record({ type: "ready" });
    record({ type: "phase", sessionId: ID, phase: "idle" });
    record({ type: "failed", sessionId: ID, message: "boom" });
    await settle();
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  /** 刀 0-1 之后 adapter 会发 tool 的终态帧——`item_finished` 分支不看 role,天然收进来。 */
  type ToolDoneItem = {
    id: string;
    role: "tool";
    toolCallId: string;
    toolName: string;
    input: { command: string };
    content: { type: "text"; text: string }[];
    timestamp: number;
  } & ({ status: "error"; isError: true } | { status: "complete"; isError: false });

  // 返回类型显式写成联合：让 TS 保留判别配对，别把 isError 归并成 boolean
  const toolDone = (isError: boolean): ToolDoneItem => ({
    id: "t1",
    role: "tool",
    toolCallId: "tc1",
    toolName: "bash",
    input: { command: "ls src" },
    content: [{ type: "text", text: "agent/\nmain/" }],
    timestamp: 3000,
    ...(isError
      ? { status: "error" as const, isError: true }
      : { status: "complete" as const, isError: false }),
  });

  test("tool 终态帧落盘,字段原样", async () => {
    record(progress({ type: "item_finished", item: toolDone(false) }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item?.role, "tool");
    assert.deepEqual(item, toolDone(false));
  });

  test("失败的 tool 调用照样落盘,isError 带在身上", async () => {
    record(progress({ type: "item_finished", item: toolDone(true) }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item !== undefined && "isError" in item ? item.isError : undefined, true);
  });

  test("tool 的 running / 流式帧不落盘——与 assistant 流式同理,只认终态", async () => {
    // running 态：isError 恒为 false（pi 判别联合的要求），spread 会把它拓宽成 boolean,这里钉死
    const running = { ...toolDone(false), status: "running" as const, isError: false as const };
    record(progress({ type: "item_started", item: running }));
    record(progress({ type: "item_updated", item: running }));
    await settle();
    assert.deepEqual((await store.load(ID))?.transcript, []);
  });

  test("写不进去也不抛——落盘失败不该让对话中断", async () => {
    const broken = createSessionRecorder(new SessionStore("/dev/null/nope"));
    assert.doesNotThrow(() => broken(progress({ type: "item_started", item: user })));
    await settle();
  });

  // ── 刀 0-3：压缩界碑 ──
  // （aborted / 摘要失败的压缩在 runtime 就不发事件——recorder 没机会见到它,无需测）

  const compacted = {
    role: "compacted" as const,
    id: "c1",
    summary: "## Goal\n重做外壳",
    tokensBefore: 85000,
    tokensAfter: 8200,
    timestamp: 4000,
  };

  test("compaction 事件原样落盘,六个字段一个不少", async () => {
    record({ type: "compaction", sessionId: ID, record: compacted });
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.deepEqual(item, compacted);
    assert.equal(item !== undefined && "summary" in item ? item.summary : undefined, compacted.summary);
  });

  test("界碑不挤占标题推导——title 只认第一条用户消息", async () => {
    record({ type: "compaction", sessionId: ID, record: compacted });
    await settle();
    assert.equal((await store.load(ID))?.meta.title, "");
  });
});

describe("recorder 的通道标记识别（子会话 2026-09-23：信封自描述 + recorder 无状态识别）", () => {
  const envelopeUser = (text: string, id = "u-env", timestamp = 5000) => ({
    id,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  });

  test("信封 user → 落一条 ChannelMarkRecord，不落 user 消息", async () => {
    const prompt = composeChannelPrompt(
      {
        id: "m1",
        from: "parent",
        author: "model",
        kind: "task",
        text: "去把外壳重做",
        delivery: "followUp",
        createdAt: 1,
      },
      { id: "p1", title: "母任务" },
    );
    record(progress({ type: "item_started", item: envelopeUser(prompt) }));
    await settleUntil(transcriptLanded(1));
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 1);
    assert.deepEqual(detail?.transcript[0], {
      role: "channel-mark",
      id: "u-env",
      peerId: "p1",
      messageId: "m1",
      from: "parent",
      kind: "task",
      timestamp: 5000,
    });
  });

  test("普通 user 消息照旧落成 user 记录——不是每条 user 消息都要过一遍解析开销地改变落盘形状", async () => {
    record(progress({ type: "item_started", item: user }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item?.role, "user");
  });

  test("assistant 里出现信封文本不受影响——只有 user 的 item_started 才检查", async () => {
    const prompt = composeChannelPrompt(
      {
        id: "m2",
        from: "child",
        author: "model",
        kind: "question",
        text: "要不要继续",
        delivery: "followUp",
        createdAt: 2,
      },
      { id: "c1", title: "子任务" },
    );
    const assistantWithEnvelopeLikeText = {
      id: "a-env",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: prompt }],
      model: { provider: "zai", id: "glm-5.3" },
      timestamp: 6000,
      status: "complete" as const,
      stopReason: "stop" as const,
    };
    record(progress({ type: "item_finished", item: assistantWithEnvelopeLikeText }));
    await settleUntil(transcriptLanded(1));
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item?.role, "assistant");
  });
});

describe("recorder 的 title 事件（C-3）", () => {
  test("标题落 meta（title + titleSource = auto），不落 transcript", async () => {
    record({ type: "title", sessionId: ID, title: "修复登录按钮" });
    await settleUntil(async () => (await store.load(ID))?.meta.title === "修复登录按钮");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "修复登录按钮");
    assert.equal(detail?.meta.titleSource, "auto");
    assert.deepEqual(detail?.transcript, []);
  });

  test("用户已改名的会话，迟到的标题整份丢弃", async () => {
    await store.rename(ID, "我的名字");
    record({ type: "title", sessionId: ID, title: "模型猜的名字" });
    await settle();
    const detail = await store.load(ID);
    assert.equal(detail?.meta.title, "我的名字");
    assert.equal(detail?.meta.titleSource, "user");
  });
});

describe("recorder 的 model 事件（C-4）", () => {
  test("providerId / modelId 落 meta，不落 transcript——重开播种与分支继承读的就是它", async () => {
    record({ type: "model", sessionId: ID, providerId: "other", modelId: "m2" });
    await settleUntil(async () => (await store.load(ID))?.meta.providerId === "other");
    const detail = await store.load(ID);
    assert.equal(detail?.meta.providerId, "other");
    assert.equal(detail?.meta.modelId, "m2");
    assert.deepEqual(detail?.transcript, []);
  });
});

describe("recorder 给 assistant 记录盖本轮生效的思考档（价格 · 能力图的「型号 × 档」）", () => {
  const assistantAt = (id: string, timestamp: number) => ({ ...assistant("complete"), id, timestamp });
  const thinking = (level: "low" | "high" | "xhigh" | "max"): AgentEvent => ({
    type: "thinking",
    sessionId: ID,
    level,
    supported: ["low", "high", "max"],
  });
  const rawLevels = async () =>
    (await store.readRawLog(ID)).map((r) => (r.role === "assistant" && "thinkingLevel" in r ? r.thinkingLevel : "absent"));

  test("没收到过 thinking 事件（进程刚起、老夹具）：不盖，字段缺席，记录照落", async () => {
    record(progress({ type: "item_finished", item: assistant("complete") }));
    await settleUntil(transcriptLanded(1));
    assert.deepEqual(await rawLevels(), ["absent"]);
  });

  test("盖的是开轮事件报的 clamp 后真值，不是 meta 里用户点的档", async () => {
    // meta 里是 medium（用户点的），runtime 夹成 high 推回来
    record(thinking("high"));
    record(progress({ type: "item_finished", item: assistant("complete") }));
    await settleUntil(transcriptLanded(1));
    assert.deepEqual(await rawLevels(), ["high"]);
  });

  test("会话中途切档：每条记录盖各自那一轮的档；thinking 事件本身不落 transcript", async () => {
    record(thinking("low"));
    record(progress({ type: "item_finished", item: assistantAt("a1", 2000) }));
    await settleUntil(transcriptLanded(1));
    record(thinking("max"));
    record(progress({ type: "item_finished", item: assistantAt("a2", 3000) }));
    await settleUntil(transcriptLanded(2));
    assert.deepEqual(await rawLevels(), ["low", "max"]);
  });

  test("别的会话的 thinking 事件不串档", async () => {
    record({ type: "thinking", sessionId: "other", level: "max", supported: ["max"] });
    record(progress({ type: "item_finished", item: assistant("complete") }));
    await settleUntil(transcriptLanded(1));
    assert.deepEqual(await rawLevels(), ["absent"]);
  });
});
