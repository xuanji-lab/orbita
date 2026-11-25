import type { AgentStats, BuiltinProvider } from "../../../shared/agent-ipc.ts";
import type { ChannelMessage } from "../../../shared/channel.ts";
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
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { MOBILE_NOW, mobileChat, mobileList, type MobileChat, type MobileSession } from "./mobile/fixture.ts";
import { dateKeysBack } from "../../../shared/usage.ts";
import type { UsageDayTotal } from "../../../shared/usage.ts";
import type { Workspace } from "../../../shared/workspace.ts";
import type { Automation } from "../../../shared/automation.ts";
import type { ExcerptItem } from "../../../shared/excerpt.ts";
import type { FocusChanges } from "../../../shared/focus.ts";
import type { PluginView } from "../../../shared/plugin.ts";
import type { BoardWeekResponse, BoardWeekDay } from "../../../shared/plugin-board.ts";
import type { MemoryEntryView, MemoryEvolutionNode, MemoryScopeSummary, MemorySessionView, MemorySource, MemoryStatus } from "../../../shared/memory.ts";
import type { ReviewDiff, ReviewList, ReviewSource } from "../../../shared/review.ts";
import type { SkillMeta } from "../../../shared/skill.ts";
import type { McpListResult } from "../../../shared/mcp.ts";
import type { PluginDraftEntry } from "../../../shared/plugin.ts";
import { localWeekStart, localDayStart } from "../../../shared/plugin-board.ts";

/** 稳定场景 id：预览 URL 只认这三档，未知值退回 typical，不读本机数据。 */
export const PREVIEW_SCENE_IDS = ["empty", "typical", "full"] as const;
export type PreviewSceneId = (typeof PREVIEW_SCENE_IDS)[number];

export interface PreviewOptions {
  scene: PreviewSceneId;
  theme: ThemePreference;
  language: Language;
  /** 同一次加载里所有相对时间都从这个固定快照派生；测试可注入。 */
  now: number;
  /** 为 true 时首启引导自动弹出（?onboarding=1），复用生产 shouldAutoOpenOnboarding 路径。 */
  onboarding: boolean;
  /**
   * ?mirror=mobile：把手机端设计稿的同一批任务（同标题、同状态、同转录）混进桌面 fixture，
   * 手机稿旁边的同屏对照才有亮着的状态饼与满载对话可比。只加不改，其余 fixture 原样。
   */
  mirror: boolean;
}

/** 虚拟文件树节点：text/image/binary/largeLog 四态覆盖文件面板全部预览路径。 */
export type VfsNode =
  | { kind: "dir"; children: Map<string, VfsNode> }
  | {
      kind: "file";
      text: string | null;
      image: boolean;
      binary: boolean;
      largeLog: boolean;
      modifiedAt: number;
      /** 图片节点的真实内容：同源 public/ 下的一张 PNG（缺席 = 1×1 占位）。手机设计稿里对话中的截图用它 */
      url?: string;
    };

export interface PreviewReviewSet {
  lists: Record<ReviewSource, ReviewList>;
  /** key = `${source} ${path}`，diff 按需拉 */
  diffs: Map<string, ReviewDiff>;
}

export interface PreviewMemorySet {
  scopes: MemoryScopeSummary[];
  views: MemoryEntryView[];
  sessionViews: Map<string, MemorySessionView>;
}

export interface PreviewPluginsSet {
  plugins: PluginView[];
  skills: SkillMeta[];
  mcp: McpListResult;
  drafts: PluginDraftEntry[];
  draftView: PluginView | null;
}

/** 主智能体还没进 main：fixture 只留工作区到「主会话」的映射，供 typical / full 的会话排布用。 */
export interface PreviewMainProfile {
  workspaceId: string;
  sessionId: string;
  createdAt: number;
}

