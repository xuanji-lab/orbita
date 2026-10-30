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
 *
 * ## 正在写入的日志（增量索引）
 *
 * 日志一边预览一边在长，是这个功能最常见的场景。索引因此**每个文件只留一条、按路径存**，
 * 文件变长时在原索引上接着扫，令牌不变：
 * - 判「只是变长」：大小变大、同一个 inode（dev + ino）、**旧末尾那 4 KB 的内容没变**
 *   （建索引时存了一份样本，续扫前读回来比一遍）。三条都满足才认；
 * - 续扫从「上一次末尾那条没收尾的残行」的行首开始（`tailStart`），不是从旧末尾——
 *   `"a\nb"` 后面追加 `"c\n"`，第二行是 `"bc"`；
 * - **这是启发式**：旧末尾样本没变不等于前面没被改。有人把文件前半段原地改了又在末尾
 *   追加，我们认不出来（要认就得把全文再读一遍，那就不叫增量了）。日志的写法是追加，
 *   原地改写的文件（编辑器保存多半换 inode 或改大小与末尾）落到下面的 stale；
 * - 不满足的一律 `stale`（renderer 自动重建一次，见 RangeTextPreview）：变小、换了文件、
 *   末尾样本对不上、大小没变但 mtime 变了。
 *
 * ## 在途去重与取消
 *
 * 同一个路径同时只扫一遍：后来的请求并进已在途的那一次（多标签打开同一个文件、
 * `fs:line-index` 与 `fs:read-lines` 同时发现文件变长）。扫描的取消按「等着结果的人数」
 * 记：每个请求带自己的 AbortSignal，**最后一个等的人走了才真正停**——两个标签看同一个文件，
 * 关掉一个不该打断另一个。
 */
import { open, stat } from "node:fs/promises";
import {
  PREVIEW_BINARY_SNIFF_BYTES,
  PREVIEW_LINES_PER_READ,
  PREVIEW_MAX_INDEX_BYTES,
  PREVIEW_MAX_LINE_BYTES,
  type FileLineIndex,
  type FileLines,
  type FileLinesRequest,
} from "../../shared/files.ts";
import { readTextHead } from "./read.ts";

/** 建索引时一次读多少字节：8 MB 一块在慢盘上也只要几毫秒，又不会把一次让出拖太长 */
const INDEX_CHUNK = 8 * 1024 * 1024;

/** 每多少行记一个检查点：1024 行 × 每行 ≤64 KB 是定位时向前扫的最坏工作量 */
const INDEX_STRIDE = 1024;

/** 读行窗口时一次读多少字节：一屏 600 行通常几十 KB，256 KB 够几十屏 */
const READ_CHUNK = 256 * 1024;

/**
 * 索引缓存上限：每份只有十几 KB（检查点表 + 4 KB 样本），多留几份很便宜；留多了的价值是
 * 同时开着几个大文件标签来回切时不必每次重扫。每次用到（建索引命中 / 取窗）都刷新新旧顺序，
 * 所以「正在看的那个」不会因为别的标签建了索引而被挤掉。
 */
const INDEX_CACHE_LIMIT = 8;

/** 「前面没改」的样本：旧末尾往前这么多字节，续扫前读回来比对 */
const TAIL_SAMPLE_BYTES = 4 * 1024;

/** 一份建好的索引（内部结构，回给 renderer 的只有 `FileLineIndex` 的字段） */
interface IndexEntry {
  indexId: string;
  path: string;
  /** 已索引到的字节数（建索引 / 最近一次续扫时的文件大小） */
  size: number;
  modifiedAt: number;
  /** 判「同一个文件」：换了 inode 就是被替换过（logrotate 的 rename 式轮转） */
  dev: number;
  ino: number;
  /** 已收尾（以 `\n` 结束）的行数 */
  doneLines: number;
  /** 第 doneLines 行（末尾没收尾的残行，可能不存在）的起始字节；续扫从这里开始 */
  tailStart: number;
  /** 见过的最长一行的字节数（含末尾残行已有的部分） */
  maxLineBytes: number;
  /** checkpoints[i] = 第 i × INDEX_STRIDE 行首字节的偏移 */
  checkpoints: number[];
  /** `[size - sample.length, size)` 的内容：续扫前确认「前面没改」 */
  sample: Buffer;
}

