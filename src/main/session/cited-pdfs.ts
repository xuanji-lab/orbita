/**
 * 「本会话引用过哪些 PDF」的索引：文件面板据此让被 cite_pdf 核验过的 PDF 原地打开
 * （根清单里的 `cited` 根，见 shared/files.ts），不用把 PDF 拷进会话目录。
 *
 * 来源只有一个：本会话 JSONL 里 `cite_pdf` 工具结果的 `details.pdfCitations[].path`
 * （引用是主进程在 cite_pdf 执行时逐字核验后写进记录的，模型与 renderer 都编不出来）。
 * 只收 `.pdf`。**纯模块**（不 import electron），可被 `node --test` 直接测。
 *
 * ## 性能
 * `fs:roots` / `fs:list` / `fs:read-pdf` 每次调用都会现算根清单，不能每次整份重读 JSONL
 * （开发数据里最大一条会话 145MB）。所以：
 * - 每条会话缓存一份「已读到哪个字节 + 已收的路径集合」，之后每次只 stat 一次；
 * - 文件变长（append-only，session store 的 record 只追加）就只读新增的那一段，
 *   而且只交以换行收尾的整行——半截行留给下一次，不会丢；
 * - 首读与增量都走 jsonl-scan 的流式扫描，**按行首的 role / toolName 粗筛**：工具结果里
 *   几 MB 的 read_pdf 大行整行不解码，只有 cite_pdf 的行才 JSON.parse；
 * - 整份重写（分支 / 导入更新走临时文件 + rename）会换 inode，或者文件变短——缓存作废重扫。
 * 同一条会话的并发调用排成一条链，不会对同一段字节扫两遍、也不会互相覆盖偏移。
 */
import { stat } from "node:fs/promises";
import { isPdfFile } from "../../shared/files.ts";
import { citationsOfDetails } from "../../shared/pdf-quote.ts";
import { isNotFound } from "../fs-errors.ts";
import { headStringField, scanJsonlLines } from "../jsonl-scan.ts";

interface SessionEntry {
  /** 已扫到（且以换行收尾）的字节位置 */
  offset: number;
  /** 上次 stat 看到的 inode：变了说明整份被换过（原子重写） */
  ino: number | bigint;
  paths: Set<string>;
}

export class CitedPdfIndex {
  private readonly logPath: (id: string) => string;
  private readonly entries = new Map<string, SessionEntry>();
  /** 每条会话一条调用链 */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(logPath: (id: string) => string) {
    this.logPath = logPath;
  }

  /** 本会话 cite_pdf 核验过的 PDF 绝对路径（去重，按首次出现的顺序）。日志不存在 = 空 */
  paths(id: string): Promise<string[]> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(() => this.refresh(id));
    // 链上不留失败：一次读盘出错不该让后面的调用都跟着失败
    this.chains.set(id, run.catch(() => undefined));
    return run;
  }

  /** 会话被删：丢掉缓存 */
  forget(id: string): void {
    this.entries.delete(id);
    this.chains.delete(id);
  }

  private async refresh(id: string): Promise<string[]> {
    const path = this.logPath(id);
    let size: number;
    let ino: number | bigint;
    try {
      const stats = await stat(path);
      size = stats.size;
      ino = stats.ino;
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      this.entries.delete(id);
      return [];
    }
    let entry = this.entries.get(id);
    // 换过文件（inode 变）或变短：旧缓存不可信，从头扫
    if (entry !== undefined && (entry.ino !== ino || size < entry.offset)) entry = undefined;
    if (entry === undefined) entry = { offset: 0, ino, paths: new Set() };
    if (size > entry.offset) {
      const found = entry.paths;
      entry.offset = await scanJsonlLines(
        path,
        keepLine,
        (line) => collect(line, found),
        undefined,
        { start: entry.offset, endExclusive: size, terminatedOnly: true },
      );
    }
    this.entries.set(id, entry);
    return [...entry.paths];
  }
}

/** 行首粗筛：role 是 tool 且 toolName 是 cite_pdf；行首里看不到这两个键的行保守留下（整行解析再精筛） */
function keepLine(head: string): boolean {
  const role = headStringField(head, "role");
  if (role !== undefined && role !== "tool") return false;
  const toolName = headStringField(head, "toolName");
  return toolName === undefined || toolName === "cite_pdf";
}

function collect(line: string, into: Set<string>): void {
  // 先用子串挡掉绝大多数行，再 parse
  if (!line.includes('"pdfCitations"')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // 坏行跳过
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as { role?: unknown; toolName?: unknown; details?: unknown };
  if (record.role !== "tool" || record.toolName !== "cite_pdf") return;
  for (const citation of citationsOfDetails(record.details)) {
    if (isPdfFile(citation.path)) into.add(citation.path);
  }
}
