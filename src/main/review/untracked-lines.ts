/**
 * 未跟踪文件的行级统计 —— 专注左栏（`gitWorkdirChanges`）与审查面板
 * （`gitReviewList` 的 unstaged 一档）共用的**唯一**一份数行数逻辑。
 *
 * 为什么只能有一份：两处问的是同一个事实（同一个文件有几行）。各写一套就会各自演化——
 * #315 之前专注有缓存、审查面板没有，同一个 50 MB 未跟踪文件在审查面板慢一个数量级；
 * #355 撤回后两边又一起退回「整份读进来 + 造 diff 数 `+`」。现在只有一个计数器：同一个
 * 缓存、同一个上限、同一套口径，两边拿到的一定是同一个数；专注左栏 30 秒一轮把缓存热好，
 * 打开审查面板就只花 lstat。
 *
 * 为什么要自己读盘：git 的 `diff --numstat` 不管未跟踪文件（要它管得先 `git add -N`
 * 写 index，而这里只读）。数法照 git 对新文件的口径，但不生成 diff：
 * - 二进制 = 开头 8000 字节里有 NUL（git 的 buffer_is_binary 看的就是这个窗口）；
 * - 行数 = 换行字节（0x0A）的个数，最后一行没有换行再 +1。CRLF 算一行，单独的 CR 不算换行，
 *   同 git。以前造 diff 再数 `+` 的写法会把以 `++` 开头的行当成 `+++` 文件头漏掉，
 *   8000 字节之后才出现 NUL 的文本会被整份当成二进制——两处都和 git numstat 对不上。
 * 按块流式读、逐字节数，不转字符串：耗时只跟字节数有关，与行长短无关。
 *
 * 读盘边界（#372）：lstat 不跟符号链接，链接只报它指向哪（readlink 原文）、行数记 0；
 * 打开文件带 O_NOFOLLOW（POSIX；Windows 没有这个标志，靠前面的 lstat 判定）。
 */
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";

/**
 * 单文件计数上限：64 MB。超过只读开头判二进制，行数记「未知」。
 * 数一遍的代价只跟字节数有关：本机（Apple M 系列，页缓存热）实测约 1 ms/MB，64 MB 约 65 ms；
 * 按 256 KB 一块读，每块的同步计数 < 0.5 ms，不长时间占住主进程。文件没变时不读（缓存），
 * 只有变了（例如正在写的日志）才重数。再大的文件（几百 MB 的数据、转储）数出来也只是悬停里的
 * 一个数字，不值得每次变动都读一遍；git 自己也把超过 core.bigFileThreshold（512 MB）的文件当二进制。
 */
export const UNTRACKED_LINE_COUNT_MAX_BYTES = 64 * 1024 * 1024;

/** 判二进制看开头这么多字节：git 的 FIRST_FEW_BYTES（xdiff-interface.c）就是 8000 */
export const GIT_BINARY_SNIFF_BYTES = 8000;

/** 每次 read 的块大小：一块逐字节数完约 0.3 ms，事件循环不会被一个大文件占住 */
const READ_CHUNK_BYTES = 256 * 1024;

