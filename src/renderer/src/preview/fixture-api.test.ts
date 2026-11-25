import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../shared/agent-ipc.ts";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { applyAgentEvent, createSessionStates } from "../features/chat/session-states.ts";
import { createPreviewApi } from "./fixture-api.ts";
import { FIXTURE_TEMPLATE_HASH, isPreviewPath, parsePreviewOptions } from "./scenes.ts";

const NOW = Date.parse("2026-11-19T06:30:00.000Z");

function options(scene: "empty" | "typical" | "full" = "typical") {
  return { scene, theme: "light" as const, language: "en" as const, now: NOW, onboarding: false };
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
    onboarding: false,
  });
  assert.deepEqual(parsePreviewOptions("?scene=typical&onboarding=1", NOW).onboarding, true);
  assert.deepEqual(parsePreviewOptions("?scene=unknown&theme=unknown&lang=unknown", NOW), options());
});

test("typical：工作区档案打开真实 Boss 转录，子会话与通道等待态同源", async () => {
  const api = createPreviewApi(options());
  // 主智能体还没进 main：Boss 会话在 main 上就是普通会话，按 id 直接打开。
  const profile = { sessionId: "boss-research" };
  const boss = await api.session.load(profile.sessionId);
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
    mode: "skip",
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

test("组1 文件树：根清单 / 列目录 / 四种预览态 / 大文本按行取窗并夹取", async () => {
  const api = createPreviewApi(options());
  const roots = await api.files.roots({ sessionId: "task-sidebar", workspaceId: null });
  assert.deepEqual(roots.map((root) => root.kind), ["session", "workspace"]);
  assert.ok(roots.every((root) => root.path.startsWith("/fixtures/")));
  const home = roots.find((root) => root.kind === "workspace");
  assert.ok(home !== undefined);
  const listed = await api.files.list({ sessionId: "task-sidebar", workspaceId: null, root: home.path, dir: home.path });
  assert.ok(listed.entries.some((entry) => entry.name === "todo.md" && entry.kind === "file"));

  const ws = await api.files.roots({ sessionId: "boss-research", workspaceId: "ws-research" });
  const wsRoot = ws.find((root) => root.kind === "workspace");
  assert.ok(wsRoot !== undefined);
  const text = await api.files.read({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: `${wsRoot.path}/src/app.ts` });
  assert.equal(text.kind, "text");
  const image = await api.files.read({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: `${wsRoot.path}/assets/logo.png` });
  assert.equal(image.kind, "image");
  const binary = await api.files.read({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: `${wsRoot.path}/assets/archive.zip` });
  assert.equal(binary.kind, "binary");

  const log = await api.files.read({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: `${wsRoot.path}/data/server.log` });
  assert.equal(log.kind, "large-text");
  const index = await api.files.lineIndex({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: `${wsRoot.path}/data/server.log`, requestId: "r1" });
  assert.equal(index.kind, "ok");
  if (index.kind !== "ok") throw new Error("unreachable");
  const first = await api.files.readLines({ indexId: index.indexId, startLine: 0, count: 10 });
  assert.equal(first.kind, "text");
  if (first.kind !== "text") throw new Error("unreachable");
  assert.equal(first.lines.length, 10);
  assert.match(first.lines[0] ?? "", /fixture log line 00001/);
  const clamped = await api.files.readLines({ indexId: index.indexId, startLine: index.totalLines + 100, count: 10_000 });
  assert.ok(clamped.kind === "text" && clamped.lines.length === 0 && clamped.startLine === index.totalLines);
  await assert.rejects(
    api.files.list({ sessionId: "boss-research", workspaceId: "ws-research", root: wsRoot.path, dir: "/outside" }),
    /outside root/,
  );
  await assert.rejects(api.files.reveal({ sessionId: null, workspaceId: null, root: wsRoot.path, dir: wsRoot.path }), /not connected/);
});

test("组1 文档与演示文稿：列表 / 读写比较交换 / 冲突如实返回 / 新建进虚拟树", async () => {
  const api = createPreviewApi(options());
  const list = (await api.docs.list({ sessionId: "boss-research", workspaceId: "ws-research" })).entries;
  assert.ok(list.some((entry) => entry.name === "meeting-notes.md" && entry.kind === "doc"));
  assert.ok(list.some((entry) => entry.name === "pitch.slides.json" && entry.kind === "slides"));
  const target = list.find((entry) => entry.name === "meeting-notes.md");
  assert.ok(target !== undefined);
  const read = await api.docs.read({ sessionId: "boss-research", workspaceId: "ws-research", path: target.path });
  const written = await api.docs.write({ sessionId: "boss-research", workspaceId: "ws-research", path: target.path, text: "# Edited in preview\n", expectedHash: read.hash });
  assert.equal(written.ok, true);
  const conflict = await api.docs.write({ sessionId: "boss-research", workspaceId: "ws-research", path: target.path, text: "stale", expectedHash: read.hash });
  assert.equal(conflict.ok, false);
  if (conflict.ok === false) assert.equal(conflict.reason, "conflict");
  const created = await api.docs.create({ sessionId: "boss-research", workspaceId: "ws-research", kind: "slides" });
  assert.match(created.path, /\.slides\.json$/u);
  const deck = JSON.parse(created.text) as { slides: unknown[] };
  assert.ok(Array.isArray(deck.slides) && deck.slides.length >= 1);
  await assert.rejects(api.docs.export({ sessionId: null, workspaceId: null, path: target.path, format: "pdf", html: "", pages: 1 }), /not connected/);
});

test("组2 审查与摘抄与记忆：四来源 / diff 边界态 / 摘抄幂等 / 记忆写操作", async () => {
  const api = createPreviewApi(options());
  const task = await api.review.list("task-sidebar", "task");
  assert.equal(task.kind, "ok");
  if (task.kind !== "ok") throw new Error("unreachable");
  assert.ok(task.entries.some((entry) => entry.binary));
  assert.ok(task.entries.some((entry) => entry.restored === true));
  assert.ok(task.entries.some((entry) => entry.symlink !== undefined));
  const appDiff = await api.review.diff("task-sidebar", "task", task.entries[0]?.path ?? "");
  assert.match(appDiff.diff ?? "", /@@[^@]*@@/);
  const tooLarge = await api.review.diff("task-sidebar", "task", `${task.cwd}/scratch/rewrite.md`);
  assert.equal(tooLarge.tooLarge?.exceeded, "lines");
  const restored = await api.review.diff("task-sidebar", "task", `${task.cwd}/scratch/notes.md`);
  assert.equal(restored.restored, true);
  const unstaged = await api.review.list("task-sidebar", "unstaged");
  assert.ok(unstaged.kind === "ok" && unstaged.entries.some((entry) => entry.lineCountUnknown));
  const unknown = await api.review.diff("task-sidebar", "task", `${task.cwd}/nope.ts`);
  assert.equal(unknown.error?.reason, "failed");

  const excerptList = await api.excerpt.list();
  assert.ok(excerptList.items.length >= 3);
  const source = excerptList.items[0];
  assert.ok(source !== undefined);
  const again = await api.excerpt.add({ sessionId: source.excerpt.sessionId, turn: source.excerpt.turn, role: source.excerpt.role, text: source.excerpt.text });
  assert.equal(again.duplicate, true);
  const fresh = await api.excerpt.add({ sessionId: "task-sidebar", turn: 9, role: "user", text: "A new fixture excerpt." });
  assert.equal(fresh.duplicate, false);
  const removed = await api.excerpt.remove({ id: fresh.excerpt.id });
  assert.equal(removed.removed, true);
  assert.equal((await api.excerpt.remove({ id: fresh.excerpt.id })).removed, false);

  const scopes = await api.memory.scopes();
  assert.ok(scopes.some((scope) => scope.kind === "user"));
  const entries = await api.memory.entries({ token: "all" });
  assert.ok(entries.items.length >= 4);
  const session = await api.memory.session("task-sidebar");
  assert.ok(session.turns.length >= 1);
  const muted = await api.memory.mutate({ op: "setStatus", token: "user", entryId: "mem-fixture-new", status: "muted" });
  assert.equal(muted.ok, true);
  const missing = await api.memory.mutate({ op: "edit", token: "user", entryId: "nope", text: "x" });
  assert.equal(missing.ok, false);
});

test("组2 终端与自动化：终端走生产 spawn-failure 文案；自动化状态转移可点、运行明确拒绝", async () => {
  const api = createPreviewApi(options());
  assert.deepEqual(await api.terminal.list(), []);
  await assert.rejects(api.terminal.create({ terminalId: "fixture-terminal-1", cols: 80, rows: 24 }), /no PTY/);
  await api.terminal.kill("fixture-terminal-1");

  const automations = await api.automation.list();
  assert.equal(automations.length, 3);
  const digest = automations.find((item) => item.id === "auto-fixture-digest");
  assert.ok(digest !== undefined && digest.plugin?.name === "reading" && digest.runs.some((run) => run.status === "skipped"));
  const paused = await api.automation.act("auto-fixture-digest", { type: "pause" });
  assert.equal(paused.ok, true);
  if (paused.ok) assert.equal(paused.automation?.status, "paused");
  const runNow = await api.automation.act("auto-fixture-ci", { type: "runNow" });
  assert.equal(runNow.ok, false);
  const restart = await api.automation.act("auto-fixture-cleanup", { type: "restart" });
  assert.equal(restart.ok, true);
  if (restart.ok) assert.equal(restart.automation?.status, "active");
  const deleted = await api.automation.act("auto-fixture-cleanup", { type: "delete" });
  assert.equal(deleted.ok, true);
  assert.equal((await api.automation.list()).length, 2);
  const create = await api.automation.create({ workspaceId: null, title: "x", prompt: "y", schedule: { kind: "once", at: Date.now() + 60_000 }, mode: "skip" });
  assert.equal(create.ok, false);
});

test("组3 插件与看板与专注：已装列表 / 范围切换 / 草稿 / 周看板平移 / 专注改动与小结", async () => {
  const api = createPreviewApi(options());
  const listed = await api.plugin.list();
  assert.equal(listed.plugins.length, 4);
  assert.ok(listed.plugins.some((item) => item.install?.source.kind === "builtin"));
  await api.plugin.setScope("plugin:session-digest", { kind: "global" });
  const after = (await api.plugin.list()).plugins.find((item) => item.id === "plugin:session-digest");
  assert.deepEqual(after?.scope, { kind: "global" });
  const drafts = await api.plugin.drafts();
  assert.equal(drafts.length, 1);
  const draft = await api.plugin.draftLoad({ path: drafts[0]?.path ?? "", workspaceId: "ws-research", stamp: null });
  assert.equal(draft.kind, "ready");
  const file = await api.plugin.skillFile("reading", "paper-explainer");
  assert.match(file.content, /Fixture skill body/);
  const action = await api.plugin.panelAction({ name: "reading", action: "open", payload: null });
  assert.equal(action.ok, false);
  const skillList = await api.skill.list();
  assert.ok(skillList.some((item) => item.slug === "commit-notes"));
  const mcp = await api.mcp.list();
  assert.equal(mcp.servers.length, 1);
  await api.mcp.setDisabled("fetch-server", true);
  assert.equal((await api.mcp.list()).servers[0]?.disabled, true);

  const week = await api.board.week({ weekStart: Date.now() });
  assert.ok(week !== null);
  if (week === null) throw new Error("unreachable");
  assert.equal(week.days.length, 7);
  const withCards = week.days.flatMap((day) => day.items).find((item) => item.cards.length > 0);
  assert.ok(withCards !== undefined);
  const nextWeek = await api.board.week({ weekStart: week.weekStart + 7 * 24 * 60 * 60 * 1000 });
  assert.ok(nextWeek !== null && nextWeek.days.flatMap((day) => day.items).length >= 1);
  const frame = await api.board.frame({ hash: "b".repeat(64) });
  assert.equal(frame, null);
  const frameOk = await api.board.frame({ hash: FIXTURE_TEMPLATE_HASH });
  assert.deepEqual(frameOk, { frameUrl: "/preview-board-card.html" });

  const changes = await api.focus.changes("ws-research");
  assert.equal(changes.kind, "ok");
  if (changes.kind !== "ok") throw new Error("unreachable");
  assert.ok(changes.entries.some((entry) => entry.kind === "U" && entry.lineCountUnknown));
  const summary = await api.focus.summarize({ startedAt: Date.now() - 3600_000, until: Date.now(), workspaceId: "ws-research" });
  assert.equal(summary.kind, "ok");
  if (summary.kind !== "ok") throw new Error("unreachable");
  assert.match(summary.modelLabel, /preview-fixture/);
  await api.focus.notifyDone({ title: "t", body: "b" });
});

test("组4 外部来源与语音与意图与引导：八来源可见 / 凭证掩码 / 测试如实失败 / intent 连不上", async () => {
  const api = createPreviewApi(options());
  const selection = await api.voice.dictationSelection();
  assert.equal(selection.configured, false);
  await api.voice.doubaoSave({ appId: "app-fixture", resourceId: "res-fixture", accessToken: "secret-token-1234" });
  const saved = await api.voice.doubaoGet();
  assert.equal(saved.tokenMasked, "fix…1234");
  assert.equal((await api.voice.dictationSelection()).configured, true);
  const testResult = await api.voice.doubaoTest({ appId: "app-fixture", resourceId: "res-fixture" });
  assert.deepEqual(testResult, { ok: false, reason: "network", detail: "Preview fixture: no network request was made." });
  await assert.rejects(api.voice.dictationStart("task-sidebar"), /microphone/);

  assert.equal(await api.intent.health(), null);
  assert.equal(await api.intent.edges("task-sidebar", "t1"), null);

  const guided = createPreviewApi({ ...options(), onboarding: true });
  assert.equal((await guided.settings.get()).onboardingSeen, false);
  const plain = createPreviewApi(options());
  assert.equal((await plain.settings.get()).onboardingSeen, true);
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