export interface PreviewFixture {
  options: PreviewOptions;
  settings: AppSettings;
  workspaces: Workspace[];
  sessions: SessionMeta[];
  transcripts: Map<string, SessionRecord[]>;
  channels: ChannelMessage[];
  profiles: Map<string, PreviewMainProfile>;
  providers: ProviderDto[];
  builtins: BuiltinProvider[];
  usage: UsageDayTotal[];
  /** 绝对路径 → 节点；目录与文件都进表，fixture-api 直接查。 */
  vfs: Map<string, VfsNode>;
  review: PreviewReviewSet;
  excerpts: ExcerptItem[];
  memory: PreviewMemorySet;
  automations: Automation[];
  plugins: PreviewPluginsSet;
  board: BoardWeekResponse;
  focusChanges: FocusChanges;
  /** 开场就该亮着的会话：fixture-api 在第一个 agent 监听者挂上后发 phase / permission 事件点亮它们 */
  live: { running: string[]; waiting: string[] };
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
  const rawOnboarding = query.get("onboarding");
  return {
    scene,
    theme,
    language,
    now,
    onboarding: rawOnboarding === "1" || rawOnboarding === "true",
    mirror: query.get("mirror") === "mobile",
  };
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
    mode: "skip",
    thinkingLevel: "high",
    piSessionFile: `/fixtures/pi/${seed.id}.jsonl`,
    pinned: seed.pinned === true,
    archived: seed.archived === true,
    starred: false,
    unread: seed.unread ?? null,
    recentQueries: seed.role === "main" ? [] : [seed.title],
    stats: stats(seed.parentId === undefined ? 1 : 0.45),
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

/** 组1素材：虚拟文件树。字符串=文本文件；三个标记分别走图片/二进制/大文本分段预览。 */
type TreeSpec = { [name: string]: TreeSpec | string | { image: true; url?: string } | { binary: true } | { largeLog: true } };

function addTree(vfs: Map<string, VfsNode>, base: string, spec: TreeSpec, now: number): void {
  const existing = vfs.get(base);
  const dir: VfsNode = existing ?? { kind: "dir", children: new Map() };
  vfs.set(base, dir);
  if (dir.kind !== "dir") return;
  for (const [name, value] of Object.entries(spec)) {
    const path = `${base}/${name}`;
    const at = now - ((name.length * 37) % (9 * DAY));
    if (typeof value === "string") {
      vfs.set(path, { kind: "file", text: value, image: false, binary: false, largeLog: false, modifiedAt: at });
    } else if ("image" in value) {
      vfs.set(path, {
        kind: "file", text: null, image: true, binary: false, largeLog: false, modifiedAt: at,
        ...(typeof value.url === "string" ? { url: value.url } : {}),
      });
    } else if ("binary" in value) {
      vfs.set(path, { kind: "file", text: null, image: false, binary: true, largeLog: false, modifiedAt: at });
    } else if ("largeLog" in value) {
      vfs.set(path, { kind: "file", text: null, image: false, binary: false, largeLog: true, modifiedAt: at });
    } else {
      addTree(vfs, path, value, now);
    }
  }
}

/** 工作区树：覆盖 md 预览 / 代码 / 图片 / 二进制 / 大日志分段 / 文档列表（.md 与 .slides.json）。 */
function workspaceTree(): TreeSpec {
  return {
    "README.md": "# Research atlas\n\nFixture workspace for the deterministic preview.\n",
    "meeting-notes.md": "# Meeting notes\n\n- Preview fixtures stay deterministic.\n- Paper themes ship with the design system.\n",
    "pitch.slides.json": fixtureDeckText(),
    src: {
      "app.ts": "export function appFixture() {\n  // deterministic preview source\n  return \"fixture\";\n}\n",
      "styles.css": ":root {\n  --fixture: 1;\n}\n",
    },
    docs: { "plan.md": "# Plan\n\n1. Open the preview.\n2. Click every surface once.\n" },
    assets: { "logo.png": { image: true }, "archive.zip": { binary: true } },
    // 手机端设计稿的对话里引用的截图（桌面预览自己截的一张，放在 public/preview-fixtures/）
    shots: { "desktop-home.png": { image: true, url: "/preview-fixtures/desktop-home.png" } },
    data: { "dump.csv": "id,name\n1,fixture\n", "server.log": { largeLog: true } },
    scratch: { "rewrite.md": "# Rewrite\n\nLong draft with too many lines to preview inline.\n", "notes.md": "# Notes\n\nRestored to the task baseline.\n" },
  };
}

/** 演示文稿面板的 fixture deck：两页文本元素，走 SlidesView 的生产渲染管线。 */
export function fixtureDeckText(): string {
  const text = (id: string, x: number, y: number, w: number, h: number, html: string, fontSize: number, color: string) => ({
    id, kind: "text", x, y, w, h, html, fontSize, color, align: "left", valign: "top",
  });
  return JSON.stringify({
    version: 1,
    title: "Fixture deck",
    aspect: "16:9",
    slides: [
      { id: "s1", layout: "cover", elements: [
        text("e1", 72, 96, 800, 72, "Fixture deck", 48, "var(--color-text-primary)"),
        text("e2", 72, 190, 800, 60, "Deterministic slides preview — no host file was read", 22, "var(--color-text-secondary)"),
      ] },
      { id: "s2", layout: "bullets", elements: [
        text("e1", 72, 80, 800, 56, "What the preview proves", 34, "var(--color-text-primary)"),
        text("e2", 96, 170, 780, 300, "<ul><li>The slides canvas mounts from a fixture deck</li><li>Stage and filmstrip stay in sync</li><li>Export stays visibly unconnected</li></ul>", 22, "var(--color-text-primary)"),
      ] },
    ],
  });
}

function buildVfs(scene: PreviewSceneId, now: number): Map<string, VfsNode> {
  const vfs = new Map<string, VfsNode>();
  vfs.set("/fixtures/Home", { kind: "dir", children: new Map() });
  if (scene === "empty") return vfs;
  addTree(vfs, "/fixtures/Home", { "todo.md": "# Home\n\n- [ ] Review the preview coverage report\n" }, now);
  for (const id of ["ws-research", "ws-orbita", "ws-writing"]) {
    addTree(vfs, `/fixtures/${id}`, workspaceTree(), now);
  }
  // 每个真实 fixture 会话一个工作台树（boss 与普通会话同模板，路径按会话 id 派生）。
  for (const id of ["boss-research", "boss-orbita", "session-research-map", "session-research-evidence", "task-sidebar"]) {
    addTree(vfs, `/fixtures/workbenches/${id}`, {
      "notes.md": "# Session notes\n\nScratch space owned by this fixture session.\n",
      output: { "diff-summary.txt": "2 files changed, 14 insertions(+), 3 deletions(-)\n" },
    }, now);
  }
  return vfs;
}

/** 大日志 fixture 的行生成：确定性的 5,000 行，lineIndex/readLines 按窗取。 */
export const FIXTURE_LOG_TOTAL_LINES = 5000;
export function fixtureLogLine(index: number): string {
  return `2026-11-${String(10 + (index % 9)).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z fixture log line ${String(index + 1).padStart(5, "0")} — deterministic preview content`;
}

// ——————————— 组2素材：审查 / 摘抄 / 记忆 / 自动化 ———————————

const APP_DIFF_TEXT = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,6 @@",
  " export function appFixture() {",
  "-  return \"old\";",
  "+  // deterministic preview source",
  "+  const ready = true;",
  "+  return ready ? \"fixture\" : \"old\";",
  " }",
].join("\n");

