/**
 * AgentHost —— 主进程侧的 agent utility 进程管家。
 * 逻辑全在 `host-core.ts`（纯模块，可被 `node --test` 直接测）；这里只注入真的 fork。
 */
import { join } from "node:path";
import { utilityProcess } from "electron";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { AgentHostCore, type CatalogScope } from "./host-core.ts";

export class AgentHost extends AgentHostCore {
  /**
   * env：agent 进程的环境变量（主进程挂上随包的 rg / fd，见 search-bins.ts）。
   * catalogScope：已添加服务商用到的目录（目录联网刷新只刷这些，见 host-core syncCatalogScope）
   */
  constructor(
    runtimePath: string,
    env: Record<string, string | undefined>,
    onEvent: (event: AgentEvent) => void,
    catalogScope: CatalogScope,
  ) {
    super(() => utilityProcess.fork(runtimePath, [], { stdio: "inherit", env }), onEvent, catalogScope);
  }
}

/** 打包产物里 runtime 与主进程同目录（electron.vite.config 的 main 多入口）。 */
export function resolveRuntimePath(dirname: string): string {
  return join(dirname, "agent-runtime.js");
}
