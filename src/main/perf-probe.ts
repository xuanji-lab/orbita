/**
 * 实验探针（只在 exp/ 分支上，不进 PR）：给「切换会话卡」的调查量主进程这一侧的数字。
 *
 * 只在设了环境变量 `ORBITA_PERF_LOG=<文件>` 时生效，否则 installPerfProbe 是空操作：
 * - 每次 `ipcMain.handle` 的调用：通道、参数摘要、同步段耗时、总耗时；
 * - 主进程事件循环被堵住的每一段（10ms 定时器的漂移 ≥ 20ms 记一条）；
 * - 各进程内存与 CPU（app.getAppMetrics，每 250ms 一条）；
 * - 调用方自己埋的阶段计时（perf-log.ts 的 perfLog）。
 */
import { app, ipcMain } from "electron";
import { performance } from "node:perf_hooks";
import { perfLog, perfProbeOn } from "./perf-log.ts";

/** 参数摘要：只留短字符串 / 数字（会话 id、条数），不把整个载荷写进日志 */
function summarize(args: readonly unknown[]): unknown[] {
  return args.slice(0, 3).map((arg) => {
    if (typeof arg === "string") return arg.length <= 80 ? arg : `${arg.slice(0, 40)}…(${arg.length})`;
    if (typeof arg === "number" || typeof arg === "boolean" || arg === null) return arg;
    if (Array.isArray(arg)) return `[array ${arg.length}]`;
    if (typeof arg === "object") {
      const record = arg as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const key of ["sessionId", "id", "parentId", "childId", "path", "kind"]) {
        const value = record[key];
        if (typeof value === "string") picked[key] = value.length <= 80 ? value : `${value.slice(0, 40)}…`;
      }
      return picked;
    }
    return typeof arg;
  });
}

const round2 = (ms: number): number => Math.round(ms * 100) / 100;

export function installPerfProbe(): void {
  if (!perfProbeOn) return;

  // 1. 所有 ipcMain.handle：包一层计时。注册发生在 app ready 之后，这里先于它们打补丁
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    originalHandle(channel, async (event, ...args: unknown[]) => {
      const at = Date.now();
      const start = performance.now();
      let syncEnd = start;
      let failed = false;
      try {
        const pending = listener(event, ...args) as unknown;
        syncEnd = performance.now();
        return await pending;
      } catch (cause) {
        failed = true;
        throw cause;
      } finally {
        const end = performance.now();
        perfLog({
          t: at,
          type: "ipc",
          channel,
          args: summarize(args),
          syncMs: round2(syncEnd - start),
          totalMs: round2(end - start),
          ...(failed ? { failed: true } : {}),
        });
      }
    });
  };

  // 2. 事件循环被堵：10ms 的定时器晚到多少就是堵了多久（t 记的是堵完的时刻）
  const TICK = 10;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK;
    if (lag >= 20) perfLog({ type: "lag", ms: Math.round(lag) });
    last = now;
  }, TICK);

  // 3. 各进程内存（KB）与 CPU：Browser = 主进程，Tab = 各 renderer，Utility = agent / 记忆 / 终端
  setInterval(() => {
    const usage = process.memoryUsage();
    perfLog({
      type: "mem",
      mainRssMb: Math.round(usage.rss / 1048576),
      mainHeapMb: Math.round(usage.heapUsed / 1048576),
      mainExternalMb: Math.round(usage.external / 1048576),
      procs: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        name: metric.name ?? metric.serviceName ?? "",
        pid: metric.pid,
        kb: metric.memory.workingSetSize,
        cpu: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
      })),
    });
  }, 250);

  perfLog({ type: "boot", pid: process.pid, packaged: app.isPackaged });
}