/** 缓存键 = 路径，插入顺序就是 LRU 顺序：用到时删了再插回去（Map 按插入顺序迭代） */
const entriesByPath = new Map<string, IndexEntry>();

/** 令牌 → 索引：`fs:read-lines` 只从这里取，renderer 传不了路径 */
const byToken = new Map<string, IndexEntry>();

/** 在途的扫描，按路径合并 */
const jobs = new Map<string, Job>();

let tokenSeq = 0;

/** 一次在途的扫描（新建 / 续扫）。`waiters` = 还在等结果的请求数，归零才真停 */
interface Job {
  promise: Promise<JobResult>;
  controller: AbortController;
  waiters: number;
}

type JobResult =
  | { kind: "ok"; entry: IndexEntry }
  | { kind: "binary"; size: number; modifiedAt: number }
  | { kind: "long-line"; size: number; modifiedAt: number }
  | { kind: "cancelled" };

/** 让出一次事件循环（8 MB 一块的扫描之间） */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 文件里的总行数：已收尾的行 + 末尾没收尾的残行（如果有） */
function totalLinesOf(entry: IndexEntry): number {
  return entry.doneLines + (entry.tailStart < entry.size ? 1 : 0);
}

/** 用到了：排到最近使用的位置 */
function touch(entry: IndexEntry): void {
  if (entriesByPath.get(entry.path) !== entry) return;
  entriesByPath.delete(entry.path);
  entriesByPath.set(entry.path, entry);
}

/** 丢掉一条索引（令牌随之失效） */
function drop(path: string): void {
  const entry = entriesByPath.get(path);
  if (entry === undefined) return;
  entriesByPath.delete(path);
  byToken.delete(entry.indexId);
}

/** 装进缓存（同一路径的旧条目与令牌一并换掉），超出上限就丢最久没用的 */
function install(entry: IndexEntry): void {
  drop(entry.path);
  entriesByPath.set(entry.path, entry);
  byToken.set(entry.indexId, entry);
  while (entriesByPath.size > INDEX_CACHE_LIMIT) {
    const oldest = entriesByPath.keys().next();
    if (oldest.done === true) break;
    drop(oldest.value);
  }
}

/** 开头有没有 NUL 字节（<= 8 KB 的小文件整份看） */
async function looksBinary(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_BINARY_SNIFF_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** 读 `[size - 样本长度, size)` 作为「前面没改」的样本 */
async function readSample(path: string, size: number): Promise<Buffer> {
  const length = Math.min(size, TAIL_SAMPLE_BYTES);
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 旧末尾那段现在读回来，和建索引时存的样本一样吗 */
async function sampleStillMatches(entry: IndexEntry): Promise<boolean> {
  const now = await readSample(entry.path, entry.size);
  return now.length === entry.sample.length && now.equals(entry.sample);
}

/** 扫描的进度：新建从空开始，续扫从上一次的结果接着走（扫的是一份拷贝，取消 / 失败不会弄脏缓存里的条目） */
interface ScanState {
  doneLines: number;
  tailStart: number;
  maxLineBytes: number;
  checkpoints: number[];
}

type ScanOutcome = "ok" | "long-line" | "cancelled";

/**
 * 从 `state.tailStart` 扫到 `size`，把换行位置记进 `state`。只读不缓存——缓存由调用方管。
 *
 * 早退比扫完更值钱：单行超长在第 64 KB 就能判，不必把几 GB 读完。每块之间检查取消信号。
 * 文件在扫描期间增长时只索引开始那一刻的大小（`size` 是快照）。
 */
async function scanFrom(path: string, state: ScanState, size: number, signal: AbortSignal): Promise<ScanOutcome> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(INDEX_CHUNK, Math.max(1, size - state.tailStart)));
    let pos = state.tailStart;
    while (pos < size) {
      if (signal.aborted) return "cancelled";
      const want = Math.min(buffer.length, size - pos);
      const { bytesRead } = await handle.read(buffer, 0, want, pos);
      if (bytesRead === 0) break;
      let from = 0;
      for (;;) {
        const nl = buffer.indexOf(10, from);
        if (nl < 0 || nl >= bytesRead) break;
        const completed = pos + nl - state.tailStart;
        if (completed > state.maxLineBytes) state.maxLineBytes = completed;
        if (state.maxLineBytes > PREVIEW_MAX_LINE_BYTES) return "long-line";
        state.doneLines += 1;
        // 第 doneLines 行（0 起）从这里开始——每 stride 行记一个
        if (state.doneLines % INDEX_STRIDE === 0) state.checkpoints.push(pos + nl + 1);
        state.tailStart = pos + nl + 1;
        from = nl + 1;
      }
      // 块尾那段还没遇到换行：它就是某一行的开头，长度也要算进「最长行」——
      // 否则一条跨很多块的巨行要等到下一个换行才被发现
      const tail = pos + bytesRead - state.tailStart;
      if (tail > state.maxLineBytes) state.maxLineBytes = tail;
      if (state.maxLineBytes > PREVIEW_MAX_LINE_BYTES) return "long-line";
      pos += bytesRead;
      if (pos < size) await yieldToLoop();
    }
    return "ok";
  } finally {
    await handle.close();
  }
}

