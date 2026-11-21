import type { OrbitaApi } from "../../../preload/index.ts";
import type { AgentEvent, AgentStats, BuiltinProvider, ChannelEvent } from "../../../shared/agent-ipc.ts";
import { summarizeChannel, type ChannelKey, type ChannelMessage } from "../../../shared/channel.ts";
import { groupUnassignedModels, planAssignments } from "../../../shared/model-assign.ts";
import { bumpPanelUsage } from "../../../shared/panel-usage.ts";
import type { PanelUsageSnapshot } from "../../../shared/panel-usage.ts";
import type { PriceChartData } from "../../../shared/price-chart.ts";
import { PRICE_CHART_CATEGORIES } from "../../../shared/price-chart.ts";
import type { ProviderDto } from "../../../shared/provider.ts";
import type { RightPanelMemoryFile } from "../../../shared/right-panel-memory.ts";
import { deriveSessionTitle, sortSessions, type SessionMeta, type SessionRecord } from "../../../shared/session.ts";
import { parseSettings, type AppSettings, type SettingsPatch } from "../../../shared/settings.ts";
import type { TranscriptItem } from "../../../shared/transcript.ts";
import type { Workspace } from "../../../shared/workspace.ts";
import { buildPreviewFixture, fallbackTranscript, type PreviewFixture, type PreviewOptions } from "./scenes.ts";
import { messagesOf } from "../locale.ts";
import { planTimeline } from "../features/context/plan-timeline.ts";
import { resumeAnswer, resumeBrief } from "../features/context/resume-brief.ts";

type PreviewDomain = Exclude<keyof OrbitaApi, "platform" | "initialTheme" | "initialLanguage">;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function unsupported(label: string): Error {
  return new Error(`Preview fixture: ${label} is not connected; no host IPC, network, or filesystem action was performed.`);
}

/** 已实现的域保留真实契约；没实现的动作明确拒绝，订阅类缺席则安静返回退订函数。 */
function fixtureDomain<K extends PreviewDomain>(name: K, implementation: Partial<OrbitaApi[K]>): OrbitaApi[K] {
  const target = implementation as object;
  return new Proxy(target, {
    get(current, key, receiver) {
      if (Reflect.has(current, key)) return Reflect.get(current, key, receiver);
      if (typeof key === "string" && /^on[A-Z]/.test(key)) return () => () => undefined;
      return () => Promise.reject(unsupported(`${name}.${String(key)}`));
    },
  }) as OrbitaApi[K];
}

function unsupportedDomain(name: string): unknown {
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key === "string" && /^on[A-Z]/.test(key)) return () => () => undefined;
      return () => Promise.reject(unsupported(`${name}.${String(key)}`));
    },
  });
}

/** 与 SettingsStore 的补丁语义一致：几个对象值按键合并，null 仍由 parseSettings 清除。 */
function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  return parseSettings({
    ...current,
    ...patch,
    drawer: patch.drawer === undefined ? current.drawer : { ...current.drawer, ...patch.drawer },
    lastUsed: patch.lastUsed === undefined ? current.lastUsed : { ...current.lastUsed, ...patch.lastUsed },
    experimentalFeatures: patch.experimentalFeatures === undefined
      ? current.experimentalFeatures
      : { ...current.experimentalFeatures, ...patch.experimentalFeatures },
    providersPage: patch.providersPage === undefined ? current.providersPage : { ...current.providersPage, ...patch.providersPage },
    pluginsPage: patch.pluginsPage === undefined ? current.pluginsPage : { ...current.pluginsPage, ...patch.pluginsPage },
    vector: patch.vector === undefined ? current.vector : { ...current.vector, ...patch.vector },
  });
}