const PLAN_DIFF_TEXT = [
  "--- a/docs/plan.md",
  "+++ b/docs/plan.md",
  "@@ -1,3 +1,4 @@",
  " # Plan",
  " ",
  " 1. Open the preview.",
  "+2. Click every surface once.",
].join("\n");

function buildReview(scene: PreviewSceneId): PreviewReviewSet {
  const cwd = "/fixtures/ws-research";
  if (scene === "empty") {
    return {
      lists: {
        task: { kind: "empty", reason: "no-changes", cwd },
        unstaged: { kind: "empty", reason: "not-repo", cwd },
        staged: { kind: "empty", reason: "not-repo", cwd },
        branch: { kind: "empty", reason: "not-repo", cwd },
      },
      diffs: new Map(),
    };
  }
  const task: ReviewList = {
    kind: "ok",
    cwd,
    entries: [
      { path: `${cwd}/src/app.ts`, added: 3, removed: 1, binary: false },
      { path: `${cwd}/docs/plan.md`, added: 1, removed: 0, binary: false },
      { path: `${cwd}/assets/logo.png`, added: 0, removed: 0, binary: true },
      { path: `${cwd}/scratch/rewrite.md`, added: 18, removed: 6, binary: false },
      { path: `${cwd}/scratch/notes.md`, added: 0, removed: 0, binary: false, restored: true },
      { path: `${cwd}/link.md`, added: 0, removed: 0, binary: false, symlink: "meeting-notes.md" },
    ],
  };
  const unstaged: ReviewList = {
    kind: "ok",
    cwd,
    entries: [
      { path: "src/app.ts", added: 3, removed: 1, binary: false },
      { path: "README.md", added: 0, removed: 0, binary: false, lineCountUnknown: true },
      { path: "dist/bundle.js", added: 0, removed: 0, binary: true },
    ],
  };
  const staged: ReviewList = {
    kind: "ok",
    cwd,
    entries: [{ path: "docs/plan.md", added: 1, removed: 0, binary: false }],
  };
  const branch: ReviewList = {
    kind: "ok",
    cwd,
    upstream: "origin/main",
    entries: [
      { path: "src/app.ts", added: 3, removed: 1, binary: false },
      { path: "src/legacy.ts", added: 0, removed: 20, binary: false },
    ],
  };
  const diffs = new Map<string, ReviewDiff>([
    [`task ${cwd}/src/app.ts`, { diff: APP_DIFF_TEXT, binary: false, restored: false }],
    [`task ${cwd}/docs/plan.md`, { diff: PLAN_DIFF_TEXT, binary: false, restored: false }],
    [`task ${cwd}/assets/logo.png`, { diff: null, binary: true, restored: false }],
    [`task ${cwd}/scratch/rewrite.md`, { diff: null, binary: false, restored: false, tooLarge: { exceeded: "lines", message: "Fixture diff exceeds REVIEW_DIFF_MAX_LINES; no patch was generated." } }],
    [`task ${cwd}/scratch/notes.md`, { diff: null, binary: false, restored: true }],
    [`task ${cwd}/link.md`, { diff: null, binary: false, restored: false, symlink: "meeting-notes.md" }],
    ["unstaged src/app.ts", { diff: APP_DIFF_TEXT, binary: false, restored: false }],
    ["unstaged README.md", { diff: null, binary: false, restored: false, error: { reason: "failed", message: "Fixture: line count unknown, diff not generated." } }],
    ["unstaged dist/bundle.js", { diff: null, binary: true, restored: false }],
    ["staged docs/plan.md", { diff: PLAN_DIFF_TEXT, binary: false, restored: false }],
    ["branch src/app.ts", { diff: APP_DIFF_TEXT, binary: false, restored: false }],
    ["branch src/legacy.ts", { diff: null, binary: false, restored: false, error: { reason: "failed", message: "Fixture: baseline blob missing." } }],
  ]);
  return { lists: { task, unstaged, staged, branch }, diffs };
}

