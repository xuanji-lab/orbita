/**
 * `fs:line-index` / `fs:read-lines` 的实做（契约在 `shared/files.ts`）。**纯模块**
 * （同 read.ts / list.ts 的先例）：不 import electron，白名单与 realpath 在 ipc.ts 做完
 * 才把真实路径传进来，这里只管「给一份文件，建行索引 / 读一段行」，`node --test` 能直接加载测。
 *
 * 为什么需要一个索引：大于 PREVIEW_TEXT_LIMIT（16 MB）的文本不再整份进 renderer，
 * 面板改为「滚到哪儿读哪儿」。按行窗口化要求「第 N 行从第几个字节开始」，而换行符
 * 的位置不读一遍不知道——于是先扫一遍建检查点（每 1024 行一个字节偏移），之后任意
 * 行都能二分检查点 + 向前扫 ≤1024 行 + 读一小段，定位成本与文件体积无关。
 *
 * 三个数都是实的（2026-10-25 原型实测，100 MB / 90 万行日志，page cache 热）：
 * 整份索引 67–79 ms（8 MB 一块，单块 <10 ms，不产生 >50 ms 的长任务）；任意行定位
 * 0.01–0.25 ms；按行取窗 0.4–1.1 ms。索引约 16 KB / 100 MB。
 *
 * 事件循环：每扫完 8 MB `setImmediate` 让一次——主进程同时还管着窗口、IPC 与持久化，
 * 一口气读完 100 MB 会让 UI 卡住两百毫秒。
 *
 * 行口径（与 `wc -l` 一致）：按 `\n` 切，末尾换行**不**多出一个空行。`"a\nb\n"` 是 2 行，
 * `"a\nb"` 也是 2 行，空文件 0 行。行尾的 `\r`（CRLF）在解码后去掉——Windows 日志
 * 不该每条末尾挂一个不可见字符。
 */
import { open, stat } from "node:fs/promises";
import {
  PREVIEW_LINES_PER_READ,
  PREVIEW_MAX_INDEXED_LINES,
  PREVIEW_MAX_LINE_BYTES,
  type FileLineIndex,
  type FileLines,
  type FileLinesRequest,
} from "../../shared/files.ts";

/** 建索引时一次读多少字节：8 MB 一块在慢盘上也只要几毫秒，又不会把一次让出拖太长 */
const INDEX_CHUNK = 8 * 1024 * 1024;

/** 每多少行记一个检查点：1024 行 × 每行 ≤64 KB 是定位时向前扫的最坏工作量 */
const INDEX_STRIDE = 1024;

/** 读行窗口时一次读多少字节：一屏 600 行通常几十 KB，256 KB 够几十屏 */
const READ_CHUNK = 256 * 1024;

/** 二进制嗅探只看开头这么多字节（与 read.ts 的 BINARY_SNIFF_BYTES 同值同理由） */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** 索引缓存上限：同时开着几个大文件标签就换几次，3 条足够且每条只有十几 KB */
const INDEX_CACHE_LIMIT = 3;

/** 一份建好的索引（内部结构，回给 renderer 的只有 `FileLineIndex` 的字段） */
interface IndexEntry {
  indexId: string;
  path: string;
  size: number;
  modifiedAt: number;
  totalLines: number;
  /** checkpoints[i] = 第 i × INDEX_STRIDE 行首字节的偏移 */
  checkpoints: number[];
}

/** 缓存键里的顺序就是 LRU 顺序：命中时删了再插回去（Map 按插入顺序迭代） */
const cache = new Map<string, IndexEntry>();

/** 令牌 → 索引：`fs:read-lines` 只从这里取，renderer 传不了路径 */
const byToken = new Map<string, IndexEntry>();

let tokenSeq = 0;

