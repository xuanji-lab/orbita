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
import { buildPreviewFixture, fallbackTranscript, fixtureDeckText, fixtureLogLine, FIXTURE_LOG_TOTAL_LINES, FIXTURE_TEMPLATE_HASH, type PreviewFixture, type PreviewOptions, type VfsNode } from "./scenes.ts";
import type {
  FileEntry,
  FilePreview,
  FileRoot,
  FsEntryFact,
} from "../../../shared/files.ts";
import { PREVIEW_LINES_PER_READ, fileRootLabel, sortFileEntries } from "../../../shared/files.ts";
import type { DocFile, DocListEntry, DocWriteResult } from "../../../shared/doc.ts";
import { DOC_GONE, DOC_LIST_DEPTH, DOC_LIST_LIMIT, NEW_DECK_NAME, NEW_DOC_NAME } from "../../../shared/doc.ts";
import type { ReviewDiff, ReviewList, ReviewSource } from "../../../shared/review.ts";
import { reviewDiffError } from "../../../shared/review.ts";
import type { Excerpt, ExcerptAddResponse, ExcerptItem, ExcerptListResponse, ExcerptRemoveResponse } from "../../../shared/excerpt.ts";
import type { MemoryEntriesResponse, MemoryMutationOutcome, MemoryScopeSummary, MemorySessionView } from "../../../shared/memory.ts";
import type { AutomationAction, AutomationEvent, AutomationOutcome } from "../../../shared/automation.ts";
import type { BoardFrameResult, BoardWeekRequest, BoardWeekResponse } from "../../../shared/plugin-board.ts";
import { BOARD_TEMPLATE_HASH_PATTERN, localWeekStart } from "../../../shared/plugin-board.ts";
import type { PluginConfigValue, PluginListResult, PluginRowInstallResult, PluginScope, PluginSkillFile } from "../../../shared/plugin.ts";
import type { PluginDraftSnapshot } from "../../../shared/plugin.ts";
import type { PluginBoardSnapshot, PluginPanelActionResult } from "../../../shared/plugin-panel.ts";
import type { SkillRestoreResult } from "../../../shared/skill.ts";
import type { McpListResult } from "../../../shared/mcp.ts";
import type { FocusChanges, FocusSummaryResult } from "../../../shared/focus.ts";
import type { ExternalSourcesResult } from "../../../shared/external-sources.ts";
import type { DictationSelection, DoubaoVoiceConfig, DoubaoVoiceInput, StepfunVoiceConfig, StepfunVoiceInput, VoiceResult } from "../../../shared/voice.ts";
import { isDoubaoConfigured, isStepfunConfigured } from "../../../shared/voice.ts";

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

/** 1×1 透明 PNG 的 base64（fixture 图片预览；不含 data: 前缀）。 */
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function vfsGet(fixture: PreviewFixture, path: string): VfsNode | undefined {
  const key = path.replace(/\/+$/u, "");
  return fixture.vfs.get(key);
}

function vfsFileSize(node: VfsNode): number {
  if (node.kind !== "file") return 0;
  if (node.text !== null) return node.text.length;
  if (node.image) return Math.floor(FIXTURE_PNG_BASE64.length * 3 / 4);
  if (node.binary) return 2048;
  return fixtureLogLine(0).length * FIXTURE_LOG_TOTAL_LINES;
}

function vfsDirMtime(fixture: PreviewFixture, dir: string): number {
  const prefix = `${dir.replace(/\/+$/u, "")}/`;
  let latest = 0;
  for (const [path, node] of fixture.vfs) {
    if (!path.startsWith(prefix)) continue;
    if (node.kind === "file") latest = Math.max(latest, node.modifiedAt);
  }
  return latest;
}

/** 一层目录：平铺表里扫直接子级（同前缀、余段不含 /），排序同主进程 fs:list。 */
function vfsList(fixture: PreviewFixture, dir: string): FileEntry[] {
  const prefix = `${dir.replace(/\/+$/u, "")}/`;
  const entries: FileEntry[] = [];
  for (const [path, node] of fixture.vfs) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "" || rest.includes("/")) continue;
    entries.push(
      node.kind === "dir"
        ? { name: rest, kind: "directory", modifiedAt: vfsDirMtime(fixture, path) }
        : { name: rest, kind: "file", size: vfsFileSize(node), modifiedAt: node.modifiedAt },
    );
  }
  return sortFileEntries(entries);
}

