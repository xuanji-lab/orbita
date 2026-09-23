import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import type { AgentEvent, ChannelEvent, SubmitAgentInput } from "../../shared/agent-ipc.ts";
import { parseChannelPrompt, type ChannelDelivery } from "../../shared/channel.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/settings.ts";
import {
  applyChannelSend,
  applyDelegate,
  applySpeak,
  resolveSubSessionModel,
  type ChannelDeps,
} from "./requests.ts";
import { ChannelStore } from "./store.ts";
import { SessionStore } from "../session/store.ts";

const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHILD = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const baseMeta = (patch: Partial<SessionMeta> & { id: string }): SessionMeta => ({
  title: "",
  titleSource: "derived",
  stats: null,
  cwd: "/repo",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function provider(id: string, modelIds: string[]): ProviderDto {
  return {
    id,
    displayName: id,
    endpoint: { baseUrl: "https://x.example", api: "openai-completions" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

let dir = "";
let sessions: SessionStore;
let channels: ChannelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-channel-requests-"));
  channels = new ChannelStore(join(dir, "channels"));
  sessions = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"), channels);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 假 deps：submitTurn / steer / broadcast 只记调用，不做真事。 */
function fakeDeps(overrides: {
  providers?: ProviderDto[];
  settings?: AppSettings;
  submitTurn?: (input: SubmitAgentInput) => Promise<void>;
  phases?: Map<string, SessionPhase>;
} = {}): {
  deps: ChannelDeps;
  submitCalls: SubmitAgentInput[];
  steerCalls: { sessionId: string; text: string; delivery: ChannelDelivery }[];
  broadcastCalls: ChannelEvent[];
} {
  const submitCalls: SubmitAgentInput[] = [];
  const steerCalls: { sessionId: string; text: string; delivery: ChannelDelivery }[] = [];
  const broadcastCalls: ChannelEvent[] = [];
  const deps: ChannelDeps = {
    sessions,
    channels,
    providers: { list: async () => overrides.providers ?? [] },
    settings: { read: async () => overrides.settings ?? DEFAULT_SETTINGS },
    submitTurn:
      overrides.submitTurn ??
      (async (input) => {
        submitCalls.push(input);
      }),
    steer: (sessionId, text, delivery) => {
      steerCalls.push({ sessionId, text, delivery });
    },
    phases: overrides.phases ?? new Map(),
    broadcast: (event) => {
      broadcastCalls.push(event);
    },
  };
  return { deps, submitCalls, steerCalls, broadcastCalls };
}

describe("resolveSubSessionModel", () => {
  const parent = { providerId: "zai", modelId: "glm-5.3" };

  test("requested 命中父的 provider——优先用父那家", () => {
    const providers = [provider("zai", ["glm-5.3", "glm-5.3-flash"]), provider("other", ["special"])];
    assert.deepEqual(
      resolveSubSessionModel({ requested: "glm-5.3-flash", setting: undefined, parent, providers }),
      { ok: true, providerId: "zai", modelId: "glm-5.3-flash", source: "requested" },
    );
  });

  test("requested 命中别家——取第一个声明了它的 provider", () => {
    const providers = [provider("zai", ["glm-5.3"]), provider("other", ["special"])];
    assert.deepEqual(
      resolveSubSessionModel({ requested: "special", setting: undefined, parent, providers }),
      { ok: true, providerId: "other", modelId: "special", source: "requested" },
    );
  });

  test("requested 哪家都没有——报错，附全部可用模型 id（去重）", () => {
    const providers = [provider("zai", ["glm-5.3", "glm-5.3"]), provider("other", ["special"])];
    const result = resolveSubSessionModel({ requested: "nope", setting: undefined, parent, providers });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.includes("glm-5.3"), true);
    assert.equal(!result.ok && result.error.includes("special"), true);
    // 去重：glm-5.3 在返回的可用列表里只出现一次
    assert.equal(
      !result.ok && (result.error.match(/glm-5\.3/g) ?? []).length === 1,
      true,
    );
  });

  test("没有 requested，setting 有值且 provider 还在——用 setting", () => {
    const providers = [provider("zai", ["glm-5.3"]), provider("fast", ["turbo"])];
    assert.deepEqual(
      resolveSubSessionModel({
        requested: undefined,
        setting: { providerId: "fast", modelId: "turbo" },
        parent,
        providers,
      }),
      { ok: true, providerId: "fast", modelId: "turbo", source: "setting" },
    );
  });

  test("setting 的 provider 已删——退回同父（易耗品处理），source 是 parent 不是 setting", () => {
    const providers = [provider("zai", ["glm-5.3"])];
    assert.deepEqual(
      resolveSubSessionModel({
        requested: undefined,
        setting: { providerId: "gone", modelId: "turbo" },
        parent,
        providers,
      }),
      { ok: true, providerId: "zai", modelId: "glm-5.3", source: "parent" },
    );
  });

  test("requested 与 setting 都没有——同父", () => {
    assert.deepEqual(
      resolveSubSessionModel({ requested: undefined, setting: undefined, parent, providers: [] }),
      { ok: true, providerId: "zai", modelId: "glm-5.3", source: "parent" },
    );
  });
});

function delegateEvent(
  overrides: Partial<Extract<AgentEvent, { type: "delegateRequest" }>> = {},
): Extract<AgentEvent, { type: "delegateRequest" }> {
  return {
    type: "delegateRequest",
    requestId: "r1",
    sessionId: PARENT,
    title: "调研分支",
    task: "去把这个方案的可行性调研清楚",
    ...overrides,
  };
}

describe("applyDelegate", () => {
  test("成功：子 meta 字段正确、通道仅一条 task、text 是可解析的信封、card.workbench 对", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT, cwd: "/work/proj", workspaceId: "ws1", mode: "skip" }));
    const { deps, submitCalls } = fakeDeps();

    const outcome = await applyDelegate(deps, delegateEvent());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const child = await sessions.load(outcome.childId);
    assert.equal(child?.meta.parentId, PARENT);
    assert.equal(child?.meta.titleSource, "user");
    assert.equal(child?.meta.title, "调研分支");
    assert.equal(child?.meta.cwd, "/work/proj");
    assert.equal(child?.meta.workspaceId, "ws1");
    assert.equal(child?.meta.mode, "skip");

    const channelMessages = await channels.load({ parentId: PARENT, childId: outcome.childId });
    assert.equal(channelMessages.length, 1);
    assert.equal(channelMessages[0]?.kind, "task");

    assert.equal(submitCalls.length, 1);
    const parsed = parseChannelPrompt(submitCalls[0]?.text ?? "");
    assert.deepEqual(parsed && { from: parsed.from, kind: parsed.kind, peerId: parsed.peerId }, {
      from: "parent",
      kind: "task",
      peerId: PARENT,
    });

    assert.equal(outcome.card.workbench, sessions.workbenchPath(outcome.childId));
  });

  test("思考档跟着模型走：delegate 显式档 > 模型来自哪（requested/setting → 该模型默认档；parent → 父的档）", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT, thinkingLevel: "low" }));
    // zai 声明 glm-5.3-flash：白名单里它的默认思考档是 max（known-providers.ts）
    const providers = [provider("zai", ["glm-5.3", "glm-5.3-flash"]), provider("fast", ["turbo"])];

    // 三者都缺席：同父的档
    const { deps: depsParentOnly } = fakeDeps({ providers });
    const parentOnly = await applyDelegate(depsParentOnly, delegateEvent());
    assert.equal(parentOnly.ok && parentOnly.card.thinkingLevel, "low");

    // delegate 参数指定了模型、没给档：落这个模型的默认档——不是父的档，父可能
    // 跑着完全不同的型号
    const { deps: depsRequested } = fakeDeps({ providers });
    const requested = await applyDelegate(depsRequested, delegateEvent({ modelId: "glm-5.3-flash" }));
    assert.equal(requested.ok && requested.card.modelId, "glm-5.3-flash");
    assert.equal(requested.ok && requested.card.thinkingLevel, "max");

    // 设置指定了子会话模型、没给档（settings.subSessionThinking 缺席）：落这个
    // 模型的默认档
    const { deps: depsSettingNoThinking } = fakeDeps({
      providers,
      settings: { ...DEFAULT_SETTINGS, subSessionModel: { providerId: "zai", modelId: "glm-5.3-flash" } },
    });
    const settingNoThinking = await applyDelegate(depsSettingNoThinking, delegateEvent());
    assert.equal(settingNoThinking.ok && settingNoThinking.card.thinkingLevel, "max");

    // 设置指定了子会话模型、也给了子会话思考档：用设置里的档，不是模型默认档
    const { deps: depsSettingWithThinking } = fakeDeps({
      providers,
      settings: {
        ...DEFAULT_SETTINGS,
        subSessionModel: { providerId: "fast", modelId: "turbo" },
        subSessionThinking: "high",
      },
    });
    const settingWithThinking = await applyDelegate(depsSettingWithThinking, delegateEvent());
    assert.equal(settingWithThinking.ok && settingWithThinking.card.thinkingLevel, "high");

    // delegate 显式档最优先：即使模型来自设置且设置也给了档，事件的档压过一切
    const { deps: depsWithEvent } = fakeDeps({
      providers,
      settings: {
        ...DEFAULT_SETTINGS,
        subSessionModel: { providerId: "fast", modelId: "turbo" },
        subSessionThinking: "high",
      },
    });
    const withEvent = await applyDelegate(depsWithEvent, delegateEvent({ thinkingLevel: "max" }));
    assert.equal(withEvent.ok && withEvent.card.thinkingLevel, "max");
  });

  test("子会话再派出被拒——契约允许多层，今天不开这个口", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT, parentId: OTHER }));
    await sessions.ensureSession(baseMeta({ id: OTHER }));
    const { deps } = fakeDeps();
    const outcome = await applyDelegate(deps, delegateEvent({ sessionId: PARENT }));
    assert.equal(outcome.ok, false);
  });

  test("父会话不存在 / 标题或任务为空 / 思考档非法 都拒", async () => {
    const { deps } = fakeDeps();
    assert.equal((await applyDelegate(deps, delegateEvent({ sessionId: OTHER }))).ok, false);

    await sessions.ensureSession(baseMeta({ id: PARENT }));
    assert.equal((await applyDelegate(deps, delegateEvent({ title: "   " }))).ok, false);
    assert.equal((await applyDelegate(deps, delegateEvent({ task: "" }))).ok, false);
    assert.equal(
      (await applyDelegate(deps, delegateEvent({ thinkingLevel: "turbo" as never }))).ok,
      false,
    );
  });

  test("submitTurn 抛错 → ok:false，且子 meta 与通道都不在了（回滚）", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    const { deps } = fakeDeps({
      submitTurn: async () => {
        throw new Error("runtime 挂了");
      },
    });

    const outcome = await applyDelegate(deps, delegateEvent());
    assert.equal(outcome.ok, false);
    // 没有 childId 可查（失败回执不带），改按「父名下没有任何子/通道」核验回滚
    assert.deepEqual(await sessions.list(), [(await sessions.load(PARENT))?.meta]);
    assert.deepEqual(await channels.listForParent(PARENT, async () => ""), []);
  });
});

