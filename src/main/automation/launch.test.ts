import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubmitAgentInput } from "../../shared/agent-ipc.ts";
import { parseAutomationHeader, type Automation } from "../../shared/automation.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/settings.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { makeAutomation } from "./fixtures.ts";
import {
  SessionGoneError,
  clipText,
  composeAutomationPrompt,
  deliverAutomationRun,
  launchAutomationRun,
  resolveAutomationModel,
  type LaunchDeps,
} from "./launch.ts";
import { SessionStore } from "../session/store.ts";

const AT = new Date(2026, 9, 31, 1, 45).getTime();

function provider(id: string, modelIds: string[]): ProviderDto {
  return {
    id,
    displayName: id,
    endpoint: { baseUrl: "https://x.example", api: "openai-completions" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

describe("resolveAutomationModel", () => {
  const providers = [provider("zai", ["glm-5.3", "glm-5.3-flash"]), provider("kimi", ["k3"])];
  const base = { automation: {}, providers };

  test("自己指名的最优先；思考档用自己的，没有就取该模型的默认档", () => {
    const named = resolveAutomationModel({
      ...base,
      automation: { providerId: "kimi", modelId: "k3", thinkingLevel: "high" },
      settings: { subSessionModel: { providerId: "zai", modelId: "glm-5.3" } },
    });
    assert.deepEqual(named, { ok: true, providerId: "kimi", modelId: "k3", thinkingLevel: "high" });
    const noLevel = resolveAutomationModel({
      ...base,
      automation: { providerId: "kimi", modelId: "k3" },
      settings: {},
    });
    assert.equal(noLevel.ok && noLevel.providerId, "kimi");
  });

  test("指名的模型已被删：报错并告诉怎么办，不悄悄换", () => {
    const result = resolveAutomationModel({ ...base, automation: { providerId: "kimi", modelId: "gone" }, settings: {} });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /no longer available/);
    const noProvider = resolveAutomationModel({ ...base, automation: { providerId: "x", modelId: "k3" }, settings: {} });
    assert.equal(noProvider.ok, false);
  });

  test("没指名：设置里的子会话默认模型（带它的思考档）", () => {
    const result = resolveAutomationModel({
      ...base,
      settings: {
        subSessionModel: { providerId: "zai", modelId: "glm-5.3-flash" },
        subSessionThinking: "low",
        lastUsed: { providerId: "kimi", modelId: "k3" },
      },
    });
    assert.deepEqual(result, { ok: true, providerId: "zai", modelId: "glm-5.3-flash", thinkingLevel: "low" });
  });

  test("再没有：用应用上次使用的模型（lastUsed，不是哪条手动会话的设置）", () => {
    const result = resolveAutomationModel({ ...base, settings: { lastUsed: { providerId: "kimi", modelId: "k3" } } });
    assert.equal(result.ok && result.providerId, "kimi");
    assert.equal(result.ok && result.modelId, "k3");
  });

  test("设置里的默认模型 provider 已删：退回 lastUsed；都没有：报错而不是猜第一个可用模型", () => {
    const fallback = resolveAutomationModel({
      ...base,
      settings: { subSessionModel: { providerId: "deleted", modelId: "m" }, lastUsed: { providerId: "kimi", modelId: "k3" } },
    });
    assert.equal(fallback.ok && fallback.providerId, "kimi");
    const none = resolveAutomationModel({ ...base, settings: {} });
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.error, /No model is available/);
    const staleLast = resolveAutomationModel({ ...base, settings: { lastUsed: { providerId: "deleted", modelId: "m" } } });
    assert.equal(staleLast.ok, false);
  });
});

describe("composeAutomationPrompt / clipText", () => {
  test("首行是抬头，且 parse 得回来；有上限写 n/max", () => {
    const text = composeAutomationPrompt({ title: "论文追踪", number: 3, max: 12, at: AT, prompt: "  看新论文  " });
    assert.ok(text.startsWith("[定时任务「论文追踪」第 3/12 次 · 10-31 01:45]\n\n看新论文"));
    assert.equal(parseAutomationHeader(text)?.body, "看新论文");
    assert.equal(parseAutomationHeader(text)?.max, 12);
  });

  test("上次结果附在后面，截到约 2KB（按字符）；没有或空白就不附", () => {
    const withLast = composeAutomationPrompt({ title: "t", number: 2, at: AT, prompt: "p", lastResult: "字".repeat(3000) });
    const tail = withLast.slice(withLast.indexOf("上次结果"));
    assert.ok(tail.includes("字".repeat(2000)));
    assert.ok(!tail.includes("字".repeat(2001)));
    assert.ok(tail.endsWith("…"));
    assert.ok(!composeAutomationPrompt({ title: "t", number: 2, at: AT, prompt: "p" }).includes("上次结果"));
    assert.ok(!composeAutomationPrompt({ title: "t", number: 2, at: AT, prompt: "p", lastResult: "  " }).includes("上次结果"));
  });

  test("clipText 按码点切，不劈开代理对", () => {
    assert.equal(clipText("😀😀😀", 2), "😀😀…");
    assert.equal(clipText("abc", 3), "abc");
  });
});

/* ---------- 开会话 / 送会话（真 SessionStore + 假 submitTurn） ---------- */

let dir = "";
let sessions: SessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-automation-launch-"));
  sessions = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const workspace: Workspace = { id: "ws1", name: "orbita", path: "/repo/orbita", createdAt: 1, attachedDirs: [] };

function deps(overrides: { submitTurn?: (input: SubmitAgentInput) => Promise<void>; settings?: AppSettings; workspaces?: Workspace[] } = {}) {
  const submitted: SubmitAgentInput[] = [];
  const launchDeps: LaunchDeps = {
    sessions,
    providers: { list: async () => [provider("zai", ["glm-5.3"])] },
    settings: { read: async () => overrides.settings ?? { ...DEFAULT_SETTINGS, subSessionModel: { providerId: "zai", modelId: "glm-5.3" } } },
    workspaces: { list: async () => overrides.workspaces ?? [workspace], defaultPath: () => "/orbita/Home" },
    submitTurn:
      overrides.submitTurn ??
      (async (input) => {
        submitted.push(input);
      }),
  };
  return { launchDeps, submitted };
}

describe("launchAutomationRun（new_session）", () => {
  const automation = (patch: Partial<Automation> = {}): Automation =>
    makeAutomation({ id: "au1", title: "开源 CLI 速览", mode: "skip", maxRuns: 12, ...patch, target: { kind: "new_session", workspaceId: "ws1" } });

  test("先建带 automationId / automationRun 的会话 meta，再开轮：cwd = 工作区路径、模型按设置解析、权限档用任务的", async () => {
    const { launchDeps, submitted } = deps();
    await launchAutomationRun(launchDeps, { automation: automation({ lastResult: "上周说了 A" }), sessionId: "11111111-1111-1111-1111-111111111111", number: 3, at: AT, trigger: "manual" });
    const meta = await sessions.readMeta("11111111-1111-1111-1111-111111111111");
    assert.ok(meta);
    assert.equal(meta.automationId, "au1");
    assert.deepEqual(meta.automationRun, { title: "开源 CLI 速览", number: 3, at: AT, trigger: "manual" });
    assert.equal(meta.title, "开源 CLI 速览 · 10-31 01:45");
    assert.equal(meta.titleSource, "user");
    assert.equal(meta.cwd, "/repo/orbita");
    assert.equal(meta.workspaceId, "ws1");
    assert.equal(meta.mode, "skip");
    assert.equal(meta.parentId, undefined);
    assert.equal(submitted.length, 1);
    const input = submitted[0];
    assert.equal(input?.resume, null);
    assert.equal(input?.cwd, "/repo/orbita");
    assert.equal(input?.mode, "skip");
    assert.equal(input?.modelId, "glm-5.3");
    assert.ok(input?.text.startsWith("[定时任务「开源 CLI 速览」第 3/12 次 · 10-31 01:45]"));
    assert.ok(input?.text.includes("上周说了 A"));
  });

  test("Home 任务落在 Home 目录；工作区被删：抛错，且不留下会话", async () => {
    const home = deps();
    await launchAutomationRun(home.launchDeps, {
      automation: makeAutomation({ id: "h", target: { kind: "new_session", workspaceId: null } }),
      sessionId: "22222222-2222-2222-2222-222222222222",
      number: 1,
      at: AT,
      trigger: "schedule",
    });
    assert.equal(home.submitted[0]?.cwd, "/orbita/Home");
    const gone = deps({ workspaces: [] });
    await assert.rejects(
      launchAutomationRun(gone.launchDeps, { automation: automation(), sessionId: "33333333-3333-3333-3333-333333333333", number: 1, at: AT, trigger: "schedule" }),
      /no longer exists/,
    );
    assert.equal(await sessions.readMeta("33333333-3333-3333-3333-333333333333"), null);
  });

  test("没有可用模型：抛错、不建会话；开轮失败：回滚刚建的会话", async () => {
    const noModel = deps({ settings: DEFAULT_SETTINGS });
    await assert.rejects(
      launchAutomationRun(noModel.launchDeps, { automation: automation(), sessionId: "44444444-4444-4444-4444-444444444444", number: 1, at: AT, trigger: "schedule" }),
      /No model is available/,
    );
    assert.equal(await sessions.readMeta("44444444-4444-4444-4444-444444444444"), null);
    const failing = deps({
      submitTurn: async () => {
        throw new Error("boot failed");
      },
    });
    await assert.rejects(
      launchAutomationRun(failing.launchDeps, { automation: automation(), sessionId: "55555555-5555-5555-5555-555555555555", number: 1, at: AT, trigger: "schedule" }),
      /boot failed/,
    );
    assert.equal(await sessions.readMeta("55555555-5555-5555-5555-555555555555"), null, "失败的触发不留一条打不开的会话");
  });
});

describe("deliverAutomationRun（this_session）", () => {
  const SID = "66666666-6666-6666-6666-666666666666";
  const bound = (patch: Partial<Automation> = {}): Automation =>
    makeAutomation({ id: "t", title: "等 vLLM", maxRuns: 12, ...patch, target: { kind: "this_session", sessionId: SID, workspaceId: "ws1" } });
  const sessionMeta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
    id: SID,
    title: "跑评测",
    titleSource: "user",
    cwd: "/repo/orbita/sub",
    workspaceId: "ws1",
    providerId: "zai",
    modelId: "glm-5.3-flash",
    mode: "manual",
    thinkingLevel: "high",
    piSessionFile: "/pi/sessions/abc.jsonl",
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  });

  test("用会话自己 meta 里的 piSessionFile / 模型 / 档位 / 思考 / cwd resume 一轮，文本是抬头 + 指令（不附上次结果）", async () => {
    await sessions.ensureSession(sessionMeta());
    const { launchDeps, submitted } = deps();
    await deliverAutomationRun(launchDeps, { automation: bound({ prompt: "看日志", lastResult: "不该出现" }), number: 3, at: AT });
    assert.equal(submitted.length, 1);
    const input = submitted[0];
    assert.equal(input?.sessionId, SID);
    assert.deepEqual(input?.resume, { piSessionFile: "/pi/sessions/abc.jsonl" });
    assert.equal(input?.cwd, "/repo/orbita/sub");
    assert.equal(input?.workspaceId, "ws1");
    assert.equal(input?.providerId, "zai");
    assert.equal(input?.modelId, "glm-5.3-flash");
    assert.equal(input?.mode, "manual", "不替用户改档：manual 就是 manual");
    assert.equal(input?.thinkingLevel, "high");
    assert.equal(input?.text, "[定时任务「等 vLLM」第 3/12 次 · 10-31 01:45]\n\n看日志");
  });

  test("会话被删：SessionGoneError；没有 pi 本子（续不了）：普通错误；都不开轮", async () => {
    const { launchDeps, submitted } = deps();
    await assert.rejects(deliverAutomationRun(launchDeps, { automation: bound(), number: 1, at: AT }), SessionGoneError);
    await sessions.ensureSession(sessionMeta({ piSessionFile: null }));
    await assert.rejects(deliverAutomationRun(launchDeps, { automation: bound(), number: 1, at: AT }), /cannot be continued/);
    assert.equal(submitted.length, 0);
  });

  test("不是 this_session 的任务送进来：直接抛错", async () => {
    const { launchDeps } = deps();
    await assert.rejects(
      deliverAutomationRun(launchDeps, { automation: makeAutomation({ id: "x" }), number: 1, at: AT }),
      /not bound to a session/,
    );
  });
});
