/**
 * 未跟踪文件的行级统计 —— 专注左栏（`gitWorkdirChanges`）与审查面板
 * （`gitReviewList` 的 unstaged 一档）共用的**唯一**一份数行数逻辑。
 *
 * 之前两边各数各的：专注按 size+mtime 缓存、超 1 MB 只嗅二进制；审查面板把
 * 整个文件读进来、对着空文件造一份 diff 再数 `+`——同一个 50 MB 未跟踪文件
 * 在审查面板要 1 秒，600 MB 直接不可用；而两套口径又各自演化，行数可能对不上。
 * 现在只有一个计数器：同一个缓存键（绝对路径 + size + mtimeMs）、同一个 1 MB
 * 上限、同一次 8 KB 二进制嗅探、同一套计行口径，两边拿到的一定是同一个数。
 *
 * 行数口径：有结尾换行时与 `wc -l` 相同；没有结尾换行时把最后一行也算上
 * （与 git numstat 的 `+N` 一致——所以审查面板的 added 与专注左栏逐个相等）。
 *
 * 读盘边界（#372）：lstat 不跟符号链接，链接只报它指向哪（readlink 原文）、行数记 0；
 * 打开文件带 O_NOFOLLOW（POSIX；Windows 没有这个标志，靠前面的 lstat 判定）。
 */
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";

/**
 * 单文件行数统计的上限：1 MB。超过就只读开头判二进制、不数行（两边 UI 都显示
 * 「行数未知」）。理由：数行要把全文读进内存再 split，而专注左栏 30 秒问一遍
 * 全部未跟踪文件——生成物 / 日志 / 数据动辄几十 MB，为悬停才看的一个数字读它们
 * 是这条路径最贵的一步；1 MB 覆盖源码文本的绝大多数，越线的文件多半本来也不是
 * 「数行数」的对象。
 */
export const UNTRACKED_LINE_COUNT_MAX_BYTES = 1024 * 1024;

/** 判二进制只需开头这么多字节（git 的二进制嗅探同样只看前 8000 字节） */
export const UNTRACKED_BINARY_SNIFF_BYTES = 8 * 1024;

/** 未跟踪文件的面（注入点）：stat 定缓存键，read 按大小决定读全文还是读头 */
export interface UntrackedFileStat {
  size: number;
  mtimeMs: number;
}

export interface UntrackedProbe {
  /** lstat 语义：符号链接给 `{ symlink: 链接里写的目标 }`，不跟过去；不是普通文件 / 读不了 → null */
  stat(path: string): Promise<UntrackedFileStat | { symlink: string } | null>;
  /** maxBytes = null → 读全文；否则只读开头这么多字节。打开时不跟链接 */
  read(path: string, maxBytes: number | null): Promise<Buffer | null>;
}

/** 只读、且路径此刻是链接就打不开（ELOOP）：lstat 之后被换成链接也不会跟过去 */
const OPEN_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export const diskUntrackedProbe: UntrackedProbe = {
  async stat(path) {
    try {
      // lstat 不跟链接：stat 会把指向工作区外的未跟踪链接当成目标文件去数（#372 探针二）
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { symlink: await readlink(path) };
      return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  async read(path, maxBytes) {
    try {
      const handle = await open(path, OPEN_NO_FOLLOW);
      try {
        if (maxBytes === null) return await handle.readFile();
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  },
};

/** 一个未跟踪文件的行级统计（两边的契约各自映射成 FocusChangeEntry / ReviewEntry） */
export interface UntrackedLineStat {
  added: number;
  binary: boolean;
  /** 超过 1 MB 没数行：added 是 0 但**不是**「没改动」，UI 显示「行数未知」 */
  lineCountUnknown?: boolean;
  /** 符号链接：值是链接里写的目标（readlink 原文），不跟过去读，行数恒 0 */
  symlink?: string;
}

/**
 * 未跟踪文件行数的缓存：键 = 绝对路径 + size + mtimeMs。专注左栏每 30 秒问一遍
 * 全部未跟踪文件，而文件大多没变——不缓存时每轮把 29 MB 全文读一遍（实测 300 个
 * 文件约 0.3 s）。size 与 mtime 都没动就复用上次的结论，只花一次 stat。
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

/**
 * 「对着空文件算」的行数：与 `createTwoFilesPatch("", content)` 的 `+` 行数同口径
 * （末尾换行不额外算一行），但不跑 diff 算法——这条路径上每轮几百个文件，纯计数只扫一遍。
 */
export function countUntrackedLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** 一个未跟踪文件的行级统计；null = 读不了（刚被删 / 不是文件） */
export async function untrackedLineStat(
  path: string,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<UntrackedLineStat | null> {
  const info = await probe.stat(path);
  if (info === null) return null;
  // 链接不进缓存：lstat + readlink 已经是全部开销，没有可省的读盘
  if ("symlink" in info) return { added: 0, binary: false, symlink: info.symlink };
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
  const hit = untrackedLineCache.get(key);
  if (hit !== undefined) return rememberUntrackedLine(key, hit);

  const oversized = info.size > UNTRACKED_LINE_COUNT_MAX_BYTES;
  // 二进制判定与行数统计共用这一次读盘：小文件读一次全文（既判 NUL 又数行）；
  // 大文件只读头 8 KB，NUL 在开头都没有就按文本处理、行数记「未知」
  const bytes = await probe.read(path, oversized ? UNTRACKED_BINARY_SNIFF_BYTES : null);
  if (bytes === null) return null;
  if (bytes.includes(0)) return rememberUntrackedLine(key, { added: 0, binary: true });
  if (oversized) {
    return rememberUntrackedLine(key, { added: 0, binary: false, lineCountUnknown: true });
  }
  return rememberUntrackedLine(key, { added: countUntrackedLines(bytes.toString("utf8")), binary: false });
}