/** 让出一次事件循环（8 MB 一块的扫描之间） */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 开头有没有 NUL 字节（<= 8 KB 的小文件整份看） */
async function looksBinary(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, BINARY_SNIFF_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

type ScanResult =
  | { kind: "ok"; totalLines: number; checkpoints: number[] }
  | { kind: "long-line" }
  | { kind: "too-many-lines" };

/**
 * 扫一遍换行建检查点。只读不缓存——缓存由 `buildLineIndex` 管（失败结果不进缓存：
 * 一个 100 MB 的单行文件一次就判完了，没必要为它留一条索引位）。
 *
 * 早退比扫完更值钱：单行超长在第 64 KB 就能判、行数超限在 1.8 M 行就判，两者都不必
 * 把几 GB 读完。文件在扫描期间增长时只索引开始那一刻的大小（`size` 是快照）。
 */
async function scanLines(path: string, size: number): Promise<ScanResult> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(INDEX_CHUNK, Math.max(1, size)));
    const checkpoints: number[] = [0];
    let lines = 0;
    let lineStartByte = 0;
    let maxLineBytes = 0;
    let pos = 0;
    while (pos < size) {
      const want = Math.min(buffer.length, size - pos);
      const { bytesRead } = await handle.read(buffer, 0, want, pos);
      if (bytesRead === 0) break;
      let from = 0;
      for (;;) {
        const nl = buffer.indexOf(10, from);
        if (nl < 0 || nl >= bytesRead) break;
        const completed = pos + nl - lineStartByte;
        if (completed > maxLineBytes) maxLineBytes = completed;
        if (maxLineBytes > PREVIEW_MAX_LINE_BYTES) return { kind: "long-line" };
        lines += 1;
        if (lines > PREVIEW_MAX_INDEXED_LINES) return { kind: "too-many-lines" };
        // 第 lines 行（0 起）从这里开始——每 stride 行记一个
        if (lines % INDEX_STRIDE === 0) checkpoints.push(pos + nl + 1);
        lineStartByte = pos + nl + 1;
        from = nl + 1;
      }
      // 块尾那段还没遇到换行：它就是某一行的开头，长度也要算进「最长行」——
      // 否则一条跨很多块的巨行要等到下一个换行才被发现
      const tail = pos + bytesRead - lineStartByte;
      if (tail > maxLineBytes) maxLineBytes = tail;
      if (maxLineBytes > PREVIEW_MAX_LINE_BYTES) return { kind: "long-line" };
      pos += bytesRead;
      if (pos < size) await yieldToLoop();
    }
    // 末尾没有换行的残行也是一行
    if (lineStartByte < size) lines += 1;
    return { kind: "ok", totalLines: lines, checkpoints };
  } finally {
    await handle.close();
  }
}

/** 把一条缓存项摊成契约里的 `ok` 回执 */
function okResult(entry: IndexEntry): FileLineIndex {
  return {
    kind: "ok",
    indexId: entry.indexId,
    totalLines: entry.totalLines,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  };
}

/**
 * 建（或命中缓存拿）一个文件的行索引。调用方已经过白名单，`path` 是 realpath 后的路径。
 *
 * 缓存键 `path + size + mtimeMs`：文件一改键就变，旧索引自然不再被命中；同时缓存里
 * 最多留 3 份，且每份只有十几 KB，不需要更复杂的淘汰策略。命中时**复用同一个令牌**
 * （renderer 手里的 `indexId` 因此一直有效）。
 */