/** 这一刻的文件相对索引是什么关系 */
type Relation = "same" | "grown" | "changed";

function relationOf(entry: IndexEntry, stats: { size: number; mtimeMs: number; dev: number; ino: number }): Relation {
  if (stats.size === entry.size && stats.mtimeMs === entry.modifiedAt) return "same";
  // 只是变长的候选：变大、同一个文件、没超过扫描上限（样本比对在续扫任务里做，那里才读盘）
  if (
    stats.size > entry.size &&
    stats.size <= PREVIEW_MAX_INDEX_BYTES &&
    stats.dev === entry.dev &&
    stats.ino === entry.ino
  ) {
    return "grown";
  }
  return "changed";
}

interface FileStats {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** 从头建一条索引（含二进制嗅探），成功就装进缓存 */
async function buildFresh(path: string, stats: FileStats, signal: AbortSignal): Promise<JobResult> {
  if (await looksBinary(path, stats.size)) {
    drop(path);
    return { kind: "binary", size: stats.size, modifiedAt: stats.mtimeMs };
  }
  const state: ScanState = { doneLines: 0, tailStart: 0, maxLineBytes: 0, checkpoints: [0] };
  const outcome = await scanFrom(path, state, stats.size, signal);
  if (outcome === "cancelled") return { kind: "cancelled" };
  if (outcome === "long-line") {
    drop(path);
    return { kind: "long-line", size: stats.size, modifiedAt: stats.mtimeMs };
  }
  const entry: IndexEntry = {
    indexId: `lines-${(tokenSeq += 1)}`,
    path,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
    ...state,
    sample: await readSample(path, stats.size),
  };
  install(entry);
  return { kind: "ok", entry };
}

/** 在原索引上接着扫到新的末尾；令牌不变 */
async function extend(entry: IndexEntry, stats: FileStats, signal: AbortSignal): Promise<JobResult> {
  const state: ScanState = {
    doneLines: entry.doneLines,
    tailStart: entry.tailStart,
    maxLineBytes: entry.maxLineBytes,
    checkpoints: entry.checkpoints.slice(),
  };
  const outcome = await scanFrom(entry.path, state, stats.size, signal);
  if (outcome === "cancelled") return { kind: "cancelled" };
  if (outcome === "long-line") {
    // 追加进来一条超长行：这份文件不再适合分段预览，旧令牌作废
    drop(entry.path);
    return { kind: "long-line", size: stats.size, modifiedAt: stats.mtimeMs };
  }
  const sample = await readSample(entry.path, stats.size);
  // 以下全是同步赋值：并发的取窗在它的第一个 await 之前就把所需的快照拿走了，不会读到半新半旧
  entry.size = stats.size;
  entry.modifiedAt = stats.mtimeMs;
  entry.doneLines = state.doneLines;
  entry.tailStart = state.tailStart;
  entry.maxLineBytes = state.maxLineBytes;
  entry.checkpoints = state.checkpoints;
  entry.sample = sample;
  return { kind: "ok", entry };
}

/** 一次扫描任务：能续扫就续（先验样本），否则从头建 */
async function runJob(path: string, stats: FileStats, entry: IndexEntry | undefined, signal: AbortSignal): Promise<JobResult> {
  if (entry !== undefined && relationOf(entry, stats) === "grown" && (await sampleStillMatches(entry))) {
    return extend(entry, stats, signal);
  }
  return buildFresh(path, stats, signal);
}

/** 起一个任务并登记（同步完成——登记与调用方「看一眼 jobs 里有没有」之间不能有 await） */
function startJob(path: string, stats: FileStats, entry: IndexEntry | undefined): Job {
  const controller = new AbortController();
  const job: Job = { controller, waiters: 0, promise: Promise.resolve({ kind: "cancelled" }) };
  job.promise = runJob(path, stats, entry, controller.signal).finally(() => {
    // 被取消的旧任务收尾时，同路径可能已经有新任务顶上了，不能把新的登记删掉
    if (jobs.get(path) === job) jobs.delete(path);
  });
  // 等结果的请求都自带 then / finally；这一句只是防「请求在任务失败前就已取消」时留下一个没人接的 rejection
  job.promise.catch(() => undefined);
  jobs.set(path, job);
  return job;
}

/** 找一个能并进去的在途任务；已经被取消、只是还没停下来的不算（并进去会拿到别人的「取消」） */
function activeJob(path: string): Job | undefined {
  const job = jobs.get(path);
  if (job === undefined) return undefined;
  if (job.controller.signal.aborted) {
    jobs.delete(path);
    return undefined;
  }
  return job;
}

/**
 * 等一个任务的结果。`signal` 是这个请求自己的取消信号：触发时这个请求立刻拿到 `cancelled`，
 * 任务本身只在等它的人都走光之后才停。
 */
function joinJob(job: Job, signal: AbortSignal | undefined): Promise<JobResult> {
  job.waiters += 1;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    job.waiters -= 1;
    if (job.waiters === 0) job.controller.abort();
  };
  if (signal === undefined) return job.promise.finally(leave);
  return new Promise<JobResult>((resolve, reject) => {
    const onAbort = (): void => {
      leave();
      resolve({ kind: "cancelled" });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    job.promise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        leave();
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        leave();
        reject(error);
      },
    );
  });
}

