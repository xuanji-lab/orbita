/**
 * 系统提示词的段装配。抽成纯函数后，测试可以直接比较「派出 / 删除子会话前后」
 * 整份提示词的字节；prompt-stability 也吃同一份段名单，变化能归因到具体段。
 *
 * attached、权限模式、cwd、本会话工作台与浏览器下载目录仍按原行为留在这里；
 * 父子会话清单不进系统提示词，对方工作台由 delegate 回执和通道信封告知。
 */
import type { TurnDirectories } from "../shared/agent-ipc.ts";
import { COMMAND_TIMEOUT_FLOOR_SECONDS, type PermissionMode } from "../shared/permission.ts";
import { QUOTE_GUIDELINE } from "../shared/quote.ts";
import type { Language } from "../shared/settings.ts";
import { INTENT_CONTEXT_GUIDELINE } from "../shared/intent-recall.ts";
import { describePermissionMode } from "./permission.ts";
import { describeDirectories } from "./directories-prompt.ts";
import { describeChannelRole } from "./channel-tools.ts";
import { storeToolsGuideline } from "./store-tools.ts";
import { gitAttributionGuideline } from "./git-attribution.ts";
import { REPLY_LANGUAGE_GUIDELINE } from "./prompt-narration.ts";

const TOOL_GUIDELINES =
  "For commands that may take a while (installing dependencies, builds, tests), do not pass a timeout to bash/powershell: " +
  `these are slow on Windows and a short timeout kills a normal slow command halfway; values under ${COMMAND_TIMEOUT_FLOOR_SECONDS} seconds are ignored anyway.`;

const EXPECTED_SECONDS_GUIDELINE =
  "When calling bash/powershell with a command you expect to run longer than 10 seconds (tests, builds, installs, sleep, " +
  "scanning large directories), you may add expected_seconds (a number of seconds, your estimate) to the arguments. " +
  "It only drives the UI (progress hint and auto-expand) and does not affect execution or timeouts.";

export interface SystemPromptInput {
  /** pi 基底，已由 adaptSystemPrompt 处理 */
  piBase: string;
  mode: PermissionMode;
  /** 当前实际注册的非内建工具名，与工具注册共用同一来源 */
  extraToolNames: readonly string[];
  role: "root" | "child";
  workspace: { name?: string } | null;
  cwd: string;
  directories: TurnDirectories | undefined;
  gitAttribution: boolean;
  attributionLanguage: Language | undefined;
  intentGuideline: boolean;
}

export interface PromptSegment {
  name: string;
  text: string;
}

/** 段序就是线上字节序：已有段不重排，避免无意义地打断整份前缀缓存。 */
export function orbitaSystemSegments(input: SystemPromptInput): PromptSegment[] {
  return [
    { name: "pi-base", text: input.piBase },
    { name: "permission", text: describePermissionMode(input.mode, input.extraToolNames) },
    { name: "directories", text: describeDirectories(input.cwd, input.directories) },
    { name: "channel-role", text: describeChannelRole(input.role) },
    { name: "store-tools", text: storeToolsGuideline(input.workspace, input.cwd) },
    { name: "tool-guidelines", text: TOOL_GUIDELINES },
    { name: "expected-seconds", text: EXPECTED_SECONDS_GUIDELINE },
    ...(input.intentGuideline ? [{ name: "intent", text: INTENT_CONTEXT_GUIDELINE }] : []),
    { name: "quote", text: QUOTE_GUIDELINE },
    {
      name: "git-attribution",
      text: gitAttributionGuideline(input.gitAttribution, input.attributionLanguage ?? "en"),
    },
    { name: "reply-language", text: REPLY_LANGUAGE_GUIDELINE },
  ];
}

/** 空段滤掉，其余用空行相连，与 runtime 原来的内联拼接一致。 */
export function joinSystemPrompt(segments: readonly PromptSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .filter((text) => text !== "")
    .join("\n\n");
}
