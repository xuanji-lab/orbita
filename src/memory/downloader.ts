/**
 * 模型文件下载器 —— **纯模块**：fetch 注入，可被 `node --test` 直接测。
 * 流式落盘 + 边下边算 sha256（310MB 下完再算要再读一遍盘，没必要），
 * 校验不过删临时文件换下一个源。源依序尝试（主源 HF 直连，兜底 hf-mirror）；
 * **不做断点续传**：HF 的直链是带签名的 CDN 跳转，Range 语义不稳，失败整源
 * 重来（310MB 在正常网络几十秒；弱网重下比维护断点状态机便宜）。
 */
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** fetch 的结构面（undici / Node 全局 fetch 满足；测试注入桩）。 */
export interface DownloadFetch {
  (url: string, signal?: AbortSignal): Promise<{
    ok: boolean;
    status: number;
    body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  }>;
}

export interface DownloadProgressEvent {
  phase: "downloading" | "verifying" | "done" | "failed";
  source: string;
  received: number;
  total: number;
  error?: string;
}

export async function downloadWithFallback(input: {
  sources: readonly string[];
  targetPath: string;
  sha256: string;
  sizeBytes: number;
  fetchImpl: DownloadFetch;
  onProgress: (event: DownloadProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const source of input.sources) {
    const outcome = await downloadFromSource({
      source,
      targetPath: input.targetPath,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      fetchImpl: input.fetchImpl,
      onProgress: input.onProgress,
      signal: input.signal,
    });
    if (outcome.ok) return outcome;
    errors.push(`${source}: ${outcome.error}`);
    input.onProgress({ phase: "failed", source, received: 0, total: input.sizeBytes, error: outcome.error });
  }
  return { ok: false, error: errors.join("；") };
}

async function downloadFromSource(input: {
  source: string;
  targetPath: string;
  sha256: string;
  sizeBytes: number;
  fetchImpl: DownloadFetch;
  onProgress: (event: DownloadProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const temp = `${input.targetPath}.downloading`;
  try {
    const response = await input.fetchImpl(input.source, input.signal);
    if (!response.ok || response.body === null) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    await mkdir(dirname(input.targetPath), { recursive: true });
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    // 边下边写文件句柄：310MB 攒在内存里再落盘会把 utility 进程撑爆
    const handle = await open(temp, "w");
    let received = 0;
    let lastReport = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        hash.update(value);
        await handle.write(value);
        received += value.byteLength;
        // 进度按 1MB 一报：310MB 逐块报会刷爆 IPC
        if (received - lastReport >= 1_000_000 || received === input.sizeBytes) {
          lastReport = received;
          input.onProgress({
            phase: "downloading",
            source: input.source,
            received,
            total: input.sizeBytes,
          });
        }
      }
    } finally {
      await handle.close();
    }
    if (received !== input.sizeBytes) {
      return { ok: false, error: `大小不符：期望 ${input.sizeBytes}，实收 ${received}` };
    }
    input.onProgress({ phase: "verifying", source: input.source, received, total: input.sizeBytes });
    // sha256 已边下边算完，直接比对
    const actual = hash.digest("hex");
    if (actual !== input.sha256) {
      return { ok: false, error: `sha256 不符：期望 ${input.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…` };
    }
    await rename(temp, input.targetPath);
    input.onProgress({ phase: "done", source: input.source, received, total: input.sizeBytes });
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    // 成功路径已 rename 走（rm 落空）；失败 / 中断路径清掉半截临时文件
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