function channelSendEvent(
  overrides: Partial<Extract<AgentEvent, { type: "channelSendRequest" }>> = {},
): Extract<AgentEvent, { type: "channelSendRequest" }> {
  return {
    type: "channelSendRequest",
    requestId: "r1",
    sessionId: CHILD,
    to: "parent",
    kind: "progress",
    text: "跑了一半",
    ...overrides,
  };
}

describe("applyChannelSend", () => {
  test("子→父四种 kind 通过，不调 submitTurn/steer", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const { deps, submitCalls, steerCalls } = fakeDeps();
    for (const kind of ["question", "progress", "done", "failed"] as const) {
      const outcome = await applyChannelSend(deps, channelSendEvent({ kind, requestId: kind }));
      assert.equal(outcome.ok, true);
    }
    assert.equal(submitCalls.length, 0);
    assert.equal(steerCalls.length, 0);
  });

  test("子→父发 reply 被拒——reply 只属于父→子方向", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const { deps } = fakeDeps();
    const outcome = await applyChannelSend(deps, channelSendEvent({ kind: "reply" }));
    assert.equal(outcome.ok, false);
  });

  test("根会话（没有父）发 to parent 被拒", async () => {
    await sessions.ensureSession(baseMeta({ id: CHILD }));
    const { deps } = fakeDeps();
    const outcome = await applyChannelSend(deps, channelSendEvent({ sessionId: CHILD }));
    assert.equal(outcome.ok, false);
  });

  test("父→子 reply 通过；父→子 task 被拒（task 只由 delegate 产生）", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const { deps } = fakeDeps();
    const ok = await applyChannelSend(
      deps,
      channelSendEvent({ sessionId: PARENT, to: { childId: CHILD }, kind: "reply", text: "继续" }),
    );
    assert.equal(ok.ok, true);
    const rejected = await applyChannelSend(
      deps,
      channelSendEvent({ sessionId: PARENT, to: { childId: CHILD }, kind: "task", text: "新任务" }),
    );
    assert.equal(rejected.ok, false);
  });

  test("给不是自己子的会话发被拒", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: OTHER })); // 不是 PARENT 的子
    const { deps } = fakeDeps();
    const outcome = await applyChannelSend(
      deps,
      channelSendEvent({ sessionId: PARENT, to: { childId: OTHER }, kind: "reply", text: "x" }),
    );
    assert.equal(outcome.ok, false);
  });

  test("子空闲（phase 不在 map 里）→ submitTurn，resume 用子的 piSessionFile", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT, piSessionFile: "pi/child.jsonl" }));
    const { deps, submitCalls, steerCalls } = fakeDeps();
    const outcome = await applyChannelSend(
      deps,
      channelSendEvent({ sessionId: PARENT, to: { childId: CHILD }, kind: "reply", text: "继续" }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(steerCalls.length, 0);
    assert.equal(submitCalls.length, 1);
    assert.deepEqual(submitCalls[0]?.resume, { piSessionFile: "pi/child.jsonl" });
  });

  test("子 phase 为 turn → steer 带 delivery，不开轮", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const phases = new Map<string, SessionPhase>([[CHILD, "turn"]]);
    const { deps, submitCalls, steerCalls } = fakeDeps({ phases });
    const outcome = await applyChannelSend(
      deps,
      channelSendEvent({ sessionId: PARENT, to: { childId: CHILD }, kind: "reply", text: "先停一下", delivery: "followUp" }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(submitCalls.length, 0);
    assert.equal(steerCalls.length, 1);
    assert.equal(steerCalls[0]?.sessionId, CHILD);
    assert.equal(steerCalls[0]?.delivery, "followUp");
  });

  test("broadcast 收到 message 与 status", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const { deps, broadcastCalls } = fakeDeps();
    await applyChannelSend(deps, channelSendEvent());
    assert.equal(broadcastCalls.some((e) => e.type === "message"), true);
    assert.equal(broadcastCalls.some((e) => e.type === "status"), true);
  });
});