/** FNV-1a 内容摘要：契约里 hash 是主进程算的不透明值，fixture 用确定性的本地实现。 */
function fixtureHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isDocName(name: string): boolean {
  return /\.slides\.json$/iu.test(name) || /\.(?:md|markdown|txt)$/iu.test(name);
}

/** 工作区根的文档清单（.md / .txt / .slides.json，深度与上限同主进程）。 */
function docEntriesOf(fixture: PreviewFixture, root: string): DocListEntry[] {
  const out: DocListEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > DOC_LIST_DEPTH) return;
    for (const entry of vfsList(fixture, dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.kind === "directory") {
        walk(path, depth + 1);
        continue;
      }
      if (!isDocName(entry.name)) continue;
      const node = vfsGet(fixture, path);
      if (node?.kind !== "file") continue;
      out.push({
        path,
        name: entry.name,
        relative: path === `${root}/${entry.name}` ? entry.name : path.slice(root.length + 1),
        kind: /\.slides\.json$/iu.test(entry.name) ? "slides" : "doc",
        modifiedAt: entry.modifiedAt,
      });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, DOC_LIST_LIMIT);
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
  const automationListeners = new Set<(event: AutomationEvent) => void>();
  const emitAgent = (event: AgentEvent): void => {
    for (const listener of agentListeners) listener(event);
  };
  const emitChannel = (event: ChannelEvent): void => {
    for (const listener of channelListeners) listener(event);
  };
  const emitAutomationChanged = (): void => {
    queueMicrotask(() => {
      for (const listener of automationListeners) listener({ type: "changed" });
    });
  };
  const patchSession = (id: string, patch: Partial<SessionMeta>): void => {
    fixture.sessions = fixture.sessions.map((item) => item.id === id ? { ...item, ...patch, updatedAt: tick() } : item);
  };
  // ChannelMessage 不重复存 parentId/childId；场景创建后按会话关系做一次归属索引。
  const channelIndex = indexChannels(fixture);
  const loadChannel = (key: ChannelKey): ChannelMessage[] => clone(channelIndex.get(channelKey(key)) ?? []);

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
      content: [{ type: "text", text: "This is a deterministic fixture response. No model request, host IPC, or file write occurred." }],
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
    review: fixtureDomain("review", {
      list: async (_sessionId: string, source: ReviewSource): Promise<ReviewList> => {
        const list = fixture.review.lists[source];
        return list === undefined
          ? { kind: "error", message: `Preview fixture: unknown review source ${String(source)}.`, cwd: "/fixtures" }
          : clone(list);
      },
      diff: async (_sessionId: string, source: ReviewSource, path: string): Promise<ReviewDiff> => {
        const found = fixture.review.diffs.get(`${source} ${path}`);
        return found === undefined
          ? reviewDiffError("failed", "Preview fixture: no diff recorded for this path.")
          : clone(found);
      },
    }),
    excerpt: fixtureDomain("excerpt", {
      list: async (): Promise<ExcerptListResponse> => ({ items: clone(fixture.excerpts) }),
      add: async (request): Promise<ExcerptAddResponse> => {
        const normalize = (text: string): string => text.trim().replace(/\s+/gu, " ");
        const existing = fixture.excerpts.find((item) =>
          item.excerpt.sessionId === request.sessionId &&
          item.excerpt.turn === request.turn &&
          item.excerpt.role === request.role &&
          normalize(item.excerpt.text) === normalize(request.text));
        if (existing !== undefined) return { excerpt: clone(existing.excerpt), duplicate: true };
        const excerpt: Excerpt = {
          id: `exc-fixture-${fixture.excerpts.length + 1}`,
          text: request.text.trim(),
          sessionId: request.sessionId,
          ...(request.turn === undefined ? {} : { turn: request.turn }),
          role: request.role,
          createdAt: tick(),
        };
        const meta = fixture.sessions.find((item) => item.id === request.sessionId);
        fixture.excerpts.unshift({ excerpt, sessionTitle: meta?.title ?? null });
        return { excerpt: clone(excerpt), duplicate: false };
      },
      remove: async (request): Promise<ExcerptRemoveResponse> => {
        const before = fixture.excerpts.length;
        fixture.excerpts = fixture.excerpts.filter((item) => item.excerpt.id !== request.id);
        return { removed: fixture.excerpts.length !== before };
      },
    }),
    memory: fixtureDomain("memory", {
      scopes: async (): Promise<MemoryScopeSummary[]> => clone(fixture.memory.scopes),
      entries: async (request): Promise<MemoryEntriesResponse> => ({
        items: clone(fixture.memory.views.filter((view) =>
          (request.token === "all" || view.token === request.token) &&
          (request.type === undefined || view.entry.type === request.type))),
      }),
      session: async (sessionId: string): Promise<MemorySessionView> =>
        clone(fixture.memory.sessionViews.get(sessionId) ?? { sessionId, token: null, turns: [] }),
      mutate: async (mutation): Promise<MemoryMutationOutcome> => {
        const views = fixture.memory.views;
        const findView = (token: string, entryId: string) =>
          views.find((view) => view.token === token && view.entry.id === entryId);
        switch (mutation.op) {
          case "edit": {
            const view = findView(mutation.token, mutation.entryId);
            const text = mutation.text.trim();
            if (view === undefined) return { ok: false, error: "Preview fixture: entry not found." };
            if (text === "") return { ok: false, error: "Preview fixture: empty text." };
            view.entry = { ...view.entry, text, editedAt: tick() };
            return { ok: true, entry: clone(view.entry) };
          }
          case "remove": {
            const index = views.findIndex((view) => view.token === mutation.token && view.entry.id === mutation.entryId);
            if (index >= 0) views.splice(index, 1);
            return { ok: true, entry: null };
          }
          case "setStatus": {
            const view = findView(mutation.token, mutation.entryId);
            if (view === undefined) return { ok: false, error: "Preview fixture: entry not found." };
            view.entry = mutation.status === "active"
              ? { ...view.entry, status: "active", mutedReason: undefined }
              : { ...view.entry, status: "muted" };
            return { ok: true, entry: clone(view.entry) };
          }
          case "addManual": {
            const entry = {
              id: `mem-fixture-manual-${views.length + 1}`,
              type: mutation.type,
              text: mutation.text,
              keywords: mutation.text.toLowerCase().split(/\s+/u).filter((word) => word !== "").slice(0, 8),
              layer: mutation.scopeId === undefined ? "user" as const : "workspace" as const,
              ...(mutation.scopeId === undefined ? {} : { scopeId: mutation.scopeId }),
              sessionId: "",
              turns: [],
              at: tick(),
              episodeId: `ep-fixture-manual-${views.length + 1}`,
              source: "manual" as const,
            };
            views.unshift({ entry, token: mutation.token, sessionTitle: null, quote: null, evolution: [], usage: { count: 0, lastAt: null } });
            return { ok: true, entry: clone(entry) };
          }
          case "restorePrevious": {
            const view = findView(mutation.token, mutation.entryId);
            const previousId = view?.entry.conflictWith;
            const previous = previousId === undefined ? undefined : views.find((candidate) => candidate.entry.id === previousId);
            if (view === undefined || previous === undefined) return { ok: false, error: "Preview fixture: evolution chain not found." };
            previous.entry = { ...previous.entry, status: "active" };
            view.entry = { ...view.entry, status: "stale" };
            return { ok: true, entry: clone(previous.entry) };
          }
          case "returnToWorkspace": {
            const view = findView(mutation.token, mutation.entryId);
            if (view === undefined) return { ok: false, error: "Preview fixture: entry not found." };
            view.token = "ws-research";
            view.entry = { ...view.entry, layer: "workspace", scopeId: "ws-research", promotedFrom: undefined };
            return { ok: true, entry: clone(view.entry) };
          }
        }
      },
      vectorStatus: async () => { throw unsupported("memory.vectorStatus (no local vector runtime in the preview)"); },
      vectorSet: async () => { throw unsupported("memory.vectorSet (no local vector runtime in the preview)"); },
      vectorDownload: async () => { throw unsupported("memory.vectorDownload (no model download in the preview)"); },
      historyEstimate: async () => { throw unsupported("memory.historyEstimate (no history import in the preview)"); },
      historyStart: async () => { throw unsupported("memory.historyStart (no history import in the preview)"); },
      historyControl: async () => { throw unsupported("memory.historyControl (no history import in the preview)"); },
      historyStatus: async () => { throw unsupported("memory.historyStatus (no history import in the preview)"); },
    }),
    automation: fixtureDomain("automation", {
      list: async () => clone(fixture.automations),
      create: async (): Promise<AutomationOutcome> => {
        emitAutomationChanged();
        return { ok: false, error: "Preview fixture: creating an automation needs the scheduler; not connected." };
      },
      update: async (): Promise<AutomationOutcome> => {
        emitAutomationChanged();
        return { ok: false, error: "Preview fixture: editing an automation needs the scheduler; not connected." };
      },
      act: async (id, action: AutomationAction): Promise<AutomationOutcome> => {
        const item = fixture.automations.find((candidate) => candidate.id === id);
        if (item === undefined) return { ok: false, error: "Preview fixture: automation not found." };
        emitAutomationChanged();
        switch (action.type) {
          case "pause":
            Object.assign(item, { status: "paused" as const, nextRunAt: null, updatedAt: tick() });
            return { ok: true, automation: clone(item) };
          case "resume":
            Object.assign(item, { status: "active" as const, nextRunAt: tick() + 4 * 60 * 60 * 1000, updatedAt: tick() });
            return { ok: true, automation: clone(item) };
          case "restart":
            Object.assign(item, { status: "active" as const, nextRunAt: tick() + 4 * 60 * 60 * 1000, runCount: 0, consecutiveFailures: 0, failureReason: undefined, updatedAt: tick() });
            return { ok: true, automation: clone(item) };
          case "runNow":
            return { ok: false, error: "Preview fixture: running an automation needs the model runtime; not connected." };
          case "delete":
            fixture.automations = fixture.automations.filter((candidate) => candidate.id !== id);
            return { ok: true, automation: null };
        }
      },
      promote: async () => ({ ok: false, error: "Preview fixture: promoting automation sessions is not connected." }),
      onEvent: (listener) => {
        automationListeners.add(listener);
        return () => automationListeners.delete(listener);
      },
    }),
    terminal: fixtureDomain("terminal", {
      list: async () => [],
      create: async () => { throw unsupported("terminal.create (no PTY in the preview; the panel shows the production spawn-failure path)"); },
      snapshot: async () => { throw unsupported("terminal.snapshot"); },
      input: async () => { throw unsupported("terminal.input (no PTY in the preview)"); },
      resize: async () => { throw unsupported("terminal.resize (no PTY in the preview)"); },
      ackOutput: async () => { throw unsupported("terminal.ackOutput (no PTY in the preview)"); },
      kill: async () => undefined,
      onEvent: (listener) => {
        void listener;
        return () => undefined;
      },
    }),
    plugin: fixtureDomain("plugin", {
      list: async (): Promise<PluginListResult> => ({ plugins: clone(fixture.plugins.plugins), mcpError: null }),
      skills: async () => clone(fixture.plugins.skills),
      archived: async () => [],
      drafts: async () => clone(fixture.plugins.drafts),
      setScope: async (id: string, scope: PluginScope) => {
        const view = fixture.plugins.plugins.find((item) => item.id === id);
        if (view === undefined) throw unsupported(`plugin.setScope for ${id}`);
        view.scope = clone(scope);
        if (scope.kind !== "off") view.placement = clone(scope);
      },
      setConfig: async (name: string, key: string, value: PluginConfigValue | null) => {
        const state = fixture.plugins.plugins
          .find((item) => item.name === name)
          ?.config.find((item) => item.field.key === key);
        if (state === undefined) throw unsupported(`plugin.setConfig ${name}.${key}`);
        state.value = clone(value);
        state.isSet = value !== null;
      },
      reload: async () => undefined,
      uninstall: async (name: string) => {
        fixture.plugins.plugins = fixture.plugins.plugins.filter((item) => item.name !== name || item.install?.source.kind === "builtin");
      },
      discard: async (path: string) => {
        fixture.plugins.drafts = fixture.plugins.drafts.filter((item) => item.path !== path);
      },
      draftLoad: async (req): Promise<PluginDraftSnapshot> => {
        const draft = fixture.plugins.drafts.find((item) => item.path === req.path);
        if (draft === undefined || draft.workspaceId !== req.workspaceId || fixture.plugins.draftView === null) {
          return { kind: "unavailable", stamp: "", reason: "not-found" };
        }
        if (req.stamp === "fixture-draft-stamp") return { kind: "unchanged" };
        return { kind: "ready", stamp: "fixture-draft-stamp", view: clone(fixture.plugins.draftView) };
      },
      draftBoardLoad: async (): Promise<PluginBoardSnapshot> => ({ kind: "unavailable", stamp: "", reason: "no-board", problems: [] }),
      boardLoad: async (): Promise<PluginBoardSnapshot> => ({ kind: "unavailable", stamp: "", reason: "not-enabled", problems: [] }),
      skillFile: async (name: string, slug: string): Promise<PluginSkillFile> => ({
        slug,
        path: `/fixtures/skills/${slug}/SKILL.md`,
        content: `# ${slug}\n\nFixture skill body for ${name}; no host file was read.\n`,
      }),
      panelAction: async (): Promise<PluginPanelActionResult> => ({ ok: false, reason: "unavailable", message: "Preview fixture: board actions are not connected." }),
      pickFolder: async () => null,
      reveal: async () => { throw unsupported("plugin.reveal (no host file manager in the preview)"); },
    }),
    mcp: fixtureDomain("mcp", {
      list: async (): Promise<McpListResult> => clone(fixture.plugins.mcp),
      reload: async () => undefined,
      setDisabled: async (name: string, disabled: boolean) => {
        const server = fixture.plugins.mcp.servers.find((item) => item.name === name);
        if (server !== undefined) {
          server.disabled = disabled;
          server.status = { kind: "disabled" };
        }
      },
      remove: async (name: string) => {
        fixture.plugins.mcp.servers = fixture.plugins.mcp.servers.filter((item) => item.name !== name);
        fixture.plugins.plugins = fixture.plugins.plugins.filter((item) => item.name !== name);
      },
      openConfig: async () => { throw unsupported("mcp.openConfig (no host editor in the preview)"); },
      add: async () => { throw unsupported("mcp.add (no mcp.json write in the preview)"); },
    }),
    skill: fixtureDomain("skill", {
      list: async () => clone(fixture.plugins.skills),
      archived: async () => [],
    }),
    board: fixtureDomain("board", {
      week: async (request: BoardWeekRequest): Promise<BoardWeekResponse | null> => {
        if (!Number.isFinite(request.weekStart)) return null;
        const target = localWeekStart(Math.round(request.weekStart));
        const offset = target - fixture.board.weekStart;
        const days = fixture.board.days.map((day) => ({
          start: day.start + offset,
          end: day.end + offset,
          items: day.items
            .map((item) => ({ ...item, at: item.at + offset }))
            .filter((item) => item.at >= day.start + offset && item.at < day.end + offset),
          planned: day.planned
            .map((item) => ({ ...item, at: item.at + offset }))
            .filter((item) => item.at > fixture.board.now),
        }));
        return { weekStart: target, now: fixture.board.now, days };
      },
      frame: async ({ hash }): Promise<BoardFrameResult> =>
        BOARD_TEMPLATE_HASH_PATTERN.test(hash) && hash === FIXTURE_TEMPLATE_HASH
          ? { frameUrl: "/preview-board-card.html" }
          : null,
    }),
    focus: fixtureDomain("focus", {
      changes: async (): Promise<FocusChanges> => clone(fixture.focusChanges),
      /** 预览不发系统通知：安静兑现，界面流程照常走完。 */
      notifyDone: async () => undefined,
      /** 收工小结是 fixture 文本（modelLabel 如实标注），不调用家务活模型。 */
      summarize: async (): Promise<FocusSummaryResult> => ({
        kind: "ok",
        bullets: [
          "把 6 条会话的进展并成了一张 digest 卡（fixture 文本，未调用模型）。",
          "src/app.ts 的 +3/-2 与审查面板的任务来源一致。",
          "data/dump.csv 行数未知，左栏已如实标出。",
        ],
        sessionsRead: 2,
        modelLabel: "preview-fixture",
      }),
      onSuspend: (listener) => {
        void listener;
        return () => undefined;
      },
    }),
    externalSources: fixtureDomain("externalSources", {
      list: async (): Promise<ExternalSourcesResult> => clone(fixture.externalSources),
    }),
    voice: (() => {
      let provider: "doubao" | "stepfun" = "doubao";
      let doubao = { appId: "", resourceId: "", token: null as string | null };
      let stepfunKey: string | null = null;
      const mask = (secret: string): string => `fix…${secret.slice(-4)}`;
      const doubaoConfig = (): DoubaoVoiceConfig => ({
        appId: doubao.appId,
        resourceId: doubao.resourceId,
        tokenMasked: doubao.token === null ? null : mask(doubao.token),
      });
      const stepfunConfig = (): StepfunVoiceConfig => ({ apiKeyMasked: stepfunKey === null ? null : mask(stepfunKey) });
      const selection = (): DictationSelection => ({
        provider,
        configured: provider === "doubao" ? isDoubaoConfigured(doubaoConfig()) : isStepfunConfigured(stepfunConfig()),
      });
      return fixtureDomain("voice", {
        dictationSelection: async () => selection(),
        setDictationProvider: async (next): Promise<DictationSelection> => {
          provider = next;
          return selection();
        },
        doubaoGet: async () => doubaoConfig(),
        doubaoSave: async (input: DoubaoVoiceInput): Promise<DoubaoVoiceConfig> => {
          doubao = {
            appId: input.appId,
            resourceId: input.resourceId,
            token: input.accessToken !== undefined && input.accessToken.trim() !== "" ? input.accessToken : doubao.token,
          };
          return doubaoConfig();
        },
        doubaoTest: async (input: DoubaoVoiceInput): Promise<VoiceResult> => {
          const draft: DoubaoVoiceConfig = {
            appId: input.appId,
            resourceId: input.resourceId,
            tokenMasked: input.accessToken !== undefined && input.accessToken.trim() !== "" ? mask(input.accessToken) : doubaoConfig().tokenMasked,
          };
          if (!isDoubaoConfigured(draft)) return { ok: false, reason: "not-configured" };
          return { ok: false, reason: "network", detail: "Preview fixture: no network request was made." };
        },
        stepfunGet: async () => stepfunConfig(),
        stepfunSave: async (input: StepfunVoiceInput): Promise<StepfunVoiceConfig> => {
          stepfunKey = input.apiKey !== undefined && input.apiKey.trim() !== "" ? input.apiKey : stepfunKey;
          return stepfunConfig();
        },
        stepfunTest: async (input: StepfunVoiceInput): Promise<VoiceResult> => {
          const masked = input.apiKey !== undefined && input.apiKey.trim() !== "" ? mask(input.apiKey) : stepfunConfig().apiKeyMasked;
          if (masked === null) return { ok: false, reason: "not-configured" };
          return { ok: false, reason: "network", detail: "Preview fixture: no network request was made." };
        },
        dictationStart: async () => { throw unsupported("voice.dictationStart (microphone is not available in the preview)"); },
        dictationAudio: () => undefined,
        dictationStop: async () => { throw unsupported("voice.dictationStop (no dictation session in the preview)"); },
        dictationCancel: async () => { throw unsupported("voice.dictationCancel (no dictation session in the preview)"); },
        onDictationEvent: (listener) => {
          void listener;
          return () => undefined;
        },
      });
    })(),
    intent: fixtureDomain("intent", {
      /** intent-lab 是宿主机上的另一个进程：预览恒报「连不上」，面板走生产的不可用态。 */
      health: async () => null,
      edges: async () => null,
    }),
    import: fixtureDomain("import", {
      /** 系统目录选择器：预览里等同用户取消。 */
      pickDirectory: async () => null,
    }),
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
      roots: async (req): Promise<FileRoot[]> => {
        const roots: FileRoot[] = [];
        if (req.sessionId !== null) {
          const meta = fixture.sessions.find((item) => item.id === req.sessionId);
          const path = `/fixtures/workbenches/${req.sessionId}`;
          roots.push({
            kind: "session",
            label: fileRootLabel("session", path, meta?.title ?? "", "This session"),
            path,
            exists: vfsGet(fixture, path)?.kind === "dir",
          });
        }
        const workspace = req.workspaceId === null ? null : fixture.workspaces.find((item) => item.id === req.workspaceId);
        const wsPath = workspace?.path ?? "/fixtures/Home";
        roots.push({
          kind: "workspace",
          label: fileRootLabel("workspace", wsPath, workspace?.name ?? "", "Home"),
          path: wsPath,
          exists: vfsGet(fixture, wsPath)?.kind === "dir",
        });
        if (req.extraWorkspaceId != null && req.extraWorkspaceId !== req.workspaceId) {
          const extra = fixture.workspaces.find((item) => item.id === req.extraWorkspaceId);
          if (extra !== undefined) {
            roots.push({
              kind: "workspace",
              label: fileRootLabel("workspace", extra.path, extra.name, extra.name),
              path: extra.path,
              exists: vfsGet(fixture, extra.path)?.kind === "dir",
            });
          }
        }
        return roots;
      },
      list: async (req) => {
        if (!req.dir.startsWith(req.root)) throw unsupported(`files.list outside root (${req.dir})`);
        return { dir: req.dir, entries: vfsList(fixture, req.dir) };
      },
      read: async (req): Promise<FilePreview> => {
        if (!req.dir.startsWith(req.root)) throw unsupported(`files.read outside root (${req.dir})`);
        const node = vfsGet(fixture, req.dir);
        if (node?.kind !== "file") throw new Error(`Preview fixture: ${req.dir} is not a file.`);
        if (node.image) return { kind: "image", mime: "image/png", base64: FIXTURE_PNG_BASE64, size: vfsFileSize(node), modifiedAt: node.modifiedAt };
        if (node.binary) return { kind: "binary", size: vfsFileSize(node), modifiedAt: node.modifiedAt };
        if (node.largeLog || node.text === null) return { kind: "large-text", size: vfsFileSize(node), modifiedAt: node.modifiedAt };
        return { kind: "text", text: node.text, size: node.text.length, modifiedAt: node.modifiedAt };
      },
      readPdf: async () => { throw unsupported("files.readPdf (no PDF bytes in the preview fixture)"); },
      lineIndex: async (req) => {
        const node = vfsGet(fixture, req.dir);
        if (node?.kind !== "file") throw new Error(`Preview fixture: ${req.dir} not found.`);
        if (node.largeLog) return { kind: "ok", indexId: `fixture-lines ${req.dir}`, totalLines: FIXTURE_LOG_TOTAL_LINES, size: vfsFileSize(node), modifiedAt: node.modifiedAt };
        if (node.binary || node.image) return { kind: "binary", size: vfsFileSize(node), modifiedAt: node.modifiedAt };
        const text = node.text ?? "";
        if (text === "") return { kind: "empty", size: 0, modifiedAt: node.modifiedAt };
        return { kind: "ok", indexId: `fixture-lines ${req.dir}`, totalLines: text.split("\n").length, size: text.length, modifiedAt: node.modifiedAt };
      },
      readLines: async ({ indexId, startLine, count }) => {
        const path = indexId.replace(/^fixture-lines /u, "");
        const node = vfsGet(fixture, path);
        if (node?.kind !== "file") return { kind: "expired" };
        const total = node.largeLog ? FIXTURE_LOG_TOTAL_LINES : (node.text ?? "").split("\n").length;
        const clampedStart = Math.max(0, Math.min(Math.floor(startLine), total));
        const clampedCount = Math.max(1, Math.min(Math.floor(count), PREVIEW_LINES_PER_READ));
        const available = Math.max(0, Math.min(clampedCount, total - clampedStart));
        const lines = node.largeLog
          ? Array.from({ length: available }, (_unused, index) => fixtureLogLine(clampedStart + index))
          : (node.text ?? "").split("\n").slice(clampedStart, clampedStart + available);
        return { kind: "text", lines, startLine: clampedStart, totalLines: total, size: vfsFileSize(node), modifiedAt: node.modifiedAt };
      },
      reveal: async () => { throw unsupported("files.reveal (no host file manager in the preview)"); },
      open: async () => { throw unsupported("files.open (no host file manager in the preview)"); },
      openInBrowser: async () => { throw unsupported("files.openInBrowser (no managed browser in the preview)"); },
      statKind: async (paths): Promise<FsEntryFact[]> => paths.map((path) => {
        const node = vfsGet(fixture, path);
        if (node === undefined) return { kind: null, size: null };
        return node.kind === "dir" ? { kind: "dir", size: null } : { kind: "file", size: vfsFileSize(node) };
      }),
      pickFolders: async () => null,
      cancelLineIndex: () => undefined,
    }),
    docs: fixtureDomain("docs", {
      list: async (req): Promise<DocListEntry[]> => {
        const root = req.workspaceId === null
          ? "/fixtures/Home"
          : fixture.workspaces.find((item) => item.id === req.workspaceId)?.path ?? `/fixtures/${req.workspaceId}`;
        return docEntriesOf(fixture, root);
      },
      read: async (req): Promise<DocFile> => {
        const node = vfsGet(fixture, req.path);
        if (node?.kind !== "file" || node.text === null) throw new Error(`${DOC_GONE}: ${req.path}`);
        return { text: node.text, hash: fixtureHash(node.text), modifiedAt: node.modifiedAt };
      },
      write: async (req): Promise<DocWriteResult> => {
        const node = vfsGet(fixture, req.path);
        if (node?.kind !== "file") throw new Error(`${DOC_GONE}: ${req.path}`);
        const current = node.text ?? "";
        if (fixtureHash(current) !== req.expectedHash) {
          return { ok: false, reason: "conflict", file: { text: current, hash: fixtureHash(current), modifiedAt: node.modifiedAt } };
        }
        node.text = req.text;
        node.modifiedAt = tick();
        return { ok: true, hash: fixtureHash(req.text), modifiedAt: node.modifiedAt };
      },
      create: async (req) => {
        const root = req.workspaceId === null
          ? "/fixtures/Home"
          : fixture.workspaces.find((item) => item.id === req.workspaceId)?.path ?? `/fixtures/${req.workspaceId}`;
        const base = req.kind === "slides" ? `${NEW_DECK_NAME}.slides.json` : `${NEW_DOC_NAME}.md`;
        let name = base;
        let suffix = 2;
        while (vfsGet(fixture, `${root}/${name}`) !== undefined) {
          name = base.replace(/(\.[^.]+)?$/u, ` ${suffix}$1`);
          suffix += 1;
        }
        const path = `${root}/${name}`;
        const text = req.kind === "slides" ? fixtureDeckText() : `# ${base.replace(/\.[^.]+$/u, "")}\n`;
        const at = tick();
        fixture.vfs.set(path, { kind: "file", text, image: false, binary: false, largeLog: false, modifiedAt: at });
        return { path, text, hash: fixtureHash(text), modifiedAt: at };
      },
      watch: async () => undefined,
      unwatch: async () => undefined,
      onChanged: (listener) => {
        void listener;
        return () => undefined;
      },
      saveAs: async () => { throw unsupported("docs.saveAs (no save dialog in the preview)"); },
      export: async () => { throw unsupported("docs.export (no print-to-PDF in the preview)"); },
      exportSlides: async () => { throw unsupported("docs.exportSlides (no export in the preview)"); },
      exportDoc: async () => { throw unsupported("docs.exportDoc (no export in the preview)"); },
      convertMarpDeck: async () => { throw unsupported("docs.convertMarpDeck (no file write in the preview)"); },
      insertImage: async () => { throw unsupported("docs.insertImage (no file copy in the preview)"); },
      addSlideAsset: async () => { throw unsupported("docs.addSlideAsset (no file write in the preview)"); },
      readSlideAsset: async () => { throw unsupported("docs.readSlideAsset (no slide assets in the preview)"); },
      resolveTargets: async (req) => req.items.map(() => null),
    }),
  };
  return new Proxy(root, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return unsupportedDomain(String(key));
    },
  }) as OrbitaApi;
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
