/**
 * 可续传、多连接的文件下载 —— 纯算法层，不引 electron，`node --test` 直接测。
 *
 * 为什么要有它：GitHub 的发布资产 CDN 在部分网络会限速到几十 KB/s，并在传输中途
 * 直接 `ERR_CONNECTION_RESET`（#283 实测）。electron-updater 自带的下载器一断就从 0
 * 重来，177MB 永远下不完。这里做两件事：
 *
 * 1. **按 4MB 切段，最多 6 段并行**：单连接被限速时，多连接能聚合带宽（本机实测
 *    8 连接 ~213KB/s，单连接 30–70KB/s）；
 * 2. **每段自己从已写字节续传**：断了只重发这一段剩下的部分，不清空整个文件。
 *
 * 安全边界：下载完成后**必须**核对 sha512（由 GitHub 的 latest.yml 提供）。校验不过就
 * 抛错，electron-updater 会删掉临时文件，绝不会把残缺/被替换的安装包交给 NSIS。
 *
 * Range 语义按 HTTP 习惯：`end` 是**闭区间**（bytes=start-end）。内部切段时用半开区间
 * 计算长度，避免差一。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/** 一段 Range 请求（闭区间） */
export interface RangeRequest {
  start: number;
  /** 闭区间末字节；`start === end` 时只取 1 字节 */
  end: number;
}

/** 传输层返回的一段响应；`body` 由调用方消费，`close()` 负责中止底层请求 */
export interface RangeResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Buffer>;
  close(): void;
}

/** 传输层接口：Electron net / 测试替身都实现它 */
export interface RangeTransport {
  open(url: URL, headers: Readonly<Record<string, string>>, range: RangeRequest): Promise<RangeResponse>;
}

/** 与 electron-updater 的 ProgressInfo 同形，避免引它的类型 */
export interface DownloadProgress {
  percent: number;
  /** 自上一次上报以来新增的字节（electron-updater 的 ProgressInfo 要它） */
  delta: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DownloadFileOptions {
  url: URL;
  destination: string;
  headers: Readonly<Record<string, string>>;
  /** GitHub latest.yml 给的 sha512（base64）；没给就跳过校验（不该发生） */
  sha512?: string | null;
  /** 只是结构，不引 builder-util-runtime 的类；可变，取消状态由外部随时翻 */
  cancellation?: { cancelled: boolean };
  onProgress?: (progress: DownloadProgress) => void;
  /** 每段字节数；默认 4MB，测试可调小 */
  partSize?: number;
  /** 并行段数；默认 6 */
  concurrency?: number;
  /** 连续多少次「一点进展都没有」就放弃；默认 3 */
  maxStalledAttempts?: number;
  /** 重试退避基数；默认 500ms，测试可调小 */
  retryBaseDelayMs?: number;
  /** 日志出口；库本身不直接写 console（避免测试子进程的输出干扰 test runner） */
  log?: (message: string) => void;
}

/** 服务器没给总长度 / 不能用 Range 到无法继续时抛它，调用方可退回库的单连接下载 */
export class DownloadUnsupportedError extends Error {
  readonly code = "ERR_UPDATER_DOWNLOAD_UNSUPPORTED";
}

/** 用户取消。名字与 electron-updater 的判定对齐，避免把取消说成失败 */
export class DownloadCancelledError extends Error {
  override readonly name = "CancellationError";
  readonly code = "ERR_UPDATER_CANCELLED";
}

/** 哈希不符：更新源（或中间链路）给的字节不是 GitHub 记录的那一份 */
export class DownloadChecksumError extends Error {
  readonly code = "ERR_UPDATER_INVALID_CHECKSUM";
}

const DEFAULT_PART_SIZE = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_STALLED = 3;
/** 每次重试的退避上限：断网时不要瞬间打满重试次数 */
const MAX_BACKOFF_MS = 8_000;
/** 进度上报节流：UI 每 250ms 一次足够，别让每个 64KB chunk 都推一遍 IPC */
const PROGRESS_INTERVAL_MS = 250;

/** 头名大小写不敏感地取一个值 */
export function headerOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] ?? null;
  }
  return null;
}