function buildExcerpts(now: number): ExcerptItem[] {
  return [
    {
      excerpt: { id: "exc-fixture-1", text: "The existing parent and child conversation path is sufficient.", sessionId: "task-sidebar", turn: 1, role: "assistant", createdAt: now - 3 * DAY },
      sessionTitle: "Refine the session navigation",
    },
    {
      excerpt: { id: "exc-fixture-2", text: "Replacing the main conversation preserves context; the parent remains one breadcrumb away.", sessionId: "session-research-map", turn: 1, role: "assistant", createdAt: now - 2 * DAY },
      sessionTitle: "Compare session navigation",
    },
    {
      excerpt: { id: "exc-fixture-3", text: "Map the current work and bring the open questions into one place.", sessionId: "boss-research", turn: 1, role: "user", createdAt: now - 2 * DAY },
      sessionTitle: "Research atlas",
    },
  ];
}

function buildMemory(scene: PreviewSceneId, now: number): PreviewMemorySet {
  const scopes: MemoryScopeSummary[] = [
    { token: "user", kind: "user", name: "All workspaces", count: scene === "empty" ? 0 : 2 },
    { token: "ws-research", kind: "workspace", name: "Research atlas", count: scene === "empty" ? 0 : 2 },
  ];
  if (scene === "empty") return { scopes, views: [], sessionViews: new Map() };
  const oldEntry = {
    id: "mem-fixture-old", type: "preference" as const,
    text: "The user likes summaries written in English with bullet points.",
    keywords: ["summary", "english"], layer: "user" as const, sessionId: "task-sidebar", turns: [1], at: now - 20 * DAY,
    episodeId: "ep-fixture-1", source: "chat" as const, status: "stale" as const,
  };
  const newEntry = {
    id: "mem-fixture-new", type: "preference" as const,
    text: "The user prefers concise Chinese summaries with evidence paths.",
    reason: "User asked twice for 中文要点 with file references.",
    keywords: ["summary", "chinese", "evidence"], layer: "user" as const, sessionId: "task-sidebar", turns: [2], at: now - 3 * DAY,
    episodeId: "ep-fixture-2", source: "agent" as const, conflictWith: "mem-fixture-old",
  };
  const wsEntry = {
    id: "mem-fixture-ws", type: "insight" as const,
    text: "Session navigation comparisons should keep the parent one breadcrumb away.",
    keywords: ["navigation", "parent"], layer: "workspace" as const, scopeId: "ws-research", sessionId: "session-research-map", turns: [1], at: now - 2 * DAY,
    episodeId: "ep-fixture-3", source: "chat" as const,
  };
  const factEntry = {
    id: "mem-fixture-fact", type: "fact" as const,
    text: "The user reviews plugin boards every Friday afternoon.",
    keywords: ["board", "friday"], layer: "user" as const, sessionId: "task-sidebar", turns: [3], at: now - DAY,
    episodeId: "ep-fixture-4", source: "manual" as const,
  };
  const evolutionNode = (entry: { id: string; text: string; at: number; source: MemorySource; status?: MemoryStatus }): MemoryEvolutionNode => ({ id: entry.id, text: entry.text, at: entry.at, status: entry.status, source: entry.source });
  const views: MemoryEntryView[] = [
    { entry: newEntry, token: "user", sessionTitle: "Refine the session navigation", quote: "换成中文要点，带上文件出处", evolution: [evolutionNode(oldEntry), evolutionNode(newEntry)], usage: { count: 4, lastAt: now - 5 * HOUR } },
    { entry: oldEntry, token: "user", sessionTitle: "Refine the session navigation", quote: "give me bullet points", evolution: [evolutionNode(oldEntry), evolutionNode(newEntry)], usage: { count: 0, lastAt: null } },
    { entry: factEntry, token: "user", sessionTitle: null, quote: null, evolution: [], usage: { count: 1, lastAt: now - DAY } },
    { entry: wsEntry, token: "ws-research", sessionTitle: "Compare session navigation", quote: "compare the navigation options", evolution: [], usage: { count: 2, lastAt: now - 8 * HOUR } },
  ];
  const turnView = (turn: number, at: number, used: MemorySessionView["turns"][number]["used"], remembered: MemoryEntryView[]): MemorySessionView["turns"][number] => ({ turn, at, used, remembered });
  const sessionViews = new Map<string, MemorySessionView>([
    ["task-sidebar", {
      sessionId: "task-sidebar", token: "user",
      turns: [
        turnView(2, now - 3 * DAY, [{ id: "mem-fixture-new", text: newEntry.text, score: 0.82 }], [views[0] as MemoryEntryView]),
        turnView(3, now - DAY, [], [views[2] as MemoryEntryView]),
      ],
    }],
  ]);
  return { scopes, views, sessionViews };
}

