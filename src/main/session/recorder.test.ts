import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
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

/** 事件是同步发的、写盘是异步的，等一轮微任务让写落下去 */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-recorder-"));
  store = new SessionStore(join(dir, "sessions"));
  record = createSessionRecorder(store);
  await store.create({
    id: ID,
    title: "",
    titleSource: "derived",
    cwd: "/repo",
    workspaceId: null,
    piSessionFile: null,
    pinned: false,
    archived: false,
    providerId: "zai",
    modelId: "glm-5.3",
    mode: "plan",
    createdAt: 1,
    updatedAt: 1,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createSessionRecorder", () => {
  test("用户消息走 item_started 落盘——它出生即完成，不会再有 finished", async () => {
    record(progress({ type: "item_started", item: user }));
    await settle();
    assert.equal((await store.load(ID))?.transcript.length, 1);
  });

  test("assistant 走 item_finished 落盘", async () => {
    record(progress({ type: "item_finished", item: assistant("complete") }));
    await settle();
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
    await settle();
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item !== undefined, true);
    assert.equal(item !== undefined && "status" in item ? item.status : undefined, "aborted");
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
    await settle();
    const item = (await store.load(ID))?.transcript[0];
    assert.equal(item?.role, "tool");
    assert.deepEqual(item, toolDone(false));
  });

  test("失败的 tool 调用照样落盘,isError 带在身上", async () => {
    record(progress({ type: "item_finished", item: toolDone(true) }));
    await settle();
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
    await settle();
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

describe("recorder 的 title 事件（C-3）", () => {
  test("标题落 meta（title + titleSource = auto），不落 transcript", async () => {
    record({ type: "title", sessionId: ID, title: "修复登录按钮" });
    await settle();
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
    await settle();
    const detail = await store.load(ID);
    assert.equal(detail?.meta.providerId, "other");
    assert.equal(detail?.meta.modelId, "m2");
    assert.deepEqual(detail?.transcript, []);
  });
});