/** 把一条缓存项摊成契约里的 `ok` 回执 */
function okResult(entry: IndexEntry): FileLineIndex {
  return {
    kind: "ok",
    indexId: entry.indexId,
    totalLines: totalLinesOf(entry),
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  };
}

/**
 * 建（或命中缓存拿）一个文件的行索引。调用方已经过白名单，`path` 是 realpath 后的路径。
 *
 * 命中缓存（大小与 mtime 都没变）复用同一个令牌；文件只是变长就接着扫、令牌也不变；
 * 被改写 / 替换才换新令牌。超过 PREVIEW_MAX_INDEX_BYTES 的文件根本不扫。
 * `signal` 触发时回 `{ kind: "cancelled" }`（多个请求并在同一次扫描上时，最后一个走了才真停）。
 * 回 `long-line` 时才读开头 16 MB 带进回执（见上）。
 */
export async function buildLineIndex(path: string, signal?: AbortSignal): Promise<FileLineIndex> {
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;
  if (size === 0) {
    drop(path);
    return { kind: "empty", size, modifiedAt };
  }
  if (size > PREVIEW_MAX_INDEX_BYTES) {
    drop(path);
    return { kind: "too-large", limit: PREVIEW_MAX_INDEX_BYTES, size, modifiedAt };
  }

  const entry = entriesByPath.get(path);
  if (entry !== undefined && relationOf(entry, stats) === "same") {
    touch(entry);
    return okResult(entry);
  }

  const job = activeJob(path) ?? startJob(path, stats, entry);
  const result = await joinJob(job, signal);
  switch (result.kind) {
    case "ok":
      touch(result.entry);
      return okResult(result.entry);
    case "cancelled":
      return { kind: "cancelled" };
    case "long-line":
      // 一条行没法再窗口化：renderer 退回「前 16 MB + 长行硬切」，开头文本随这条回执带上
      // （只有这一种情形才让 16 MB 过 IPC；普通大日志的首帧一个正文字节都不走）
      return { ...result, headText: await readTextHead(path) };
    default:
      return result;
  }
}

