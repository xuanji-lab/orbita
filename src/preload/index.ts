/**
 * preload：IPC 四层契约的第 3 层（AGENTS.md「IPC 是四层契约」）。
 * 只允许依赖 electron / node 内建 / src/shared —— 不得 import 主进程模块或渲染层模块。
 */
import { contextBridge } from "electron";
import { agentApi } from "./api/agent.ts";
import { providerApi } from "./api/provider.ts";
import { workspaceApi } from "./api/workspace.ts";

const api = { agent: agentApi, provider: providerApi, workspace: workspaceApi } as const;

export type OrbitaApi = typeof api;

contextBridge.exposeInMainWorld("orbita", api);
