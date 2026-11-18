import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../shared/agent-ipc.ts";
import { selectTranscript } from "../../../shared/transcript-state.ts";
import { applyAgentEvent, createSessionStates } from "../features/chat/session-states.ts";
import { createPreviewApi } from "./fixture-api.ts";
import { isPreviewPath, parsePreviewOptions } from "./scenes.ts";

const NOW = Date.parse("2026-11-19T06:30:00.000Z");

function options(scene: "empty" | "typical" | "full" = "typical") {
  return { scene, theme: "light" as const, language: "en" as const, now: NOW };
}

test("preview URL 只认独立入口与稳定场景；未知参数安全退回 typical", () => {
  assert.equal(isPreviewPath("/preview.html"), true);
  assert.equal(isPreviewPath("/nested/preview.html"), true);
  assert.equal(isPreviewPath("/index.html"), false);
  assert.equal(isPreviewPath("/preview.html/extra"), false);
  assert.deepEqual(parsePreviewOptions("?scene=full&theme=black&lang=zh", NOW), {
    scene: "full",
    theme: "black",
    language: "zh",
    now: NOW,
  });
  assert.deepEqual(parsePreviewOptions("?scene=unknown&theme=unknown&lang=unknown", NOW), options());
});

test("typical：工作区档案打开真实 Boss 转录，子会话与通道等待态同源", async () => {
  const api = createPreviewApi(options());
  const profile = await api.agents.main("ws-research");
  assert.equal(profile.sessionId, "boss-research");
  const boss = await api.session.load(profile.sessionId);
  assert.equal(boss?.meta.role, "main");
  assert.ok((boss?.transcript.length ?? 0) >= 4);
  assert.ok(boss?.transcript.some((record) => record.role === "tool"));

  const sessions = await api.session.list();
  const children = sessions.filter((item) => item.parentId === boss?.meta.id);
  assert.deepEqual(children.map((item) => item.id).sort(), ["session-research-evidence", "session-research-map"]);
  const summaries = await api.channel.list(profile.sessionId);
  assert.equal(summaries.find((item) => item.childId === "session-research-map")?.status, "waiting");
  assert.equal(summaries.find((item) => item.childId === "session-research-evidence")?.status, "done");
  const ledger = await api.channel.load({ parentId: profile.sessionId, childId: "session-research-map" });
  assert.equal(ledger.at(-1)?.kind, "question");
  const child = await api.session.load("session-research-map");
  assert.ok(child?.transcript.some((record) => record.role === "assistant"));
});

test("empty 与缺对象边界：不伪造 provider、会话或更早历史", async () => {
  const api = createPreviewApi(options("empty"));
  assert.deepEqual(await api.provider.list(), []);
  assert.deepEqual(await api.workspace.list(), []);
  assert.deepEqual(await api.session.list(), []);
  assert.equal(await api.session.load("missing"), null);
  assert.deepEqual(await api.session.loadOlder("missing", "missing", 200), { records: [], hasMore: false });
  assert.ok((await api.usage.week()).every((day) => day.tokens === 0));
  assert.equal((await api.settings.get()).onboardingSeen, true);
});

test("设置补丁沿用生产合并语义，用量格钉日期会改变真实设置状态", async () => {
  const api = createPreviewApi(options());
  await api.settings.set({ drawer: { docked: ["task-sidebar"] }, experimentalFeatures: { "intent-system": true } });
  await api.settings.set({ drawer: { width: 360 }, usagePet: { pinnedDate: "2026-11-17" } });
  const next = await api.settings.get();
  assert.deepEqual(next.drawer.docked, ["task-sidebar"]);
  assert.equal(next.drawer.width, 360);
  assert.equal(next.experimentalFeatures?.["intent-system"], true);
  assert.equal(next.usagePet?.pinnedDate, "2026-11-17");
  assert.equal(next.theme, "light");
});

test("full：12 个工作区、近两千条 meta 与 40 件子会话，重复创建数据一致", async () => {
  const first = createPreviewApi(options("full"));
  const second = createPreviewApi(options("full"));
  assert.equal((await first.workspace.list()).length, 12);
  const list = await first.session.list();
  assert.equal(list.length, 1_973);
  assert.equal(list.filter((item) => item.parentId === "boss-research").length, 40);
  assert.deepEqual((await first.session.list()).slice(0, 8), (await second.session.list()).slice(0, 8));
  const archived = await first.session.load("archive-0001");
  assert.equal(archived?.transcript.length, 2);
});

test("发送走生产 agent 事件序列并留下确定性回答，不触碰模型或磁盘", async () => {
  const api = createPreviewApi(options());
  const events: AgentEvent[] = [];
  const off = api.agent.onEvent((event) => events.push(event));
  await api.agent.submit({
    sessionId: "task-sidebar",
    text: "Check the preview event path",
    cwd: "/fixtures/Home",
    workspaceId: null,
    resume: { piSessionFile: "/fixtures/pi/task-sidebar.jsonl" },
    providerId: "kimi-coding",
    modelId: "k3.1-pro",
    thinkingLevel: "high",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  off();
  assert.ok(events.some((event) => event.type === "phase" && event.phase === "turn"));
  assert.ok(events.some((event) => event.type === "phase" && event.phase === "idle"));
  assert.ok(events.some((event) => event.type === "progress" && event.progress.type === "item_started" && event.progress.item.role === "user"));
  let states = createSessionStates();
  for (const event of events) states = applyAgentEvent(states, event);
  const entry = states.get("task-sidebar");
  assert.equal(entry?.phase, "idle");
  assert.ok(entry !== undefined);
  const reduced = selectTranscript(entry.transcript);
  assert.deepEqual(reduced.map((item) => item.role), ["user", "assistant"]);
  assert.match(reduced[1]?.role === "assistant" && reduced[1].content[0]?.type === "text" ? reduced[1].content[0].text : "", /deterministic fixture response/);
  const detail = await api.session.load("task-sidebar");
  const last = detail?.transcript.at(-1);
  assert.equal(last?.role, "assistant");
  if (last?.role === "assistant") {
    assert.match(last.content[0]?.type === "text" ? last.content[0].text : "", /deterministic fixture response/);
  }
});

test("未接后端明确拒绝；所有场景数据只含 fixture 路径与无效域名", async () => {
  const api = createPreviewApi(options());
  await assert.rejects(api.browser.open(), /no host IPC, network, or filesystem action/);
  for (const item of await api.workspace.list()) assert.match(item.path, /^\/fixtures\//);
  for (const item of await api.session.list()) {
    assert.match(item.cwd, /^\/fixtures\//);
    assert.match(item.piSessionFile ?? "", /^\/fixtures\//);
  }
  for (const item of await api.provider.list()) assert.match(item.endpoint.baseUrl, /^https:\/\/fixture\.invalid\//);
});