/** lstat 的结论：普通文件 / 符号链接 / 其他（目录、管道……不数） */
export interface UntrackedFileInfo {
  kind: "file" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

/** 打开的文件：从 position 起读至多 length 字节到 buffer 开头，返回读到的字节数（0 = 到头） */
export interface UntrackedHandle {
  read(buffer: Buffer, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

/** 未跟踪文件的读盘面（注入点，测试喂假货）：读不了一律 null，不抛 */
export interface UntrackedProbe {
  /** lstat 语义：链接本身是什么就报什么，不跟过去 */
  lstat(path: string): Promise<UntrackedFileInfo | null>;
  /** 链接里写的目标（readlink 原文） */
  readlink(path: string): Promise<string | null>;
  /** 只读打开，路径此刻是链接就打不开 */
  open(path: string): Promise<UntrackedHandle | null>;
}

/** 只读、且路径此刻是链接就打不开（ELOOP）：lstat 之后被换成链接也不会跟过去 */
const OPEN_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export const diskUntrackedProbe: UntrackedProbe = {
  async lstat(path) {
    try {
      // lstat 不跟链接：stat 会把指向工作区外的未跟踪链接当成目标文件去数（#372 探针二）
      const info = await lstat(path);
      const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other";
      return { kind, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  },
  async readlink(path) {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  },
  async open(path) {
    try {
      const handle = await open(path, OPEN_NO_FOLLOW);
      return {
        async read(buffer, length, position) {
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          return bytesRead;
        },
        close: () => handle.close(),
      };
    } catch {
      return null;
    }
  },
};

/** 一个未跟踪文件的行级统计（两边的契约各自映射成 FocusChangeEntry / ReviewEntry） */
export interface UntrackedLineStat {
  added: number;
  binary: boolean;
  /** 没数行（超过单文件计数上限）：added 是 0 但**不是**「没改动」，UI 显示「行数未知」 */
  lineCountUnknown?: boolean;
  /** 符号链接：值是链接里写的目标（readlink 原文），不跟过去读，行数恒 0 */
  symlink?: string;
}

/**
 * 未跟踪文件行数的缓存：键 = 绝对路径 + size + mtimeMs。专注左栏每 30 秒问一遍
 * 全部未跟踪文件，而文件大多没变——不缓存时每轮把 29 MB 全文读一遍（实测 300 个
 * 文件约 0.3 s）。size 与 mtime 都没动就复用上次的结论，只花一次 lstat。
 * 容量上限 2000 是防无界增长的闸：超了按 LRU 淘汰最久没被问到的。
 */
const UNTRACKED_LINE_CACHE_LIMIT = 2000;
const untrackedLineCache = new Map<string, UntrackedLineStat>();

function rememberUntrackedLine(key: string, lineStat: UntrackedLineStat): UntrackedLineStat {
  // 命中也要先删再塞：Map 的迭代顺序 = 插入顺序，队首永远是最久没被问到的
  untrackedLineCache.delete(key);
  untrackedLineCache.set(key, lineStat);
  while (untrackedLineCache.size > UNTRACKED_LINE_CACHE_LIMIT) {
    const oldest = untrackedLineCache.keys().next().value;
    if (oldest === undefined) break;
    untrackedLineCache.delete(oldest);
  }
  return lineStat;
}

/** 一块字节里有几个换行（0x0A）。逐字节比：indexOf 逐个找在短行文件上会退化到每个换行一次调用 */
function newlinesIn(buffer: Buffer, length: number): number {
  let count = 0;
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0x0a) count += 1;
  }
  return count;
}

/**
 * 数一个普通文件：先读开头 8000 字节判二进制（二进制与超限文件读到这里就停），文本再按块数完。
 * 只读到 lstat 时的 size 为止：正在被追加的日志，数的是 lstat 那一刻的样子，与缓存键一致；
 * 下一轮 mtime 变了自然重数。读到一半出错（被删、权限变了）→ null，这一轮跳过。
 */
async function countFile(path: string, size: number, probe: UntrackedProbe): Promise<UntrackedLineStat | null> {
  if (size === 0) return { added: 0, binary: false };
  const handle = await probe.open(path);
  if (handle === null) return null;
  // 缓冲按文件大小分：小文件走 Buffer 池，不为几十字节的文件分 256 KB。不跨调用共用一块——
  // 专注轮询与审查列表可能同时在数，共用的缓冲会在 await 之间被对方写掉
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size));
  try {
    // 判二进制的窗口要读满（read 可能读得比要的少，网络盘上常见）
    const sniffWant = Math.min(size, GIT_BINARY_SNIFF_BYTES);
    let sniffed = 0;
    while (sniffed < sniffWant) {
      const got = await handle.read(buffer.subarray(sniffed), sniffWant - sniffed, sniffed);
      if (got === 0) break;
      sniffed += got;
    }
    if (buffer.subarray(0, sniffed).includes(0)) return { added: 0, binary: true };
    if (size > UNTRACKED_LINE_COUNT_MAX_BYTES) return { added: 0, binary: false, lineCountUnknown: true };

    let lines = newlinesIn(buffer, sniffed);
    let position = sniffed;
    let last = sniffed > 0 ? buffer[sniffed - 1] : 0x0a;
    while (position < size) {
      const got = await handle.read(buffer, Math.min(buffer.length, size - position), position);
      if (got === 0) break; // 读的过程中文件变短了：数到哪算哪
      lines += newlinesIn(buffer, got);
      last = buffer[got - 1];
      position += got;
    }
    // 最后一行没有换行也是一行（git numstat 同口径；wc -l 不算它）
    return { added: position > 0 && last !== 0x0a ? lines + 1 : lines, binary: false };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 一个未跟踪文件的行级统计；null = 读不了（刚被删 / 不是普通文件） */
export async function untrackedLineStat(
  path: string,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<UntrackedLineStat | null> {
  const info = await probe.lstat(path);
  if (info === null || info.kind === "other") return null;
  if (info.kind === "symlink") {
    // 链接不进缓存：lstat + readlink 已经是全部开销，没有可省的读盘
    const target = await probe.readlink(path);
    return target === null ? null : { added: 0, binary: false, symlink: target };
  }
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
  const hit = untrackedLineCache.get(key);
  if (hit !== undefined) return rememberUntrackedLine(key, hit);
  const counted = await countFile(path, info.size, probe);
  return counted === null ? null : rememberUntrackedLine(key, counted);
}
