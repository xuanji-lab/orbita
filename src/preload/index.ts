/**
 * preload：IPC 四层契约的第 3 层（AGENTS.md「IPC 是四层契约」）。
 * 只允许依赖 electron / node 内建 / src/shared —— 不得 import 主进程模块或渲染层模块。
 */
import { contextBridge } from "electron";
import { agentApi } from "./api/agent.ts";
import { providerApi } from "./api/provider.ts";
import { sessionApi } from "./api/session.ts";
import { settingsApi } from "./api/settings.ts";
import { mcpApi, skillApi } from "./api/skill.ts";
import { workspaceApi } from "./api/workspace.ts";

const api = {
  agent: agentApi,
  provider: providerApi,
  session: sessionApi,
  settings: settingsApi,
  skill: skillApi,
  mcp: mcpApi,
  workspace: workspaceApi,
  /**
   * 宿主平台。**不是 IPC 通道**，是个同步常量——渲染层需要它，因为
   * 「红黄绿三个键落在边界卡里」只在 macOS 成立，别的平台要给自己画圆角。
   */
  platform: process.platform,
} as const;

export type OrbitaApi = typeof api;

contextBridge.exposeInMainWorld("orbita", api);