function buildAutomations(scene: PreviewSceneId, now: number): Automation[] {
  if (scene === "empty") return [];
  return [
    {
      id: "auto-fixture-digest",
      title: "Daily literature digest",
      prompt: "Check the literature watchlist and queue the four most reproducible papers.",
      schedule: { kind: "daily", time: "09:00" },
      target: { kind: "new_session", workspaceId: "ws-research" },
      plugin: { name: "reading" },
      mode: "skip",
      status: "active",
      createdBy: { kind: "user" },
      nextRunAt: now + 4 * HOUR,
      runs: [
        { id: "run-digest-2", runAt: now - 26 * HOUR, trigger: "schedule", status: "success", sessionId: "auto-digest-2", durationMs: 95_000, tokens: 84_000, resultExcerpt: "4 papers queued; attention routing looks most reproducible.", boardSnapshotIds: ["call-digest-2a"] },
        { id: "run-digest-1", runAt: now - 50 * HOUR, trigger: "schedule", status: "skipped", sessionId: null, durationMs: null, tokens: null, skipReason: "overlap", repeat: 2 },
      ],
      runCount: 6,
      consecutiveFailures: 0,
      lastResult: "4 papers queued; attention routing looks most reproducible.",
      createdAt: now - 9 * DAY,
      updatedAt: now - 26 * HOUR,
    },
    {
      id: "auto-fixture-ci",
      title: "Check CI status",
      prompt: "Look at the latest CI run and report failures only.",
      schedule: { kind: "interval", unit: "minute", every: 30 },
      target: { kind: "new_session", workspaceId: null },
      mode: "skip",
      status: "paused",
      createdBy: { kind: "agent", sessionId: "boss-orbita" },
      nextRunAt: null,
      runs: [
        { id: "run-ci-1", runAt: now - 2 * DAY, trigger: "manual", status: "error", sessionId: "auto-ci-1", durationMs: 12_000, tokens: 4_000, error: "Fixture: the CI probe endpoint is not reachable from the preview." },
      ],
      runCount: 3,
      consecutiveFailures: 1,
      createdAt: now - 6 * DAY,
      updatedAt: now - 2 * DAY,
    },
    {
      id: "auto-fixture-cleanup",
      title: "Nightly workbench cleanup",
      prompt: "Tidy the session workbenches and list what was archived.",
      schedule: { kind: "daily", time: "23:30", weekdays: [1, 2, 3, 4, 5] },
      target: { kind: "this_session", sessionId: "task-sidebar", workspaceId: null },
      mode: "skip",
      status: "failed",
      failureReason: "Fixture: bound session cwd is missing.",
      createdBy: { kind: "agent", sessionId: "task-sidebar" },
      nextRunAt: null,
      runs: [
        { id: "run-clean-3", runAt: now - 30 * HOUR, trigger: "schedule", status: "error", sessionId: "task-sidebar", durationMs: 8_000, tokens: 2_000, error: "Fixture: bound session cwd is missing." },
        { id: "run-clean-2", runAt: now - 54 * HOUR, trigger: "schedule", status: "error", sessionId: "task-sidebar", durationMs: 9_000, tokens: 2_200, error: "Fixture: bound session cwd is missing." },
        { id: "run-clean-1", runAt: now - 78 * HOUR, trigger: "schedule", status: "error", sessionId: "task-sidebar", durationMs: 8_500, tokens: 2_100, error: "Fixture: bound session cwd is missing." },
      ],
      runCount: 3,
      consecutiveFailures: 3,
      createdAt: now - 8 * DAY,
      updatedAt: now - 30 * HOUR,
    },
  ];
}

// ——————————— 组3素材：插件 / 周看板 / 专注 ———————————

/** 看板卡模板哈希：fixture 固定值，board.frame 据此换同源预览页地址。 */
export const FIXTURE_TEMPLATE_HASH = "a3f1c2d4e5b60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0";