function priceChart(providers: readonly ProviderDto[], scene: PreviewOptions["scene"]): PriceChartData {
  const ranked = providers.flatMap((provider) => provider.models.declared.map((model) => model.id)).filter((id) => id !== "deepseek-chat");
  return {
    categories: PRICE_CHART_CATEGORIES.map((category) => ({
      category,
      unit: category === "agent" ? "net-improvement" : "rating",
      publishDate: "2026-11-12",
      points: ranked.map((modelId, index) => ({
        modelId,
        thinkingLevel: "high" as const,
        boardName: `${modelId} fixture`,
        score: category === "agent" ? 0.08 + index * 0.025 : 1380 + index * 24,
        scoreLower: category === "agent" ? 0.07 + index * 0.025 : 1368 + index * 24,
        scoreUpper: category === "agent" ? 0.09 + index * 0.025 : 1392 + index * 24,
        cost: 0.012 + index * 0.009,
        costBasis: scene === "empty" ? "reference" as const : "estimated" as const,
        samples: 0,
      })),
      unranked: providers.some((provider) => provider.models.declared.some((model) => model.id === "deepseek-chat"))
        ? [{ modelId: "deepseek-chat" }]
        : [],
      unpriced: [],
    })),
    profile: {
      taskCount: scene === "full" ? 1_974 : scene === "typical" ? 6 : 0,
      medianTaskTokens: 68_000,
      mix: { input: 0.28, output: 0.12, cacheRead: 0.52, cacheWrite: 0.08 },
      reference: scene === "empty",
    },
    hasPlanProvider: true,
    source: {
      dataset: "deterministic-preview-fixture",
      url: "https://fixture.invalid/leaderboard",
      revision: "preview-1",
      license: "Fixture",
      attribution: "Synthetic preview points; no Arena record, user task, or network response is represented.",
    },
  };
}

function sessionWindow(records: SessionRecord[]): { total: number; hasMore: boolean; compactionsBefore: number } {
  return { total: records.length, hasMore: false, compactionsBefore: 0 };
}

function mainRole(fixture: PreviewFixture, sessionId: string, workspaceId: string | null): { role?: "main" } {
  if (workspaceId === null) return {};
  return fixture.profiles.get(workspaceId)?.sessionId === sessionId ? { role: "main" as const } : {};
}

/**
 * 完整 App 唯一使用的 preview API。所有写入只改这次页面加载拥有的内存对象；
 * fixture 里没有真实路径、密钥、provider 配置或用户会话。
 */