/**
 * `Content-Range: bytes 0-1023/177819819` → 总长度。
 * `*` 总长度（流式响应）或格式不对 → null。
 */
export function totalFromContentRange(value: string | null): number | null {
  if (value === null) return null;
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)$/i.exec(value.trim());
  if (match === null || match[1] === undefined || match[1] === "*") return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

/** 总长度 + 段大小 → 闭区间范围列表（空文件返回空数组） */
export function planParts(total: number, partSize: number): RangeRequest[] {
  if (total <= 0) return [];
  const size = Math.max(1, Math.trunc(partSize));
  const parts: RangeRequest[] = [];
  for (let start = 0; start < total; start += size) {
    parts.push({ start, end: Math.min(total - 1, start + size - 1) });
  }
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha512Of(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

interface ProbeResult {
  total: number;
  supportsRanges: boolean;
}

/** 先取 1 字节探明总长度与是否支持 Range；请求头里不要带 `range`，由这里统一加 */
async function probe(transport: RangeTransport, url: URL, headers: Record<string, string>): Promise<ProbeResult> {
  const response = await transport.open(url, headers, { start: 0, end: 0 });
  try {
    const total = totalFromContentRange(headerOf(response.headers, "content-range"));
    if (response.status === 206 && total !== null) return { total, supportsRanges: true };
    if (response.status === 200) {
      const length = Number(headerOf(response.headers, "content-length"));
      if (Number.isSafeInteger(length) && length >= 0) return { total: length, supportsRanges: false };
    }
    if (response.status === 416) {
      const fromRange = totalFromContentRange(headerOf(response.headers, "content-range"));
      if (fromRange !== null) return { total: fromRange, supportsRanges: true };
    }
    throw new DownloadUnsupportedError(`无法确定更新包大小（HTTP ${response.status}）。`);
  } finally {
    response.close();
  }
}

/**
 * 下载到 `destination`，全部写完后校验 sha512。
 *
 * 失败语义：网络错误会按段重试；连续 `maxStalledAttempts` 次没有任何进展、或不是网络类
 * 错误时抛出。调用方负责删除不完整的文件（electron-updater 会做）。
 */
export async function downloadFile(transport: RangeTransport, options: DownloadFileOptions): Promise<void> {
  const { url, destination, headers, cancellation, onProgress } = options;
  const isCancelled = (): boolean => cancellation !== undefined && cancellation.cancelled;
  const probeResult = await probe(transport, url, headers);
  const { total, supportsRanges } = probeResult;
  if (total === 0) throw new DownloadUnsupportedError("更新包是 0 字节。");

  const partSize = supportsRanges ? (options.partSize ?? DEFAULT_PART_SIZE) : total;
  const concurrency = supportsRanges
    ? Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, planParts(total, partSize).length))
    : 1;
  const parts = planParts(total, partSize);
  const maxStalled = Math.max(1, options.maxStalledAttempts ?? DEFAULT_MAX_STALLED);
  const retryBaseDelay = Math.max(1, options.retryBaseDelayMs ?? 500);

  const file = await open(destination, "w");
  try {
    await file.truncate(total);

    /** 每一段已写到的绝对位置；进度按它们求和，重试回退时也只影响这一段 */
    const cursors = parts.map((part) => part.start);
    const startedAt = Date.now();
    let lastReport = 0;
    let lastWritten = 0;

    const report = (force: boolean): void => {
      if (onProgress === undefined) return;
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      let written = 0;
      for (let index = 0; index < parts.length; index += 1) {
        written += (cursors[index] ?? 0) - (parts[index]?.start ?? 0);
      }
      const seconds = Math.max((now - startedAt) / 1000, 0.001);
      const delta = written - lastWritten;
      lastWritten = written;
      onProgress({
        percent: Math.min(100, (written / total) * 100),
        delta,
        transferred: written,
        total,
        bytesPerSecond: written / seconds,
      });
    };

    /**
     * 任一段终态失败后立起来：其余段在下一个检查点退出，不再对着已关闭的文件句柄重试。
     * 没有它，Promise.all 一 reject 文件就被关掉，兄弟段还在写 → EBADF → 各自再重试
     * 三次（每个 worker 还多打几次网络请求），失败之后还要空转一会儿。
     */
    let stopped = false;
    let firstFailure: Error | null = null;

    const downloadPart = async (index: number): Promise<void> => {
      const part = parts[index];
      if (part === undefined) return;
      let stalled = 0;
      let lastPosition = part.start;

      while ((cursors[index] ?? 0) <= part.end) {
        if (stopped) return;
        if (isCancelled()) throw new DownloadCancelledError();
        const start = cursors[index] ?? part.start;
        let response: RangeResponse | null = null;
        try {
          response = await transport.open(url, headers, { start, end: part.end });
          if (response.status === 200) {
            // 服务器不认 Range。多段时无法安全拼装，交给调用方退回单连接下载。
            if (parts.length > 1) throw new DownloadUnsupportedError("服务器不识别 Range，无法分段下载。");
            // 单段：从 0 重写这一段，已写入的字节会被覆盖
            cursors[index] = part.start;
            if (start > part.start) continue;
          }
          if (response.status !== 206 && response.status !== 200) {
            throw new Error(`下载分段失败：HTTP ${response.status}`);
          }

          for await (const chunk of response.body) {
            if (stopped) return;
            if (isCancelled()) throw new DownloadCancelledError();
            const cursor = cursors[index] ?? part.start;
            const remaining = part.end + 1 - cursor;
            if (remaining <= 0) break;
            const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            await file.write(slice, 0, slice.length, cursor);
            cursors[index] = cursor + slice.length;
            report(false);
          }

          if ((cursors[index] ?? part.start) <= part.end) {
            throw new Error("连接提前结束");
          }
        } catch (error) {
          if (error instanceof DownloadCancelledError) throw error;
          if (isCancelled()) throw new DownloadCancelledError();
          if (error instanceof DownloadUnsupportedError) throw error;

          const position = cursors[index] ?? part.start;
          if (position > lastPosition) {
            // 这一次至少写进去了一些字节：算有进展，重置停滞计数
            stalled = 0;
            lastPosition = position;
          } else {
            stalled += 1;
          }
          if (stalled >= maxStalled) {
            throw new Error(`下载反复中断，已停止重试：${messageOf(error)}`);
          }
          const backoff = Math.min(MAX_BACKOFF_MS, retryBaseDelay * 2 ** Math.max(0, stalled - 1));
          options.log?.(
            `[更新] 分段 ${index + 1}/${parts.length} 中断（已收 ${position - part.start}/${part.end + 1 - part.start} 字节），${backoff}ms 后续传：${messageOf(error)}`,
          );
          await sleep(backoff);
        } finally {
          response?.close();
        }
      }
    };

    // 简单的工作队列：段数多于并发时，谁先空出来谁拿下一段。
    // 错误在这里收住而不让 worker 直接 reject：一个段失败不代表整包失败，但要继续
    // 失败的那个原因。每段都在 stopped 上收工，Promise.all 不必提前炸开。
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < parts.length) {
        if (stopped) return;
        const index = next;
        next += 1;
        try {
          await downloadPart(index);
        } catch (error) {
          stopped = true;
          if (firstFailure === null) {
            firstFailure = error instanceof Error ? error : new Error(messageOf(error));
          }
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    if (firstFailure !== null) throw firstFailure;
    report(true);
  } finally {
    await file.close();
  }

  if (options.sha512 != null && options.sha512 !== "") {
    const actual = await sha512Of(destination);
    if (actual !== options.sha512) {
      throw new DownloadChecksumError("更新包 sha512 校验失败，已丢弃这次下载。");
    }
  }
}
