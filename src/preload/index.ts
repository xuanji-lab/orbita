/**
 * preload：IPC 四层契约的第 3 层（AGENTS.md「IPC 是四层契约」）。
 * 只允许依赖 electron / node 内建 / src/shared —— 不得 import 主进程模块或渲染层模块。
 */
import { contextBridge } from "electron";
import { agentApi } from "./api/agent.ts";
import { automationApi } from "./api/automation.ts";
import { browserApi } from "./api/browser.ts";
import { channelApi } from "./api/channel.ts";
import { excerptApi } from "./api/excerpt.ts";
import { filesApi } from "./api/files.ts";
import { focusApi } from "./api/focus.ts";
import { importApi } from "./api/import.ts";
import { intentApi } from "./api/intent.ts";
import { providerApi } from "./api/provider.ts";
import { reviewApi } from "./api/review.ts";
import { sessionApi } from "./api/session.ts";
import { settingsApi } from "./api/settings.ts";
import { terminalApi } from "./api/terminal.ts";
import { usageApi } from "./api/usage.ts";
import { updaterApi } from "./api/updater.ts";
import { voiceApi } from "./api/voice.ts";
import { mcpApi, skillApi } from "./api/skill.ts";
import { memoryApi } from "./api/memory.ts";
import { windowApi } from "./api/window.ts";
import { workspaceApi } from "./api/workspace.ts";
import { readInitialLanguage, readInitialTheme } from "./initial-theme.ts";

const api = {
  agent: agentApi,
  automation: automationApi,
  channel: channelApi,
  excerpt: excerptApi,
  provider: providerApi,
  session: sessionApi,
  review: reviewApi,
  settings: settingsApi,
  skill: skillApi,
  memory: memoryApi,
  mcp: mcpApi,
  window: windowApi,
  workspace: workspaceApi,
  files: filesApi,
  focus: focusApi,
  terminal: terminalApi,
  usage: usageApi,
  updater: updaterApi,
  import: importApi,
  intent: intentApi,
  browser: browserApi,
  voice: voiceApi,
  /**
   * 宿主平台。**不是 IPC 通道**，是个同步常量——渲染层需要它，因为
   * 「红黄绿三个键落在边界卡里」只在 macOS 成立，别的平台要给自己画圆角。
   */
  platform: process.platform,
  /**
   * 冷启动第一帧要用的主题偏好。**同样不是 IPC 通道**，是个同步常量——从主进程
   * 建窗口时传入的 `--orbita-theme=` 命令行参数原样解出（initial-theme.ts）。
   * 渲染层 main.tsx 用它在 createRoot 之前把 data-theme 写对，跳过首帧再套一层
   * 交叉淡入。参数缺席或非法都是 null，退回旧路径。
   */
  initialTheme: readInitialTheme(process.argv),
  /** 冷启动第一帧的语言偏好（`--orbita-language=`），同 initialTheme；没选过语言是 null */
  initialLanguage: readInitialLanguage(process.argv),
} as const;

export type OrbitaApi = typeof api;

contextBridge.exposeInMainWorld("orbita", api);