export function createPreviewApi(options: PreviewOptions, platform: string = "darwin"): OrbitaApi {
  const fixture = buildPreviewFixture(options);
  let settings = fixture.settings;
  let mutation = 0;
  const tick = (): number => options.now + ++mutation * 1_000;
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const channelListeners = new Set<(event: ChannelEvent) => void>();
  const emitAgent = (event: AgentEvent): void => {
    for (const listener of agentListeners) listener(event);
  };
  const emitChannel = (event: ChannelEvent): void => {
    for (const listener of channelListeners) listener(event);
  };
  const patchSession = (id: string, patch: Partial<SessionMeta>): void => {
    fixture.sessions = fixture.sessions.map((item) => item.id === id ? { ...item, ...patch, updatedAt: tick() } : item);
  };
  // ChannelMessage 不重复存 parentId/childId；场景创建后按会话关系做一次归属索引。
  const channelIndex = indexChannels(fixture);
  const loadChannel = (key: ChannelKey): ChannelMessage[] => clone(channelIndex.get(channelKey(key)) ?? []);

  /**
   * 跨天场景：用户对主智能体说「接着上次」→ 用已落盘的结构化状态（目标、计划、各件活的通道往来）拼出恢复回答
   * （features/context/resume-brief.ts），回答末尾标明不是模型记忆。这只是预览：真实运行时应把同一份状态交给模型自己回答，尚未接。
   * 其余输入 / 普通会话 = null，走通用的确定性回答。
   */
  const resumeReply = (meta: SessionMeta, text: string, at: number): string | null => {
    if (meta.role !== "main" || !RESUME_ASK.test(text)) return null;
    const t = messagesOf(settings.language ?? "en");
    const records = fixture.transcripts.get(meta.id) ?? [];
    const jobs = fixture.sessions
      .filter((item) => item.parentId === meta.id)
      .map((item) => ({
        title: item.title,
        messages: channelIndex.get(channelKey({ parentId: meta.id, childId: item.id })) ?? [],
        plan: planTimeline(fixture.transcripts.get(item.id) ?? [])?.current.items ?? null,
      }));
    const brief = resumeBrief({ records, jobs }, t.taskPanel.brief);
    const when = brief.leftAt === null ? "" : leftWhen(brief.leftAt, at, t.taskPanel.resume);
    return `${resumeAnswer(brief, when, t.taskPanel.resume)}\n\n${t.taskPanel.resume.fixtureNote}`;
  };

  const submit: OrbitaApi["agent"]["submit"] = async (input) => {
    const at = tick();
    const existing = fixture.sessions.find((item) => item.id === input.sessionId);
    const title = existing?.title || deriveSessionTitle(input.text) || "Fixture task";
    const nextMeta: SessionMeta = existing === undefined ? {
      id: input.sessionId,
      title,
      titleSource: "derived",
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      piSessionFile: `/fixtures/pi/${input.sessionId}.jsonl`,
      pinned: false,
      archived: false,
      starred: false,
      unread: null,
      recentQueries: [title],
      stats: null,
      durable: { since: at },
      ...mainRole(fixture, input.sessionId, input.workspaceId),
      createdAt: at,
      updatedAt: at,
    } : {
      ...existing,
      providerId: input.providerId,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      updatedAt: at,
      recentQueries: [title, ...existing.recentQueries.filter((query) => query !== title)].slice(0, 3),
    };
    fixture.sessions = existing === undefined
      ? [nextMeta, ...fixture.sessions]
      : fixture.sessions.map((item) => item.id === input.sessionId ? nextMeta : item);
    const user: Extract<TranscriptItem, { role: "user" }> = {
      id: `${input.sessionId}-preview-user-${mutation}`,
      role: "user",
      content: [{ type: "text", text: input.text }],
      timestamp: at,
    };
    const responseId = `${input.sessionId}-preview-assistant-${mutation}`;
    const streaming: Extract<TranscriptItem, { role: "assistant" }> = {
      id: responseId,
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: { provider: input.providerId, id: input.modelId },
      status: "streaming",
      timestamp: at + 100,
    };
    const complete: Extract<TranscriptItem, { role: "assistant" }> = {
      ...streaming,
      content: [{ type: "text", text: resumeReply(nextMeta, input.text, at) ?? "This is a deterministic fixture response. No model request, host IPC, or file write occurred." }],
      status: "complete",
      stopReason: "stop",
    };
    fixture.transcripts.set(input.sessionId, [...(fixture.transcripts.get(input.sessionId) ?? (existing ? fallbackTranscript(existing) : [])), user, complete]);
    queueMicrotask(() => {
      emitAgent({ type: "created", sessionId: input.sessionId, piSessionFile: nextMeta.piSessionFile });
      emitAgent({ type: "phase", sessionId: input.sessionId, phase: "turn" });
      emitAgent({ type: "progress", sessionId: input.sessionId, progress: { type: "item_started", item: user } });
      emitAgent({ type: "progress", sessionId: input.sessionId, progress: { type: "item_started", item: streaming } });
      emitAgent({ type: "progress", sessionId: input.sessionId, progress: { type: "item_finished", item: complete } });
      const nextStats: AgentStats = {
        tokens: { input: 120, output: 32, cacheRead: 0, cacheWrite: 0, total: 152 },
        cost: 0,
        contextUsage: { tokens: 152, contextWindow: 262_144, percent: 0.06 },
      };
      patchSession(input.sessionId, { stats: nextStats });
      emitAgent({ type: "stats", sessionId: input.sessionId, stats: nextStats, persist: true });
      emitAgent({ type: "phase", sessionId: input.sessionId, phase: "idle" });
    });
  };

  const root: Record<string, unknown> = {
    platform,
    initialTheme: options.theme,
    initialLanguage: options.language,
    agent: fixtureDomain("agent", {
      submit,
      interrupt: submit,
      abort: async (sessionId) => queueMicrotask(() => emitAgent({ type: "phase", sessionId, phase: "idle" })),
      setThinkingLevel: async (sessionId, level) => {
        const item = fixture.sessions.find((candidate) => candidate.id === sessionId);
        if (item === undefined) throw unsupported("agent.setThinkingLevel for a missing session");
        patchSession(sessionId, { thinkingLevel: level });
        queueMicrotask(() => emitAgent({ type: "thinking", sessionId, providerId: item.providerId, modelId: item.modelId, level, supported: ["minimal", "low", "medium", "high", "xhigh", "max"] }));
      },
      setModel: async (sessionId, providerId, modelId) => {
        patchSession(sessionId, { providerId, modelId });
        queueMicrotask(() => emitAgent({ type: "model", sessionId, providerId, modelId }));
      },
      kernelInfo: async () => ({ running: [] }),
      answerIntentConfirm: async () => undefined,
      onEvent: (listener) => {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
    }),
    settings: fixtureDomain("settings", {
      get: async () => clone(settings),
      set: async (patch) => {
        settings = mergeSettings(settings, patch);
        return clone(settings);
      },
      dataDir: async () => "/fixtures/orbita",
      revealDataDir: async () => { throw unsupported("settings.revealDataDir"); },
    }),
    workspace: fixtureDomain("workspace", {
      list: async () => clone(fixture.workspaces),
      add: async () => null,
      create: async (name) => {
        const cleaned = name.trim();
        if (cleaned === "") throw new Error("Preview fixture: workspace name is empty.");
        const id = `ws-created-${fixture.workspaces.length + 1}`;
        const created: Workspace = { id, name: cleaned, path: `/fixtures/${id}`, createdAt: tick(), attachedDirs: [] };
        fixture.workspaces.push(created);
        return clone(created);
      },
      rename: async (id, name) => {
        fixture.workspaces = fixture.workspaces.map((item) => item.id === id ? { ...item, name: name.trim() || item.name } : item);
      },
      remove: async (id) => {
        fixture.workspaces = fixture.workspaces.filter((item) => item.id !== id);
      },
      default: async () => "/fixtures/Home",
      attachDir: async () => null,
      detachDir: async (id, dir) => {
        const item = fixture.workspaces.find((candidate) => candidate.id === id);
        if (item !== undefined) item.attachedDirs = item.attachedDirs.filter((entry) => entry !== dir);
        return [...(item?.attachedDirs ?? [])];
      },
    }),
    agents: fixtureDomain("agents", {
      main: async (workspaceId) => {
        const existing = fixture.profiles.get(workspaceId);
        if (existing !== undefined) return clone(existing);
        const created = { workspaceId, sessionId: `boss-${workspaceId}`, createdAt: tick() };
        fixture.profiles.set(workspaceId, created);
        return clone(created);
      },
      setMainModel: async (input) => {
        const existing = fixture.profiles.get(input.workspaceId) ?? { workspaceId: input.workspaceId, sessionId: `boss-${input.workspaceId}`, createdAt: tick() };
        const next = { ...existing, model: clone(input.model) };
        fixture.profiles.set(input.workspaceId, next);
        return clone(next);
      },
    }),
    session: fixtureDomain("session", {
      list: async () => clone(sortSessions(fixture.sessions)),
      meta: async (id) => clone(fixture.sessions.find((item) => item.id === id) ?? null),
      load: async (id) => {
        const item = fixture.sessions.find((candidate) => candidate.id === id);
        if (item === undefined) return null;
        const records = clone(fixture.transcripts.get(id) ?? fallbackTranscript(item));
        return { meta: clone(item), transcript: records, window: sessionWindow(records) };
      },
      loadOlder: async () => ({ records: [], hasMore: false }),
      plan: async (id) => planTimeline(fixture.transcripts.get(id) ?? [])?.current.items.map(({ text, status, waitingFor }) => ({ text, status, ...(waitingFor === undefined ? {} : { waitingFor }) })) ?? null,
      rename: async (id, title) => {
        const item = fixture.sessions.find((candidate) => candidate.id === id);
        if (item !== undefined) patchSession(id, { title: title.trim() || item.title, titleSource: "user" });
      },
      remove: async (id) => {
        const removed = new Set([id, ...fixture.sessions.filter((item) => item.parentId === id).map((item) => item.id)]);
        fixture.sessions = fixture.sessions.filter((item) => !removed.has(item.id));
      },
      modelAssignGroups: async () => groupUnassignedModels(fixture.sessions),
      modelAssignRun: async (entries) => {
        const plans = planAssignments(fixture.sessions, entries);
        const byId = new Map(plans.map((plan) => [plan.id, plan]));
        fixture.sessions = fixture.sessions.map((item) => {
          const plan = byId.get(item.id);
          return plan === undefined ? item : { ...item, providerId: plan.providerId, modelId: plan.modelId };
        });
        return { assigned: plans.length, skipped: 0 };
      },
      workbenchStat: async (id) => ({ path: `/fixtures/workbenches/${id}`, exists: true, fileCount: 3 }),
      attachment: async () => null,
      pin: async (id, pinned) => patchSession(id, { pinned }),
      star: async (id, starred) => patchSession(id, { starred }),
      setIntentEnabled: async (id, enabled) => patchSession(id, { intentEnabled: enabled }),
      setUnread: async (id, unread) => patchSession(id, { unread: clone(unread) }),
      archive: async (id, archived) => patchSession(id, { archived }),
      move: async (ids, workspaceId) => {
        const wanted = new Set(ids);
        const target = fixture.workspaces.find((item) => item.id === workspaceId);
        if (workspaceId !== null && target === undefined) throw unsupported("session.move to a missing workspace");
        const moved: string[] = [];
        const skipped: { id: string; reason: "missing" }[] = [];
        for (const id of ids) {
          if (fixture.sessions.some((item) => item.id === id)) moved.push(id);
          else skipped.push({ id, reason: "missing" });
        }
        fixture.sessions = fixture.sessions.map((item) => wanted.has(item.parentId ?? "") || wanted.has(item.id)
          ? { ...item, workspaceId, cwd: target?.path ?? "/fixtures/Home", updatedAt: tick() }
          : item);
        return { moved: [...moved, ...fixture.sessions.filter((item) => item.parentId !== undefined && wanted.has(item.parentId)).map((item) => item.id)], skipped };
      },
      exportMarkdown: async () => null,
    }),
    channel: fixtureDomain("channel", {
      list: async (parentId) => fixture.sessions
        .filter((item) => item.parentId === parentId)
        .map((item) => summarizeChannel({ parentId, childId: item.id }, item.title, channelIndex.get(channelKey({ parentId, childId: item.id })) ?? []))
        .filter((summary) => summary.hasExchange),
      load: async (key) => loadChannel(key),
      speak: async (input) => {
        const message: ChannelMessage = { id: `fixture-reply-${++mutation}`, from: "parent", author: "user", kind: "reply", text: input.text, delivery: input.delivery, createdAt: tick() };
        const key = channelKey(input);
        channelIndex.set(key, [...(channelIndex.get(key) ?? []), message]);
        emitChannel({ type: "message", parentId: input.parentId, childId: input.childId, message, childWorkbench: `/fixtures/workbenches/${input.childId}` });
        emitChannel({ type: "status", parentId: input.parentId, childId: input.childId, status: "running" });
        return clone(message);
      },
      stop: async (input) => {
        const message: ChannelMessage = { id: `fixture-stop-${++mutation}`, from: "parent", author: "user", kind: "stop", text: "Stopped in the preview fixture.", delivery: "steer", createdAt: tick() };
        const key = channelKey(input);
        channelIndex.set(key, [...(channelIndex.get(key) ?? []), message]);
        emitChannel({ type: "message", parentId: input.parentId, childId: input.childId, message, childWorkbench: `/fixtures/workbenches/${input.childId}` });
        emitChannel({ type: "status", parentId: input.parentId, childId: input.childId, status: "stopped" });
      },
      pending: async () => [],
      onEvent: (listener) => {
        channelListeners.add(listener);
        return () => channelListeners.delete(listener);
      },
    }),
    provider: fixtureDomain("provider", {
      builtins: async (): Promise<BuiltinProvider[]> => clone(fixture.builtins),
      list: async () => clone(fixture.providers),
      refreshCatalog: async () => { throw unsupported("provider.refreshCatalog (offline fixture)"); },
      remove: async (id) => {
        fixture.providers = fixture.providers.filter((item) => item.id !== id);
      },
      setDisabled: async ({ id, disabled }) => {
        const item = fixture.providers.find((candidate) => candidate.id === id);
        if (item === undefined) return null;
        item.disabled = disabled;
        return clone(item);
      },
      reorder: async (ids) => {
        const rank = new Map(ids.map((id, index) => [id, index]));
        fixture.providers.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      },
      test: async () => ({ ok: true, message: "Fixture connection only; no network request was made." }),
      reveal: async () => "fixture-only-not-a-secret",
      discover: async (input) => {
        const models = fixture.providers.find((item) => item.id === input.providerId)?.models.declared.map((model) => model.id) ?? [];
        return { ok: true, models, message: "Fixture model discovery; no network request was made." };
      },
    }),
    usage: fixtureDomain("usage", {
      week: async () => clone(fixture.usage),
      priceChart: async () => priceChart(fixture.providers, options.scene),
    }),
    automation: fixtureDomain("automation", {
      list: async () => [],
      create: async () => ({ ok: false, error: "Preview fixture: automation creation is not connected." }),
      update: async () => ({ ok: false, error: "Preview fixture: automation editing is not connected." }),
      act: async () => ({ ok: false, error: "Preview fixture: automation actions are not connected." }),
      promote: async () => ({ ok: false, error: "Preview fixture: automation sessions are not connected." }),
    }),
    terminal: fixtureDomain("terminal", { list: async () => [] }),
    plugin: fixtureDomain("plugin", {
      list: async () => ({ plugins: [], mcpError: null }),
      skills: async () => [],
      drafts: async () => [],
      archived: async () => [],
    }),
    skill: fixtureDomain("skill", { list: async () => [], archived: async () => [] }),
    notify: fixtureDomain("notify", { logChime: async () => undefined }),
    updater: fixtureDomain("updater", {
      get: async () => ({
        currentVersion: "0.1.19",
        support: "unpackaged",
        state: { kind: "idle" },
        currentNotes: [{ icon: "orbit", text: "Production renderer running on deterministic preview fixtures." }],
        releasesUrl: null,
      }),
      recentReleases: async () => ({ ok: true, releases: [] }),
    }),
    rightPanelMemory: (() => {
      let memory: RightPanelMemoryFile | null = null;
      return fixtureDomain("rightPanelMemory", {
        load: async () => clone(memory),
        save: async (file) => { memory = clone(file); },
      });
    })(),
    panelUsage: (() => {
      let snapshot: PanelUsageSnapshot = { since: options.now, counts: {} };
      return fixtureDomain("panelUsage", {
        get: async () => clone(snapshot),
        bump: async (key) => {
          snapshot = bumpPanelUsage(snapshot, key);
          return clone(snapshot);
        },
      });
    })(),
    window: fixtureDomain("window", {
      minimize: async () => { throw unsupported("window.minimize"); },
      toggleMaximize: async () => { throw unsupported("window.toggleMaximize"); },
      close: async () => { throw unsupported("window.close"); },
      getPathForFile: (file) => `/fixtures/drop/${file.name}`,
    }),
    files: fixtureDomain("files", {
      statKind: async (paths) => paths.map(() => ({ kind: "file" as const, size: 0 })),
      pickFolders: async () => null,
      cancelLineIndex: () => undefined,
    }),
    docs: fixtureDomain("docs", { list: async () => [] }),
  };
  return new Proxy(root, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return unsupportedDomain(String(key));
    },
  }) as OrbitaApi;
}

