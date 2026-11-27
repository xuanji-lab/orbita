import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import type { ChannelEvent } from "../../shared/agent-ipc.ts";
import { channelStatus, type ChannelMessage } from "../../shared/channel.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { SessionStore } from "../session/store.ts";
import { ChannelReconciler } from "./reconcile.ts";
import { ChannelStore } from "./store.ts";

const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ERROR = "11111111-1111-4111-8111-111111111111";
const TOOL = "22222222-2222-4222-8222-222222222222";
const DONE = "33333333-3333-4333-8333-333333333333";
const ACTIVE = "44444444-4444-4444-8444-444444444444";
const STOPPED = "55555555-5555-4555-8555-555555555555";
const WAITING = "66666666-6666-4666-8666-666666666666";
const LARGE = "77777777-7777-4777-8777-777777777777";
const LIVE = "88888888-8888-4888-8888-888888888888";

const meta = (id: string, parentId?: string): SessionMeta => ({
  id,
  title: id.slice(0, 8),
  titleSource: "user",
  stats: null,
  cwd: "/repo",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "skip",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  createdAt: 1,
  updatedAt: 1,
  ...(parentId === undefined ? {} : { parentId }),
});

const task = (childId: string): ChannelMessage => ({
  id: `task-${childId}`,
  from: "parent",
  author: "model",
  kind: "task",
  text: "做任务",
  delivery: "followUp",
  createdAt: 1,
});

const assistant = (status: string, stopReason: string, toolCall = false, errorMessage?: string) => ({
  id: `a-${status}-${stopReason}`,
  role: "assistant",
  content: toolCall
    ? [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "sleep 10" } }]
    : [{ type: "text", text: "回答" }],
  timestamp: 2,
  status,
  stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

let dir = "";
let sessions: SessionStore;
let channels: ChannelStore;
let phases: Map<string, SessionPhase>;
let events: ChannelEvent[];
let clock = 0;
let reconciler: ChannelReconciler;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-channel-reconcile-"));
  channels = new ChannelStore(join(dir, "channels"));
  sessions = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"), channels);
  phases = new Map();
  events = [];
  clock = 0;
  reconciler = new ChannelReconciler({
    sessions,
    channels,
    phases,
    broadcast: (event) => events.push(event),
    now: () => 1000 + ++clock,
    newId: () => `closure-${clock}`,
  });
  await sessions.ensureSession(meta(PARENT));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedChild(id: string, records: readonly unknown[]): Promise<void> {
  await sessions.ensureSession(meta(id, PARENT));
  await channels.append({ parentId: PARENT, childId: id }, task(id));
  await writeFile(sessions.recordPath(id), records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
}

describe("ChannelReconciler · 启动收尾", () => {
  test("error / tool 尾 / 正常 stop 分别落 failed / interrupted / done；活轮与已有终态不动，重启幂等", async () => {
    await seedChild(ERROR, [assistant("error", "error", true, "429 quota exceeded")]);
    await seedChild(TOOL, [
      assistant("complete", "toolUse", true),
      { id: "t1", role: "tool", toolCallId: "call-1", toolName: "bash", content: [], timestamp: 3, status: "complete" },
    ]);
    await seedChild(DONE, [assistant("complete", "stop")]);
    await seedChild(ACTIVE, [assistant("complete", "toolUse", true)]);
    phases.set(ACTIVE, "turn");
    await seedChild(STOPPED, [assistant("complete", "toolUse", true)]);
    await channels.append(
      { parentId: PARENT, childId: STOPPED },
      { ...task(STOPPED), id: "stop-1", kind: "stop", author: "user", text: "", createdAt: 4 },
    );
    await seedChild(WAITING, [assistant("complete", "stop")]);
    await channels.append(
      { parentId: PARENT, childId: WAITING },
      { ...task(WAITING), id: "q-1", from: "child", kind: "question", text: "要继续吗", createdAt: 4 },
    );

    const notices = await reconciler.reconcileAll();
    assert.deepEqual(
      notices
        .map((notice) => [notice.childId, notice.status, notice.message.endCause])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        [ERROR, "failed", "quota"],
        [TOOL, "interrupted", "app-exit"],
        [DONE, "done", "completed"],
      ],
    );
    assert.equal(events.length, 0, "启动通知延迟到 renderer 第一次 channel:list");
    for (const id of [ACTIVE, STOPPED, WAITING]) {
      assert.equal((await channels.load({ parentId: PARENT, childId: id })).some((m) => m.author === "system"), false);
    }

    const summary = (await channels.listForParent(PARENT, async () => "child")).find((item) => item.childId === ERROR);
    assert.equal(summary?.status, "failed");
    assert.equal(summary?.end?.endCause, "quota");
    assert.match(summary?.end?.text ?? "", /429 quota/);

    const before = await channels.load({ parentId: PARENT, childId: ERROR });
    assert.equal(before[0]?.kind, "task", "旧账原样保留，只追加终局");
    assert.equal(before.at(-1)?.author, "system");
    assert.deepEqual(await reconciler.reconcileAll(), [], "第二次启动不重复收尾");
    assert.equal((await channels.load({ parentId: PARENT, childId: ERROR })).length, before.length);
  });

  test("尾部大行不会遮住最后错误；最后 file-turn 特别大时流式回扫仍认正常 stop", async () => {
    await seedChild(LARGE, [assistant("complete", "stop")]);
    await appendFile(sessions.recordPath(LARGE), JSON.stringify({ role: "file-turn", id: "f", timestamp: 3, changes: [], ignored: "x".repeat(8 * 1024 * 1024 + 100) }) + "\n");
    const notices = await reconciler.reconcileAll();
    const large = notices.find((notice) => notice.childId === LARGE);
    assert.equal(large?.status, "done");
    assert.equal(large?.message.endCause, "completed");

    await seedChild(ERROR, [
      { id: "huge", role: "tool", status: "complete", content: "x".repeat(8 * 1024 * 1024 + 100) },
      assistant("error", "error", true, "network disconnected"),
    ]);
    const rest = await reconciler.reconcileAll();
    const error = rest.find((notice) => notice.childId === ERROR);
    assert.equal(error?.status, "failed");
    assert.equal(error?.message.endCause, "network");
  });

  test("最后半截 JSON 行跳过，之前的正常 stop 仍可收尾", async () => {
    await seedChild(DONE, [assistant("complete", "stop")]);
    await appendFile(sessions.recordPath(DONE), '{"role":"assistant"');
    const notices = await reconciler.reconcileAll();
    assert.equal(notices.find((notice) => notice.childId === DONE)?.status, "done");
  });
});