function buildPlugins(scene: PreviewSceneId, now: number): PreviewPluginsSet {
  const empty: PreviewPluginsSet = { plugins: [], skills: [], mcp: { servers: [], warnings: [], pluginServers: [] }, drafts: [], draftView: null };
  if (scene === "empty") return empty;
  const reading: PluginView = {
    id: "plugin:reading",
    origin: "plugin",
    name: "reading",
    description: "Distill papers into layered digests and keep a reading queue.",
    author: "Orbita",
    version: "1.4.0",
    license: "MIT",
    scope: { kind: "global" },
    placement: { kind: "global" },
    contents: { skills: 2, mcp: 0, scripts: false },
    skills: [
      { slug: "paper-explainer", name: "paper-explainer", description: "Distill a paper into a layered digest." },
      { slug: "weread", name: "weread", description: "Search the WeRead shelf and pull highlights." },
    ],
    workflow: [],
    io: {
      reads: [{ path: "watchlist.md", note: "the user's paper queue", when: null }],
      writes: [{ path: "reading/digest.md", note: "appended digest", when: "daily" }],
    },
    external: [],
    board: {
      title: "Reading week",
      spec: null,
      cards: [
        { id: "digest", title: "Digest", size: "2x1", note: "Papers queued this week", template: FIXTURE_TEMPLATE_HASH, data: "data/digest.json", sample: "data/digest.sample.json", repeat: null },
        { id: "queue", title: "Queue", size: "1x1", note: null, template: FIXTURE_TEMPLATE_HASH, data: "data/queue.json", sample: null, repeat: "items" },
      ],
    },
    tuned: false,
    mcp: [],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: { source: { kind: "builtin" }, root: "/fixtures/plugins/reading", dataDir: "/fixtures/plugin-data/reading", installedAt: now - 90 * DAY, updatedAt: now - DAY },
    location: null,
  };
  const digest: PluginView = {
    id: "plugin:session-digest",
    origin: "plugin",
    name: "session-digest",
    description: "Collect the week's sessions into one digest board.",
    author: "wafo",
    version: "0.9.2",
    license: null,
    scope: { kind: "workspaces", ids: ["ws-research"] },
    placement: { kind: "workspaces", ids: ["ws-research"] },
    contents: { skills: 1, mcp: 1, scripts: true },
    skills: [{ slug: "digest-collect", name: "digest-collect", description: "Gather raw session material for the digest." }],
    workflow: [
      { title: "Collect sessions", skill: "digest-collect", skillSlug: "digest-collect", detail: "Gathers the week's sessions", output: "data/raw.json", wait: null },
      { title: "Draft the digest", skill: null, skillSlug: null, detail: null, output: "data/digest.json", wait: "board" },
      { title: "Publish", skill: null, skillSlug: null, detail: null, output: null, wait: "chat" },
    ],
    io: {
      reads: [{ path: "sessions/*.jsonl", note: "the week's transcripts", when: "weekly" }],
      writes: [{ path: "data/digest.json", note: "the board's data file", when: "weekly" }],
    },
    external: [{ name: "OpenAlex", kind: "api", account: false, resident: false, note: "paper metadata only" }],
    board: null,
    tuned: true,
    mcp: [{ name: "fetch", qualified: "plugin_session-digest_fetch", transport: "stdio", commandLine: "node /fixtures/plugins/session-digest/mcp/server.js", problem: null }],
    unsupported: [],
    config: [{
      field: { key: "digestHour", type: "string", title: "Digest hour", description: "When the digest runs", required: false, sensitive: false, default: "09:00", options: ["09:00", "18:00"], multiple: false, min: null, max: null },
      value: "09:00",
      isSet: true,
    }],
    conflicts: [],
    problems: [],
    install: { source: { kind: "git", url: "https://fixture.invalid/session-digest.git", commit: "f00ba4" }, root: "/fixtures/plugins/session-digest", dataDir: "/fixtures/plugin-data/session-digest", installedAt: now - 30 * DAY, updatedAt: now - 2 * DAY },
    location: null,
  };
  const userSkill: PluginView = {
    id: "skill:commit-notes",
    origin: "user-skill",
    name: "commit-notes",
    description: "Write commit notes in the user's tone.",
    author: null,
    version: null,
    license: null,
    scope: { kind: "global" },
    placement: { kind: "global" },
    contents: { skills: 1, mcp: 0, scripts: false },
    skills: [{ slug: "commit-notes", name: "commit-notes", description: "Write commit notes in the user's tone." }],
    workflow: [],
    io: { reads: [], writes: [] },
    external: [],
    board: null,
    tuned: false,
    mcp: [],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: null,
    location: "/fixtures/skills/commit-notes",
  };
  const userMcp: PluginView = {
    id: "mcp:fetch-server",
    origin: "user-mcp",
    name: "fetch-server",
    description: "Remote fetch MCP server.",
    author: null,
    version: null,
    license: null,
    scope: { kind: "global" },
    placement: { kind: "global" },
    contents: { skills: 0, mcp: 1, scripts: false },
    skills: [],
    workflow: [],
    io: { reads: [], writes: [] },
    external: [],
    board: null,
    tuned: false,
    mcp: [{ name: "fetch-server", qualified: "fetch-server", transport: "http", commandLine: "https://fixture.invalid/mcp", problem: null }],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: null,
    location: "npx -y @fixture/mcp-server",
  };
  const draftView: PluginView = {
    ...digest,
    id: "plugin:half-done",
    name: "half-done",
    description: "A draft the fixture pretends is still being written.",
    scope: { kind: "off" },
    placement: null,
    install: null,
    problems: [{ kind: "manifest-invalid", detail: "orbita.board.cards[1].size" }],
    unsupported: [{ kind: "commands", items: ["digest.now"], count: 1 }],
  };
  const skills: SkillMeta[] = [
    { slug: "paper-explainer", name: "paper-explainer", description: "Distill a paper into a layered digest.", global: true, workspaces: [], missing: false, linkedPath: null },
    { slug: "weread", name: "weread", description: "Search the WeRead shelf and pull highlights.", global: true, workspaces: [], missing: false, linkedPath: null },
    { slug: "digest-collect", name: "digest-collect", description: "Gather raw session material for the digest.", global: false, workspaces: ["ws-research"], missing: false, linkedPath: null },
    { slug: "commit-notes", name: "commit-notes", description: "Write commit notes in the user's tone.", global: true, workspaces: [], missing: false, linkedPath: null },
  ];
  const mcp: McpListResult = {
    servers: [{
      name: "fetch-server",
      detail: "https://fixture.invalid/mcp",
      status: { kind: "ready", tools: ["search", "queue_add"] },
      disabled: false,
      scopedTo: [],
      source: { global: true, workspaces: [] },
      instances: [],
    }],
    warnings: [],
    pluginServers: [{ name: "plugin_session-digest_fetch", status: { kind: "ready", tools: ["fetch"] }, instances: [] }],
  };
  const drafts: PluginDraftEntry[] = [{
    workspaceId: "ws-research",
    path: "/fixtures/ws-research/plugins/half-done",
    name: "half-done",
    displayName: "Half done digest",
    description: "A draft the fixture pretends is still being written.",
    updatedAt: now - 2 * DAY,
    sessionId: "task-sidebar",
    sessionTitle: "Refine the session navigation",
    manifestProblem: null,
  }];
  return { plugins: [reading, digest, userSkill, userMcp], skills, mcp, drafts, draftView };
}

