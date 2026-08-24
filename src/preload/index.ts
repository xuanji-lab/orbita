/**
 * preload：IPC 四层契约的第 3 层（AGENTS.md「IPC 是四层契约」）。
 * 只允许依赖 electron / node 内建 / src/shared —— 不得 import 主进程模块或渲染层模块。
 * 目前尚无通道；各域的 API 落在 src/preload/api/<域>.ts，在此汇总暴露。
 */
import { contextBridge } from "electron";

const api = {} as const;

export type OrbitaApi = typeof api;

contextBridge.exposeInMainWorld("orbita", api);
