/**
 * 实验探针的日志口（只在 exp/ 分支上，不进 PR）。**不 import electron**：SessionStore 会被
 * `node --test` 直接加载，探针的纯日志部分必须在普通 node 里也能跑。
 *
 * 只在设了环境变量 `ORBITA_PERF_LOG=<文件>` 时生效，否则 perfLog 是空操作。
 * 日志先攒在内存里、每 300ms 异步落一次盘——探针自己不该成为被量的卡顿。
 */
import { appendFile } from "node:fs/promises";

const LOG_FILE = process.env["ORBITA_PERF_LOG"] ?? "";

/** 探针开着没有：调用方用它决定要不要走带分段计时的那条路 */
export const perfProbeOn = LOG_FILE !== "";

const buffer: string[] = [];

/** 记一条（开着才记）。`t` 是墙上时钟毫秒，和 renderer 那边的 Date.now() 对得上 */
export function perfLog(entry: Record<string, unknown>): void {
  if (!perfProbeOn) return;
  buffer.push(JSON.stringify({ t: Date.now(), ...entry }));
}

if (perfProbeOn) {
  const timer = setInterval(() => {
    if (buffer.length === 0) return;
    const chunk = `${buffer.join("\n")}\n`;
    buffer.length = 0;
    void appendFile(LOG_FILE, chunk, "utf8").catch(() => undefined);
  }, 300);
  timer.unref();
}