function buildBoard(scene: PreviewSceneId, now: number): BoardWeekResponse {
  const weekStart = localWeekStart(now);
  const dayStart = (index: number): number => localDayStart(weekStart, index);
  const dayIndexOf = (at: number): number => Math.min(6, Math.max(0, Math.floor((at - dayStart(0)) / DAY)));
  const days: BoardWeekDay[] = Array.from({ length: 7 }, (_, index) => ({ start: dayStart(index), end: dayStart(index + 1), items: [], planned: [] }));
  if (scene !== "empty") {
    const digestCards = [
      { id: "digest", title: "Digest", size: "2x1" as const, index: 0, template: FIXTURE_TEMPLATE_HASH, data: { items: [{ title: "Attention routing", note: "4 papers" }, { title: "Copybook themes", note: "2 papers" }] }, state: "ready" as const, usingSample: false, updatedAt: now - 26 * HOUR },
      { id: "queue", title: "Queue", size: "1x1" as const, index: 0, template: FIXTURE_TEMPLATE_HASH, data: null, state: "empty" as const, usingSample: true, updatedAt: null },
    ];
    days[dayIndexOf(dayStart(1) + 9 * HOUR + 12 * MINUTE)]?.items.push({
      at: dayStart(1) + 9 * HOUR + 12 * MINUTE,
      automationId: "auto-fixture-digest",
      automationTitle: "Daily literature digest",
      plugin: "reading",
      pluginTitle: "Reading",
      sessionId: "auto-digest-2",
      cards: digestCards,
      runId: "run-digest-2",
      status: "success",
      workspaceId: "ws-research",
    });
    days[dayIndexOf(dayStart(1) + 14 * HOUR + 40 * MINUTE)]?.items.push({
      at: dayStart(1) + 14 * HOUR + 40 * MINUTE,
      automationId: "auto-fixture-digest",
      automationTitle: "Daily literature digest",
      plugin: "reading",
      pluginTitle: "Reading",
      sessionId: "auto-news-1",
      cards: [],
      runId: "run-digest-3",
      status: "success",
      workspaceId: "ws-research",
    });
    days[dayIndexOf(dayStart(2) + 8 * HOUR + 15 * MINUTE)]?.items.push({
      at: dayStart(2) + 8 * HOUR + 15 * MINUTE,
      automationId: "auto-fixture-ci",
      automationTitle: "Check CI status",
      plugin: null,
      pluginTitle: null,
      sessionId: null,
      cards: [],
      runId: "run-ci-2",
      status: "error",
      workspaceId: null,
    });
    const plannedAt1 = now + 2 * HOUR;
    const plannedAt2 = now + 26 * HOUR;
    days[dayIndexOf(plannedAt1)]?.planned.push({ at: plannedAt1, automationId: "auto-fixture-digest", title: "Daily literature digest", plugin: "reading", workspaceId: "ws-research" });
    days[dayIndexOf(plannedAt2)]?.planned.push({ at: plannedAt2, automationId: "auto-fixture-ci", title: "Check CI status", plugin: null, workspaceId: null });
  }
  return { weekStart, now, days };
}