describe("applySpeak", () => {
  test("author user，不写父侧标记（不变量：标记顶替 pi 本子里的 user 消息，代父发言没有对应的接收方），投递发生", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    const { deps, submitCalls } = fakeDeps();

    const message = await applySpeak(deps, { parentId: PARENT, childId: CHILD, text: "帮我问问", delivery: "steer" });
    assert.equal(message.author, "user");
    assert.equal(message.from, "parent");
    assert.equal(message.kind, "reply");

    const parentDetail = await sessions.load(PARENT);
    const mark = parentDetail?.transcript.find(
      (record) => record.role === "channel-mark" && record.messageId === message.id,
    );
    assert.equal(mark, undefined);

    // 子空闲：投递退化为普通开轮
    assert.equal(submitCalls.length, 1);
  });

  test("校验失败抛错：父不存在 / 不是自己的子 / 空文本", async () => {
    await sessions.ensureSession(baseMeta({ id: PARENT }));
    await sessions.ensureSession(baseMeta({ id: OTHER }));
    const { deps } = fakeDeps();
    await assert.rejects(() => applySpeak(deps, { parentId: OTHER + "x", childId: CHILD, text: "x", delivery: "steer" }));
    await assert.rejects(() => applySpeak(deps, { parentId: PARENT, childId: OTHER, text: "x", delivery: "steer" }));
    await sessions.ensureSession(baseMeta({ id: CHILD, parentId: PARENT }));
    await assert.rejects(() => applySpeak(deps, { parentId: PARENT, childId: CHILD, text: "   ", delivery: "steer" }));
  });
});