describe("ChannelReconciler · 活事件", () => {
  test("显式模型失败不等 phase idle，广播失败原因；普通重试回复后活 phase 防重复关闭", async () => {
    await seedChild(LIVE, [assistant("complete", "toolUse", true)]);
    phases.set(LIVE, "turn");
    const notice = await reconciler.reconcileSession(LIVE, {
      interruptedCause: "incomplete",
      failureText: "fetch failed: network disconnected",
      force: true,
    });
    assert.equal(notice?.status, "failed");
    assert.equal(notice?.message.endCause, "network");
    assert.deepEqual(events.map((event) => event.type), ["message", "status"]);

    await channels.append(
      { parentId: PARENT, childId: LIVE },
      { ...task(LIVE), id: "retry-1", kind: "reply", author: "user", text: "接着做", createdAt: 2000 },
    );
    phases.set(LIVE, "turn");
    assert.equal(channelStatus(await channels.load({ parentId: PARENT, childId: LIVE })), "running");
    assert.equal(await reconciler.reconcileSession(LIVE, { interruptedCause: "incomplete" }), null);
    assert.equal((await channels.load({ parentId: PARENT, childId: LIVE })).at(-1)?.id, "retry-1");
  });

  test("普通 phase idle 读尾窗；读取期间用户重试开轮则不落旧终局", async () => {
    await seedChild(LIVE, [assistant("complete", "toolUse", true)]);
    const load = channels.load.bind(channels);
    let first = true;
    reconciler = new ChannelReconciler({
      sessions,
      channels: {
        load: async (key) => {
          const messages = await load(key);
          if (first) {
            first = false;
            phases.set(LIVE, "turn");
          }
          return messages;
        },
        append: channels.append.bind(channels),
      },
      phases,
      broadcast: (event) => events.push(event),
    });
    assert.equal(await reconciler.reconcileSession(LIVE, { interruptedCause: "incomplete" }), null);
    assert.equal((await load({ parentId: PARENT, childId: LIVE })).some((message) => message.author === "system"), false);
  });
});