/** 「接着上次」的几种说法（中英）；只在预览里用来挑出跨天恢复的那句 */
const RESUME_ASK = /接着上次|继续上次|上次到哪|pick up where|where (did )?we (left|leave) off|continue from last time/i;

/** 「昨天 18:40」「3 天前 18:40」「今天 09:12」：按本地日历天数算 */
function leftWhen(leftAt: number, now: number, words: ReturnType<typeof messagesOf>["taskPanel"]["resume"]): string {
  const day = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const date = new Date(leftAt);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((day(now) - day(leftAt)) / 86_400_000);
  return days <= 0 ? words.todayAt(clock) : days === 1 ? words.yesterdayAt(clock) : words.daysAgoAt(days, clock);
}

function channelKey(key: ChannelKey): string {
  return `${key.parentId}\u0000${key.childId}`;
}

/** 通道数组仍保持场景数据紧凑；归属索引只在 API 创建时算一次。 */
function indexChannels(fixture: PreviewFixture): Map<string, ChannelMessage[]> {
  const out = new Map<string, ChannelMessage[]>();
  for (const item of fixture.sessions) {
    if (item.parentId === undefined) continue;
    const messages = fixture.channels.filter((message) => message.id.startsWith(`${item.parentId}:${item.id}:`));
    out.set(channelKey({ parentId: item.parentId, childId: item.id }), messages);
  }
  return out;
}
