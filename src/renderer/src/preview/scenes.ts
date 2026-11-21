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
import type { JsonValue, TranscriptItem } from "../../../shared/transcript.ts";
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

/**
 * 跨天场景的「上次离开」：今天零点往前 5 小时 20 分（本地时区的昨天 18:40）。
 * typical 的主智能体停在这里，用户今天回来——验「接着上次」的恢复回答与每件活的自含摘要。
 */
export function yesterdayEvening(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() - 5 * HOUR - 20 * MINUTE;
}

/** 一次 update_goal / update_plan：助手消息里的调用块 + 落盘的工具结果（与真实转录同形，走生产归约器与账本） */
function bookkeeping(
  id: string,
  at: number,
  toolName: "update_goal" | "update_plan",
  input: { [key: string]: JsonValue },
  details: { [key: string]: JsonValue },
): { call: { type: "toolCall"; toolCallId: string; toolName: string; input: JsonValue }; result: SessionRecord } {
  return {
    call: { type: "toolCall", toolCallId: id, toolName, input },
    result: {
      id: `${id}-result`,
      role: "tool",
      toolCallId: id,
      toolName,
      input,
      content: [{ type: "text", text: toolName === "update_goal" ? "Goal recorded." : "Plan updated." }],
      details,
      status: "complete",
      isError: false,
      timestamp: at,
    },
  };
}

type PlanSeed = { [key: string]: JsonValue } & { text: string; status: string };

function planRecords(id: string, ask: string, at: number, items: PlanSeed[], answer: string): SessionRecord[] {
  const plan = bookkeeping(`${id}-plan-1`, at + 9_000, "update_plan", { items }, { plan: items });
  return [
    { id: `${id}-user-1`, role: "user", content: [{ type: "text", text: ask }], timestamp: at },
    assistant(`${id}-assistant-1`, at + 8_000, [{ type: "text", text: "I’ll lay out the steps first." }, plan.call], "toolUse"),
    plan.result,
    assistant(`${id}-assistant-2`, at + 30 * MINUTE, [{ type: "text", text: answer }]),
  ];
}

/**
 * 主智能体昨天那一段：用户一句话 → 定目标、列计划、派两件活 → 傍晚改计划（证据收齐、导航方式等你定）→ 收尾那句。
 * 全是结构化记录（update_goal / update_plan），恢复回答与进度面板都从这几条推，不另写一份摘要文本。
 */
function mainYesterday(id: string, start: number, leftAt: number): SessionRecord[] {
  const goal = bookkeeping(`${id}-goal-1`, start + 22_000, "update_goal", {
    goal: "Bring the session-navigation research into one place and decide how a child session opens",
    by: "user",
  }, { goal: "Bring the session-navigation research into one place and decide how a child session opens" });
  const firstPlan: PlanSeed[] = [
    { text: "Collect interface evidence", status: "in_progress" },
    { text: "Decide how a child session opens", status: "pending" },
    { text: "Write the navigation recommendation", status: "pending" },
  ];
  const plan1 = bookkeeping(`${id}-plan-1`, start + 23_000, "update_plan", { items: firstPlan }, { plan: firstPlan });
  const lastPlan: PlanSeed[] = [
    { text: "Collect interface evidence", status: "done" },
    { text: "Decide how a child session opens", status: "waiting", waitingFor: "your call" },
    { text: "Write the navigation recommendation", status: "pending" },
  ];
  const plan2 = bookkeeping(`${id}-plan-2`, leftAt - 2 * MINUTE, "update_plan", { items: lastPlan }, { plan: lastPlan });
  return [
    { id: `${id}-user-1`, role: "user", content: [{ type: "text", text: "Map the current work and bring the open questions into one place." }], timestamp: start },
    assistant(`${id}-assistant-1`, start + 20_000, [{ type: "text", text: "I’ll set the goal and split the work into two focused sessions." }, goal.call, plan1.call], "toolUse"),
    goal.result,
    plan1.result,
    assistant(`${id}-assistant-2`, leftAt - 3 * MINUTE, [{ type: "text", text: "The evidence is in. Updating the plan." }, plan2.call], "toolUse"),
    plan2.result,
    assistant(`${id}-assistant-3`, leftAt, [
      {
        type: "text",
        text: "Evidence is collected for light and Onyx, empty and full. One navigation decision is waiting for you: whether a child session replaces the main conversation or opens beside it.\n\n- Evidence: done\n- Navigation: waiting on your call\n- Recommendation: after that decision",
      },
    ]),
  ];
}