function buildFocusChanges(scene: PreviewSceneId): FocusChanges {
  if (scene === "empty") return { kind: "empty", reason: "not-repo" };
  return {
    kind: "ok",
    branch: "main",
    entries: [
      { path: "src/new-feature.ts", kind: "U", added: 14, removed: 0, binary: false },
      { path: "src/app.ts", kind: "M", added: 3, removed: 2, binary: false },
      { path: "assets/logo.png", kind: "M", added: 0, removed: 0, binary: true },
      { path: "data/dump.csv", kind: "U", added: 0, removed: 0, binary: false, lineCountUnknown: true },
    ],
  };
}

// ——————————— 组4素材：外部来源 ———————————

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
  const profiles = new Map<string, PreviewMainProfile>([
    ["ws-research", { workspaceId: "ws-research", sessionId: boss.id, createdAt: boss.createdAt }],
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

/** 手机稿的一份对话转成桌面的块数组转录：过程行 = 一次 read，现场块 = 一次还没回结果的 bash */
function mirrorTranscript(chat: MobileChat, now: number): SessionRecord[] {
  const shift = now - MOBILE_NOW;
  const out: SessionRecord[] = [];
  let at = MOBILE_NOW - HOUR + shift;
  chat.entries.forEach((entry, index) => {
    const id = `${chat.session.id}-m${index}`;
    if (entry.kind === "user") {
      at = entry.at + shift;
      out.push({ id, role: "user", content: [{ type: "text", text: entry.text }], timestamp: at });
      return;
    }
    at += 40_000;
    if (entry.kind === "prose") {
      out.push(assistant(id, at, [{ type: "text", text: entry.text }]));
      return;
    }
    const callId = `${id}-call`;
    const live = entry.kind === "live";
    const toolName = live ? "bash" : "read";
    const input: Record<string, string> = live
      ? { command: "bun scripts/migrate.ts --step 3" }
      : { path: "src/main/session/store.ts" };
    out.push(assistant(id, at, [{ type: "toolCall", toolCallId: callId, toolName, input }], "toolUse"));
    if (!live) {
      out.push({
        id: `${id}-tool`,
        role: "tool",
        toolCallId: callId,
        toolName,
        input,
        content: [{ type: "text", text: "export function storeFixture() {}" }],
        status: "complete",
        isError: false,
        timestamp: at + 2_000,
      });
    }
  });
  return out;
}

/** mirror=mobile：手机稿平常档的任务（含满载对话那一条）加进 orbita 与「博士论文」两个工作区 */
function mirrorMobile(base: ReturnType<typeof typicalData>, now: number): ReturnType<typeof typicalData> & { live: PreviewFixture["live"] } {
  const shift = now - MOBILE_NOW;
  const list = mobileList("typical");
  const chats = [mobileChat("typical"), mobileChat("waiting"), mobileChat("full")];
  // 平常档清单里已经有满载对话那一条（orbita-night-2），两边是同一批任务
  const rows: MobileSession[] = list.workspaces.flatMap((ws) => ws.sessions);
  const workspaces = base.workspaces.map((ws) => (ws.id === "ws-orbita" ? { ...ws, name: "orbita" } : ws));
  workspaces.push(workspace("ws-thesis", "博士论文", now));
  const sessions = rows.map((row) =>
    meta({
      id: row.id,
      title: row.title,
      workspaceId: row.workspaceId,
      createdAt: row.updatedAt + shift - HOUR,
      updatedAt: row.updatedAt + shift,
      ...(row.state === "done" || row.state === "failed" ? { unread: { at: row.updatedAt + shift, failed: row.state === "failed" } } : {}),
    }),
  );
  const transcripts = new Map(base.transcripts);
  for (const chat of chats) transcripts.set(chat.session.id, mirrorTranscript(chat, now));
  return {
    ...base,
    workspaces,
    sessions: [...base.sessions, ...sessions],
    transcripts,
    live: {
      running: rows.filter((row) => row.state === "running").map((row) => row.id),
      waiting: rows.filter((row) => row.state === "waiting").map((row) => row.id),
    },
  };
}

export function buildPreviewFixture(options: PreviewOptions): PreviewFixture {
  const plain = options.scene === "empty"
    ? { workspaces: [], sessions: [], transcripts: new Map<string, SessionRecord[]>(), channels: [], profiles: new Map<string, PreviewMainProfile>() }
    : options.scene === "full"
      ? fullData(options.now)
      : typicalData(options.now);
  const data = options.mirror && options.scene !== "empty"
    ? mirrorMobile(plain, options.now)
    : { ...plain, live: { running: [], waiting: [] } };
  const availableProviders = options.scene === "empty" ? [] : providers();
  const settings = parseSettings({
    ...DEFAULT_SETTINGS,
    theme: options.theme,
    language: options.language,
    onboardingSeen: !options.onboarding,
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
    vfs: buildVfs(options.scene, options.now),
    review: buildReview(options.scene),
    excerpts: options.scene === "empty" ? [] : buildExcerpts(options.now),
    memory: buildMemory(options.scene, options.now),
    automations: buildAutomations(options.scene, options.now),
    plugins: buildPlugins(options.scene, options.now),
    board: buildBoard(options.scene, options.now),
    focusChanges: buildFocusChanges(options.scene),
  };
}
