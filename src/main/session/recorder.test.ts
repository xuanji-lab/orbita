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
    cwd: "/repo",
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

  test("写不进去也不抛——落盘失败不该让对话中断", async () => {
    const broken = createSessionRecorder(new SessionStore("/dev/null/nope"));
    assert.doesNotThrow(() => broken(progress({ type: "item_started", item: user })));
    await settle();
  });
});
