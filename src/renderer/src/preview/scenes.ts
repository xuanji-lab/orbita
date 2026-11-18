import type { AgentStats, BuiltinProvider } from "../../../shared/agent-ipc.ts";
import type { ChannelMessage } from "../../../shared/channel.ts";
import type { MainAgentProfile } from "../../../shared/main-agent.ts";
import type { ProviderDto } from "../../../shared/provider.ts";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  THEME_PREFERENCES,
  parseSettings,
  type AppSettings,
  type Language,
  type ThemePreference,
} from "../../../shared/settings.ts";
import type { SessionMeta, SessionRecord } from "../../../shared/session.ts";
import type { TranscriptItem } from "../../../shared/transcript.ts";
import { dateKeysBack } from "../../../shared/usage.ts";
import type { UsageDayTotal } from "../../../shared/usage.ts";
import type { Workspace } from "../../../shared/workspace.ts";

/** 稳定场景 id：预览 URL 只认这三档，未知值退回 typical，不读本机数据。 */
export const PREVIEW_SCENE_IDS = ["empty", "typical", "full"] as const;
export type PreviewSceneId = (typeof PREVIEW_SCENE_IDS)[number];

export interface PreviewOptions {
  scene: PreviewSceneId;
  theme: ThemePreference;
  language: Language;
  /** 同一次加载里所有相对时间都从这个固定快照派生；测试可注入。 */
  now: number;
}

export interface PreviewFixture {
  options: PreviewOptions;
  settings: AppSettings;
  workspaces: Workspace[];
  sessions: SessionMeta[];
  transcripts: Map<string, SessionRecord[]>;
  channels: ChannelMessage[];
  profiles: Map<string, MainAgentProfile>;
  providers: ProviderDto[];
  builtins: BuiltinProvider[];
  usage: UsageDayTotal[];
}

export function isPreviewPath(pathname: string): boolean {
  return /(?:^|\/)preview\.html$/.test(pathname);
}