function msg(parentId: string, childId: string, step: string, from: "parent" | "child", kind: ChannelMessage["kind"], text: string, at: number, author: "model" | "user" = "model"): ChannelMessage {
  return { id: `${parentId}:${childId}:${step}`, from, author, kind, text, delivery: from === "parent" ? "steer" : "followUp", createdAt: at };
}

function typicalData(now: number): Pick<PreviewFixture, "workspaces" | "sessions" | "transcripts" | "channels" | "profiles"> {
  const workspaces = [
    workspace("ws-research", "Research atlas", now),
    workspace("ws-orbita", "Orbita", now),
    workspace("ws-writing", "Writing", now),
  ];
  // 跨天：主智能体昨天 17:05 开工、18:40 离开，今天还没说过话
  const leftAt = yesterdayEvening(now);
  const start = leftAt - 95 * MINUTE;
  const boss = meta({ id: "boss-research", title: "Research atlas", workspaceId: "ws-research", role: "main", createdAt: now - 40 * DAY, updatedAt: leftAt });
  const child = meta({ id: "session-research-map", title: "Compare session navigation", workspaceId: "ws-research", parentId: boss.id, createdAt: start + 2 * MINUTE, updatedAt: leftAt - 10 * MINUTE });
  const done = meta({ id: "session-research-evidence", title: "Collect interface evidence", workspaceId: "ws-research", parentId: boss.id, createdAt: start + 3 * MINUTE, updatedAt: start + 70 * MINUTE });
  const sketch = meta({ id: "session-research-sketch", title: "Sketch the first sidebar layout", workspaceId: "ws-research", createdAt: now - 6 * DAY, updatedAt: now - 5 * DAY });
  const task = meta({ id: "task-sidebar", title: "Refine the session navigation", workspaceId: null, createdAt: now - 3 * DAY, updatedAt: now - 22 * MINUTE, pinned: true });
  const orbitaBoss = meta({ id: "boss-orbita", title: "Orbita", workspaceId: "ws-orbita", role: "main", createdAt: now - 21 * DAY, updatedAt: now - 3 * HOUR });
  const archived = meta({ id: "task-archived", title: "Weekly reading digest", workspaceId: null, archived: true, createdAt: now - 12 * DAY, updatedAt: now - 9 * DAY });
  const sessions = [boss, child, done, sketch, task, orbitaBoss, archived];
  const transcripts = new Map<string, SessionRecord[]>([
    [boss.id, mainYesterday(boss.id, start, leftAt)],
    [child.id, planRecords(child.id, "Compare session navigation", start + 2 * MINUTE, [
      { text: "Read the current navigation", status: "done" },
      { text: "Compare replace and side-by-side", status: "done" },
      { text: "Write the recommendation", status: "pending" },
    ], "Replacing the main conversation preserves context; the parent remains one breadcrumb away. I need your call before writing the recommendation.")],
    [done.id, shortTranscript(done.id, "Collect interface evidence", "Collected representative light, dark, empty and populated states.", start + 3 * MINUTE)],
    [sketch.id, shortTranscript(sketch.id, "Sketch the first sidebar layout", "Drafted a sidebar with one row per workspace.", now - 6 * DAY)],
    [task.id, workTranscript(task.id, "Refine the session navigation without adding another panel.", "The existing parent and child conversation path is sufficient.", now - 3 * HOUR)],
    [orbitaBoss.id, shortTranscript(orbitaBoss.id, "Review the current shell", "The production shell is ready for a focused review.", now - 4 * HOUR)],
    [archived.id, shortTranscript(archived.id, "Weekly reading digest", "The digest is archived.", now - 12 * DAY)],
  ]);
  const channels: ChannelMessage[] = [
    msg(boss.id, child.id, "task", "parent", "task", "Compare two ways to open a child session: replace the main conversation, or open beside it. Recommend one.", start + 2 * MINUTE),
    msg(boss.id, child.id, "progress", "child", "progress", "Read the current navigation; replacing keeps the parent one breadcrumb away.", start + 40 * MINUTE),
    msg(boss.id, child.id, "question", "child", "question", "Should a child session replace the main conversation, or open beside it?", leftAt - 10 * MINUTE),
    msg(boss.id, done.id, "task", "parent", "task", "Collect light, dark, empty and full screenshots of the shell.", start + 3 * MINUTE),
    msg(boss.id, done.id, "question", "child", "question", "Should the evidence include the Onyx theme too?", start + 20 * MINUTE),
    msg(boss.id, done.id, "reply", "parent", "reply", "Yes, cover light and Onyx, both empty and full.", start + 30 * MINUTE, "user"),
    msg(boss.id, done.id, "done", "child", "done", "Collected light and Onyx shots for empty, typical and full.", start + 70 * MINUTE),
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
