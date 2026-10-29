/**
 * 主进程侧的记忆服务管家 —— 逻辑全在 `host-core.ts`（纯模块，可被 `node --test`
 * 直接测）；这里只注入真的 fork（agent/host.ts 的同款分层）。
 */
import { join } from "node:path";
import { utilityProcess } from "electron";
import { MemoryServiceHostCore } from "./host-core.ts";

export class MemoryServiceHost extends MemoryServiceHostCore {
  /** env 沿主进程的（agent 进程同款：模型目录缓存的 env 变量在主进程挂上）。 */
  constructor(input: {
    runtimePath: string;
    dir: string;
    env?: Record<string, string | undefined>;
    onChanged?: () => void;
  }) {
    super({
      forkRuntime: () =>
        utilityProcess.fork(input.runtimePath, [], {
          stdio: "inherit",
          ...(input.env !== undefined ? { env: input.env } : {}),
        }),
      dir: input.dir,
      ...(input.onChanged !== undefined ? { onChanged: input.onChanged } : {}),
    });
  }
}

/** 打包产物里 runtime 与主进程同目录（electron.vite.config 的 main 多入口）。 */
export function resolveMemoryRuntimePath(dirname: string): string {
  return join(dirname, "memory-runtime.js");
}