export function parsePreviewOptions(search: string, now: number = Date.now()): PreviewOptions {
  const query = new URLSearchParams(search);
  const rawScene = query.get("scene");
  const scene = (PREVIEW_SCENE_IDS as readonly string[]).includes(rawScene ?? "")
    ? (rawScene as PreviewSceneId)
    : "typical";
  const rawTheme = query.get("theme");
  const theme = (THEME_PREFERENCES as readonly string[]).includes(rawTheme ?? "")
    ? (rawTheme as ThemePreference)
    : "light";
  const rawLanguage = query.get("lang");
  const language = (LANGUAGES as readonly string[]).includes(rawLanguage ?? "")
    ? (rawLanguage as Language)
    : "en";
  return { scene, theme, language, now };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MODEL = { providerId: "kimi-coding", modelId: "k3.1-pro" } as const;

function stats(scale = 1): AgentStats {
  const input = Math.round(18_000 * scale);
  const output = Math.round(3_200 * scale);
  const cacheRead = Math.round(42_000 * scale);
  const cacheWrite = Math.round(4_800 * scale);
  return {
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cost: Number((0.083 * scale).toFixed(4)),
    contextUsage: { tokens: Math.round(31_000 * scale), contextWindow: 262_144, percent: Math.min(99, 12 * scale) },
  };
}

function workspace(id: string, name: string, now: number): Workspace {
  return { id, name, path: `/fixtures/${id}`, createdAt: now - 90 * DAY, attachedDirs: [] };
}

interface MetaSeed {
  id: string;
  title: string;
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  role?: "main";
  parentId?: string;
  archived?: boolean;
  unread?: { at: number; failed: boolean };
  pinned?: boolean;
}

function meta(seed: MetaSeed): SessionMeta {
  return {
    id: seed.id,
    title: seed.title,
    titleSource: seed.role === "main" || seed.parentId !== undefined ? "user" : "auto",
    cwd: seed.workspaceId === null ? "/fixtures/Home" : `/fixtures/${seed.workspaceId}`,
    workspaceId: seed.workspaceId,
    ...MODEL,
    thinkingLevel: "high",
    piSessionFile: `/fixtures/pi/${seed.id}.jsonl`,
    pinned: seed.pinned === true,
    archived: seed.archived === true,
    starred: false,
    unread: seed.unread ?? null,
    recentQueries: seed.role === "main" ? [] : [seed.title],
    stats: stats(seed.parentId === undefined ? 1 : 0.45),
    durable: { since: seed.createdAt },
    ...(seed.role === undefined ? {} : { role: seed.role }),
    ...(seed.parentId === undefined ? {} : { parentId: seed.parentId }),
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
  };
}

function assistant(
  id: string,
  at: number,
  content: Extract<TranscriptItem, { role: "assistant" }>["content"],
  stopReason: "stop" | "toolUse" = "stop",
): Extract<TranscriptItem, { role: "assistant" }> {
  return {
    id,
    role: "assistant",
    content,
    model: { provider: MODEL.providerId, id: MODEL.modelId },
    status: "complete",
    stopReason,
    timestamp: at,
  };
}

/** 真实块数组转录：思考、工具调用、工具结果与最终回答都走生产归约器。 */
function workTranscript(id: string, ask: string, answer: string, at: number): SessionRecord[] {
  const callId = `${id}-read-1`;
  return [
    { id: `${id}-user-1`, role: "user", content: [{ type: "text", text: ask }], timestamp: at },
    assistant(
      `${id}-assistant-1`,
      at + 8_000,
      [
        { type: "thinking", thinking: "I should inspect the existing navigation before changing the interaction." },
        { type: "text", text: "I’m checking the current shell and session state first." },
        {
          type: "toolCall",
          toolCallId: callId,
          toolName: "read",
          input: { path: "src/renderer/src/App.tsx" },
        },
      ],
      "toolUse",
    ),
    {
      id: `${id}-tool-1`,
      role: "tool",
      toolCallId: callId,
      toolName: "read",
      input: { path: "src/renderer/src/App.tsx" },
      content: [{ type: "text", text: "export function App() {\n  // production shell fixture excerpt\n}" }],
      status: "complete",
      isError: false,
      timestamp: at + 11_000,
    },
    assistant(`${id}-assistant-2`, at + 19_000, [
      {
        type: "text",
        text: `${answer}\n\n- Reused the production session state\n- Kept the existing composer and toolbar\n- Verified the return path`,
      },
    ]),
  ];
}

function shortTranscript(id: string, ask: string, answer: string, at: number): SessionRecord[] {
  return [
    { id: `${id}-user-1`, role: "user", content: [{ type: "text", text: ask }], timestamp: at },
    assistant(`${id}-assistant-1`, at + 6_000, [{ type: "text", text: answer }]),
  ];
}

/** 归档会话按需生成两条记录，full 场景不必在启动时常驻近两千份转录。 */
export function fallbackTranscript(item: SessionMeta): SessionRecord[] {
  return shortTranscript(item.id, item.title || "Review the earlier task", "The fixture result is ready to inspect.", item.createdAt);
}

function channel(
  parentId: string,
  childId: string,
  at: number,
  last: "question" | "done" | "progress",
  suffix = "",
): ChannelMessage[] {
  const base = `${parentId}:${childId}${suffix}`;
  const messages: ChannelMessage[] = [
    {
      id: `${base}:task`,
      from: "parent",
      author: "model",
      kind: "task",
      text: "Inspect the existing flow and report a focused recommendation.",
      delivery: "steer",
      createdAt: at,
    },
    {
      id: `${base}:progress`,
      from: "child",
      author: "model",
      kind: "progress",
      text: "I found the production path and am checking the edge cases.",
      delivery: "followUp",
      createdAt: at + 4 * MINUTE,
    },
  ];
  if (last !== "progress") {
    messages.push({
      id: `${base}:${last}`,
      from: "child",
      author: "model",
      kind: last,
      text:
        last === "question"
          ? "Should the child session replace the main conversation, or open beside it?"
          : "The comparison is complete; the recommended path preserves the parent transcript.",
      delivery: "followUp",
      createdAt: at + 9 * MINUTE,
    });
  }
  return messages;
}

function providers(): ProviderDto[] {
  return [
    {
      id: "kimi-coding",
      kind: "kimi-coding",
      displayName: "Kimi Code",
      endpoint: { baseUrl: "https://fixture.invalid/anthropic", api: "anthropic-messages" },
      auth: { scheme: "api_key", hasSecret: true, masked: "fix…ture" },
      models: {
        declared: [
          { id: "k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 262_144, maxTokens: 32_768, vision: true },
          { id: "kimi-for-coding", name: "Kimi K2.8 Preview", contextWindow: 1_048_576, maxTokens: 65_536 },
        ],
      },
    },
    {
      id: "zai-coding-cn",
      kind: "zai-coding-cn",
      displayName: "Zhipu Coding Plan",
      endpoint: { baseUrl: "https://fixture.invalid/paas/v4", api: "openai-completions" },
      auth: { scheme: "api_key", hasSecret: true, masked: "fix…ture" },
      models: {
        declared: [
          { id: "glm-5.3", name: "GLM 5.3", contextWindow: 1_048_576, maxTokens: 131_072 },
          { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_048_576, maxTokens: 131_072 },
        ],
      },
    },
    {
      id: "deepseek",
      kind: "deepseek",
      displayName: "DeepSeek",
      endpoint: { baseUrl: "https://fixture.invalid/v1", api: "openai-completions" },
      auth: { scheme: "api_key", hasSecret: false, masked: null },
      models: { declared: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] },
    },
  ];
}

function builtins(): BuiltinProvider[] {
  const model = (id: string, name: string, contextWindow: number): BuiltinProvider["models"][number] => ({
    id,
    name,
    contextWindow,
    maxTokens: 32_768,
    input: ["text", "image"],
    reasoning: true,
    supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
  });
  return [
    {
      id: "kimi-coding",
      name: "Kimi Code",
      baseUrl: "https://fixture.invalid/anthropic",
      api: "anthropic-messages",
      models: [model("k3.1-pro", "Kimi K3.1 Pro", 262_144), model("kimi-for-coding", "Kimi K2.8 Preview", 1_048_576)],
    },
    {
      id: "zai-coding-cn",
      name: "Zhipu Coding Plan",
      baseUrl: "https://fixture.invalid/paas/v4",
      api: "openai-completions",
      models: [model("glm-5.3", "GLM 5.3", 1_048_576), model("glm-5.3-flash", "GLM 5.3 Flash", 1_048_576)],
    },
  ];
}

function usage(scene: PreviewSceneId, now: number): UsageDayTotal[] {
  const amounts = scene === "empty" ? [0, 0, 0, 0, 0, 0, 0] : scene === "full"
    ? [84_000, 392_000, 1_240_000, 620_000, 2_480_000, 1_720_000, 936_000]
    : [0, 42_000, 180_000, 96_000, 360_000, 720_000, 280_000];
  return dateKeysBack(7, now).map((date, index) => {
    const tokens = amounts[index] ?? 0;
    const secondary = Math.round(tokens * 0.28);
    return {
      date,
      tokens,
      models: tokens === 0 ? [] : [
        {
          modelId: "k3.1-pro",
          name: "Kimi K3.1 Pro",
          vendor: { kindId: "kimi-coding", label: "Kimi Code" },
          tokens: tokens - secondary,
        },
        {
          modelId: "glm-5.3",
          name: "GLM 5.3",
          vendor: { kindId: "zai-coding-cn", label: "Zhipu" },
          tokens: secondary,
        },
      ],
      intentTokens: 0,
      cost: tokens === 0 ? null : { usd: Number((tokens / 1_000_000 * 1.84).toFixed(3)), partial: false },
    };
  });
}

function typicalData(now: number): Pick<PreviewFixture, "workspaces" | "sessions" | "transcripts" | "channels" | "profiles"> {
  const workspaces = [
    workspace("ws-research", "Research atlas", now),
    workspace("ws-orbita", "Orbita", now),
    workspace("ws-writing", "Writing", now),
  ];
  const boss = meta({ id: "boss-research", title: "Research atlas", workspaceId: "ws-research", role: "main", createdAt: now - 40 * DAY, updatedAt: now - 12 * MINUTE });
  const child = meta({ id: "session-research-map", title: "Compare session navigation", workspaceId: "ws-research", parentId: boss.id, createdAt: now - 2 * HOUR, updatedAt: now - 8 * MINUTE });
  const done = meta({ id: "session-research-evidence", title: "Collect interface evidence", workspaceId: "ws-research", parentId: boss.id, createdAt: now - 5 * HOUR, updatedAt: now - 38 * MINUTE });
  const task = meta({ id: "task-sidebar", title: "Refine the session navigation", workspaceId: null, createdAt: now - 3 * DAY, updatedAt: now - 22 * MINUTE, pinned: true });
  const orbitaBoss = meta({ id: "boss-orbita", title: "Orbita", workspaceId: "ws-orbita", role: "main", createdAt: now - 21 * DAY, updatedAt: now - 3 * HOUR });
  const archived = meta({ id: "task-archived", title: "Weekly reading digest", workspaceId: null, archived: true, createdAt: now - 12 * DAY, updatedAt: now - 9 * DAY });
  const sessions = [boss, child, done, task, orbitaBoss, archived];
  const transcripts = new Map<string, SessionRecord[]>([
    [boss.id, workTranscript(boss.id, "Map the current work and bring the open questions into one place.", "I split the comparison and evidence collection into focused sessions. One navigation decision is waiting for you.", now - 2 * HOUR)],
    [child.id, workTranscript(child.id, "Compare session navigation", "Replacing the main conversation preserves context; the parent remains one breadcrumb away.", now - 2 * HOUR + MINUTE)],
    [done.id, shortTranscript(done.id, "Collect interface evidence", "Collected representative light, dark, empty and populated states.", now - 5 * HOUR)],
    [task.id, workTranscript(task.id, "Refine the session navigation without adding another panel.", "The existing parent and child conversation path is sufficient.", now - 3 * HOUR)],
    [orbitaBoss.id, shortTranscript(orbitaBoss.id, "Review the current shell", "The production shell is ready for a focused review.", now - 4 * HOUR)],
    [archived.id, shortTranscript(archived.id, "Weekly reading digest", "The digest is archived.", now - 12 * DAY)],
  ]);
  const channels = [
    ...channel(boss.id, child.id, now - 2 * HOUR, "question"),
    ...channel(boss.id, done.id, now - 5 * HOUR, "done"),
  ];
  const profiles = new Map<string, MainAgentProfile>([
    ["ws-research", { workspaceId: "ws-research", sessionId: boss.id, createdAt: boss.createdAt, model: { ...MODEL, thinkingLevel: "high" } }],
    ["ws-orbita", { workspaceId: "ws-orbita", sessionId: orbitaBoss.id, createdAt: orbitaBoss.createdAt }],
  ]);
  return { workspaces, sessions, transcripts, channels, profiles };
}

function fullData(now: number): Pick<PreviewFixture, "workspaces" | "sessions" | "transcripts" | "channels" | "profiles"> {
  const base = typicalData(now);
  const names = ["Design system", "Literature", "Automation", "Mobile", "Thesis", "Data pipeline", "Personal", "Release", "Windows"];
  const extraWorkspaces = names.map((name, index) => workspace(`ws-full-${index + 1}`, name, now));
  const workspaces = [...base.workspaces, ...extraWorkspaces];
  const sessions = [...base.sessions];
  const transcripts = new Map(base.transcripts);
  const channels = [...base.channels];
  const profiles = new Map(base.profiles);

  for (const item of extraWorkspaces) {
    const main = meta({ id: `boss-${item.id}`, title: item.name, workspaceId: item.id, role: "main", createdAt: now - 60 * DAY, updatedAt: now - DAY });
    sessions.push(main);
    profiles.set(item.id, { workspaceId: item.id, sessionId: main.id, createdAt: main.createdAt });
  }
  // 当前工作区一晚十几件活，右栏 40 件派出去的执行上下文。
  for (let index = 0; index < 38; index += 1) {
    const id = `session-full-${String(index + 1).padStart(2, "0")}`;
    const child = meta({ id, title: `Investigate workflow branch ${index + 1}`, workspaceId: "ws-research", parentId: "boss-research", createdAt: now - (index + 4) * HOUR, updatedAt: now - (index + 2) * 7 * MINUTE });
    sessions.push(child);
    channels.push(...channel("boss-research", id, child.createdAt, index % 5 === 0 ? "question" : index % 3 === 0 ? "progress" : "done", ":full"));
  }
  // 近两千条旧会话只加载 meta；打开某条时才按 id 生成确定性的两条转录。
  for (let index = 0; index < 1_800; index += 1) {
    const owner = workspaces[index % workspaces.length]?.id ?? null;
    sessions.push(meta({
      id: `archive-${String(index + 1).padStart(4, "0")}`,
      title: `Archived investigation ${String(index + 1).padStart(4, "0")} — source comparison and verification`,
      workspaceId: owner,
      archived: true,
      createdAt: now - (200 - Math.floor(index / 12)) * DAY,
      updatedAt: now - (190 - Math.floor(index / 12)) * DAY,
    }));
  }
  // 平常列表也有足够的未归档任务，覆盖分组、折叠与省略。
  for (let index = 0; index < 120; index += 1) {
    const owner = workspaces[index % workspaces.length]?.id ?? null;
    sessions.push(meta({
      id: `active-${String(index + 1).padStart(3, "0")}`,
      title: `Active workstream ${index + 1}: validate the production interaction path`,
      workspaceId: owner,
      createdAt: now - (index + 2) * 3 * HOUR,
      updatedAt: now - (index + 1) * 11 * MINUTE,
      unread: index < 5 ? { at: now - index * MINUTE, failed: index === 4 } : undefined,
    }));
  }
  return { workspaces, sessions, transcripts, channels, profiles };
}

export function buildPreviewFixture(options: PreviewOptions): PreviewFixture {
  const data = options.scene === "empty"
    ? { workspaces: [], sessions: [], transcripts: new Map<string, SessionRecord[]>(), channels: [], profiles: new Map<string, MainAgentProfile>() }
    : options.scene === "full"
      ? fullData(options.now)
      : typicalData(options.now);
  const availableProviders = options.scene === "empty" ? [] : providers();
  const settings = parseSettings({
    ...DEFAULT_SETTINGS,
    theme: options.theme,
    language: options.language,
    onboardingSeen: true,
    completionSound: false,
    processView: "turn",
    ...(availableProviders.length === 0 ? {} : { lastUsed: MODEL }),
  });
  return {
    options,
    settings,
    ...data,
    providers: availableProviders,
    builtins: options.scene === "empty" ? [] : builtins(),
    usage: usage(options.scene, options.now),
  };
}
