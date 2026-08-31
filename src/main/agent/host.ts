/**
 * AgentHost —— 主进程侧的 agent utility 进程管家。
 * 逻辑全在 `host-core.ts`（纯模块，可被 `node --test` 直接测）；这里只注入真的 fork。
 */
import { join } from "node:path";
import { utilityProcess } from "electron";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { AgentHostCore } from "./host-core.ts";

export class AgentHost extends AgentHostCore {
  constructor(runtimePath: string, onEvent: (event: AgentEvent) => void) {
    super(() => utilityProcess.fork(runtimePath, [], { stdio: "inherit" }), onEvent);
  }
}

/** 打包产物里 runtime 与主进程同目录（electron.vite.config 的 main 多入口）。 */
export function resolveRuntimePath(dirname: string): string {
  return join(dirname, "agent-runtime.js");
}