export async function buildLineIndex(path: string): Promise<FileLineIndex> {
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;
  if (size === 0) return { kind: "empty", size, modifiedAt };

  const key = `${path}\u0000${size}\u0000${modifiedAt}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return okResult(hit);
  }

  if (await looksBinary(path, size)) return { kind: "binary", size, modifiedAt };

  const scan = await scanLines(path, size);
  if (scan.kind === "long-line") return { kind: "long-line", size, modifiedAt };
  if (scan.kind === "too-many-lines") {
    return { kind: "too-many-lines", limit: PREVIEW_MAX_INDEXED_LINES, size, modifiedAt };
  }

  const entry: IndexEntry = {
    indexId: `lines-${(tokenSeq += 1)}`,
    path,
    size,
    modifiedAt,
    totalLines: scan.totalLines,
    checkpoints: scan.checkpoints,
  };
  cache.set(key, entry);
  byToken.set(entry.indexId, entry);
  while (cache.size > INDEX_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted !== undefined) byToken.delete(evicted.indexId);
  }
  return okResult(entry);
}

/** 去掉行尾的 `\r`（CRLF 的行内容不带它；只去掉一个，行内的 `\r` 原样保留） */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 从 `startLine` 起读 `count` 行：二分检查点到最近的 1024 行边界，再从那里按块向前读、
 * 数到精确的起始行，边读边把行解出来。
 *
 * 为什么起点可以落在任意字节：检查点是**行首**（紧跟一个 `\n` 之后），所以从它开始扫
 * 天然按行对齐；块边界切在多字节 UTF-8 序列中间也不要紧——序列被留在 `carry` 里
 * 和下一块拼起来再解码，`\n` 的字节（0x0A）不会出现在 UTF-8 多字节序列内部，
 * 所以「按 0x0A 切块」与「按字符切」不会打架。
 */
async function readWindow(entry: IndexEntry, startLine: number, count: number): Promise<string[]> {
  const strideIndex = Math.min(
    entry.checkpoints.length - 1,
    Math.max(0, Math.floor(startLine / INDEX_STRIDE)),
  );
  let pos = entry.checkpoints[strideIndex] ?? 0;
  let lineNo = strideIndex * INDEX_STRIDE;

  const out: string[] = [];
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(1, entry.size - pos)));
  let carry: Buffer | null = null;

  const handle = await open(entry.path, "r");
  try {
    while (pos < entry.size && out.length < count) {
      const want = Math.min(buffer.length, entry.size - pos);
      const { bytesRead } = await handle.read(buffer, 0, want, pos);
      if (bytesRead === 0) break;
      let rest: Buffer = buffer.subarray(0, bytesRead);
      while (rest.length > 0) {
        const nl = rest.indexOf(10);
        if (nl < 0) {
          const tail = Buffer.from(rest);
          carry = carry === null ? tail : Buffer.concat([carry, tail]);
          break;
        }
        const body = carry === null ? rest.subarray(0, nl) : Buffer.concat([carry, rest.subarray(0, nl)]);
        if (lineNo >= startLine && out.length < count) out.push(stripCr(decoder.decode(body)));
        lineNo += 1;
        carry = null;
        rest = rest.subarray(nl + 1);
        if (out.length >= count) break;
      }
      pos += bytesRead;
    }
    // 末尾没有换行的残行：只有它是我们要的那一行时才补上（空内容也算一行——
    // 一个以 "\r" 结尾的文件，末行去掉 CR 之后就是空串）
    if (carry !== null && out.length < count && lineNo >= startLine) {
      out.push(stripCr(decoder.decode(carry)));
      lineNo += 1;
    }
  } finally {
    await handle.close();
  }
  return out;
}

/**
 * 按行读一段。令牌不认识 = 过期（缓存被挤掉 / 应用重启过）——直接 reject，
 * 让 renderer 重新索引，而不是猜一个文件去读。
 *
 * 文件在索引之后变过（大小或 mtime 不同）就回 `stale`：索引里的检查点对一份变了内容
 * 的文件不再可信，按它读出来的行是错的。renderer 收到 `stale` 重新索引即可。
 */
export async function readLines(req: FileLinesRequest): Promise<FileLines> {
  const entry = byToken.get(req.indexId);
  if (entry === undefined) {
    throw new Error("行索引已过期（缓存被换出或应用重启过），重新打开这个文件即可");
  }
  const stats = await stat(entry.path);
  if (stats.size !== entry.size || stats.mtimeMs !== entry.modifiedAt) {
    return { kind: "stale", size: stats.size, modifiedAt: stats.mtimeMs };
  }

  const count = Math.min(
    PREVIEW_LINES_PER_READ,
    Math.max(1, Number.isFinite(req.count) ? Math.floor(req.count) : PREVIEW_LINES_PER_READ),
  );
  const total = entry.totalLines;
  const startLine = Math.min(Math.max(0, Math.floor(Number.isFinite(req.startLine) ? req.startLine : 0)), Math.max(0, total - 1));
  const lines = total === 0 ? [] : await readWindow(entry, startLine, count);
  return {
    kind: "text",
    lines,
    startLine,
    totalLines: total,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  };
}