/** 去掉行尾的 `\r`（CRLF 的行内容不带它；只去掉一个，行内的 `\r` 原样保留） */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 读一个窗口所需的索引快照：取窗中途文件被续扫，不影响这一次读 */
interface Snapshot {
  path: string;
  size: number;
  checkpoints: readonly number[];
  totalLines: number;
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
async function readWindow(snap: Snapshot, startLine: number, count: number): Promise<string[]> {
  const strideIndex = Math.min(
    snap.checkpoints.length - 1,
    Math.max(0, Math.floor(startLine / INDEX_STRIDE)),
  );
  let pos = snap.checkpoints[strideIndex] ?? 0;
  let lineNo = strideIndex * INDEX_STRIDE;

  const out: string[] = [];
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(1, snap.size - pos)));
  let carry: Buffer | null = null;

  const handle = await open(snap.path, "r");
  try {
    while (pos < snap.size && out.length < count) {
      const want = Math.min(buffer.length, snap.size - pos);
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
 * 按行读一段。令牌不认识（缓存把它挤掉了 / 应用重启过）回 `expired`，让 renderer 重新索引，
 * 而不是猜一个文件去读。
 *
 * 取窗前先看文件有没有变：没变直接读；**只是变长**（正在写入的日志）就接着扫索引再读，
 * 回执里的 `totalLines` 因此可能比 renderer 手里的大；被改写 / 截断 / 替换回 `stale`——
 * 索引里的检查点对一份变了内容的文件不再可信，按它读出来的行是错的。
 */
export async function readLines(req: FileLinesRequest): Promise<FileLines> {
  const entry = byToken.get(req.indexId);
  if (entry === undefined) return { kind: "expired" };
  touch(entry);

  const stats = await stat(entry.path);
  const relation = relationOf(entry, stats);
  if (relation === "changed") return { kind: "stale", size: stats.size, modifiedAt: stats.mtimeMs };
  if (relation === "grown") {
    const job = activeJob(entry.path) ?? startJob(entry.path, stats, entry);
    const result = await joinJob(job, undefined);
    // 续扫成功时 entry 原地更新；样本对不上 / 追加了超长行 / 被别的请求从头重建，都是「这个令牌不能用了」
    if (result.kind !== "ok" || result.entry !== entry) {
      return { kind: "stale", size: stats.size, modifiedAt: stats.mtimeMs };
    }
  }

  // 同步拿走快照：从这里到读完，续扫再改 entry 也不影响这一次
  const snap: Snapshot = {
    path: entry.path,
    size: entry.size,
    checkpoints: entry.checkpoints,
    totalLines: totalLinesOf(entry),
  };
  const modifiedAt = entry.modifiedAt;
  const count = Math.min(
    PREVIEW_LINES_PER_READ,
    Math.max(1, Number.isFinite(req.count) ? Math.floor(req.count) : PREVIEW_LINES_PER_READ),
  );
  const total = snap.totalLines;
  const startLine = Math.min(Math.max(0, Math.floor(Number.isFinite(req.startLine) ? req.startLine : 0)), Math.max(0, total - 1));
  const lines = total === 0 ? [] : await readWindow(snap, startLine, count);
  return { kind: "text", lines, startLine, totalLines: total, size: snap.size, modifiedAt };
}
