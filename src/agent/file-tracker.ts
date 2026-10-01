/**
 * 轮内文件快照跟踪 —— 会话回退 / 单轮撤销 / 轮尾卡片的数据源。
 *
 * 挂在两处：
 *   1. tool_call 闸门**放行之后**（prepare 阶段，pi 先顺序跑完一批的钩子再并行执行）：
 *      write / edit 的路径首次出现时读一次 before（该轮动手前的内容）。
 *   2. tool_execution_end：该路径的 after 更新为执行后的磁盘现状（同一路径一轮改
 *      多次只留最后一份——回退要的是「这轮结束时它长什么样」）。
 *
 * 落定时 finalize()：算 +N −M 行级统计，**before == after 的路径整个丢弃**
 * （没有发生过真实改动，不该出现在轮尾卡片或回退清单里）。
 *
 * 跟踪面只认 write / edit——bash 改的文件我们看不见，也不假装看得见（确认框里
 * 明说「shell 命令改过的文件不会回退」）。单文件超过 SNAPSHOT_MAX_BYTES 或非
 * utf8：不存正文、标 unrecoverable（无法回退，但卡片上照常计数）。
 *
 * 纯注入设计：读盘经 read 回调注入，node --test 可以喂假文件系统。
 */
import { stat, readFile } from "node:fs/promises";
import { structuredPatch } from "diff";
import { resolveToCwd } from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_MAX_BYTES, type FileChangePayload, type SnapshotPayload } from "../shared/revert.ts";

/** 一次读盘的结果：文件不在 / 在（带字节）。读失败（权限等）按「在但不可读」→ unrecoverable。 */
export type ReadOutcome = { exists: false } | { exists: true; bytes: Buffer | null };

export type PathReader = (path: string) => Promise<ReadOutcome>;

/** node 的真实读盘（测试注入假货）。stat 定存在性与类型，readFile 拿字节。 */
export const diskReader: PathReader = async (path) => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: true, bytes: null };
    return { exists: true, bytes: await readFile(path) };
  } catch {
    return { exists: false };
  }
};

/**
 * write / edit 工具落盘前解析路径用的就是 pi 的 resolveToCwd（见 pi core/tools/write.js、edit.js）。
 * tracker 必须与工具算出**同一个**绝对路径，因此这里不自己实现、直接用 pi 的实现——
 * 手抄一份曾漏掉 win32 的 MSYS/Git-bash 路径折算、`~\` 展开与 file:// URL 转换，
 * 造成工具写 A 文件、tracker 记 B 路径（两边都不存在 → absent==absent 判「没改动」），
 * 回退 / 撤销静默失效。resolveToCwd 经 patch 从包公开入口导出（见 patches/）。
 */
export const resolveToolPath = resolveToCwd;

/** 字节 → 快照：NUL / 超 1MB / 解不了 utf8 / 读不了 → unrecoverable；不在 → absent。 */
function toSnapshot(outcome: ReadOutcome): SnapshotPayload {
  if (!outcome.exists) return { kind: "absent" };
  if (outcome.bytes === null) return { kind: "unrecoverable" };
  if (outcome.bytes.byteLength > SNAPSHOT_MAX_BYTES) return { kind: "unrecoverable" };
  if (outcome.bytes.includes(0)) return { kind: "unrecoverable" };
  try {
    // ignoreBOM：把开头的 U+FEFF 留在字符串里（TextDecoder 默认会剥掉）。快照是字节
    // 级还原的来源——BOM 在这里被剥掉，还原写回的文件就少了 EF BB BF，git 显示假
    // 改动（Windows 上 VS 生成的 .cs / .csproj 常带 BOM）。写回时 utf8 编码原样
    // 还原这三个字节；与 revert.ts 的 diskText 必须同一口径，否则「你改过」会误报。
    return {
      kind: "text",
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(outcome.bytes),
    };
  } catch {
    return { kind: "unrecoverable" };
  }
}

/** 行级统计（structuredPatch 的 + / − 行数；与 git numstat 同口径）。 */
function lineStats(before: SnapshotPayload, after: SnapshotPayload): { added: number; removed: number } {
  const oldText = before.kind === "text" ? before.content : "";
  const newText = after.kind === "text" ? after.content : "";
  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch("a", "b", oldText, newText).hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

function sameSnapshot(a: SnapshotPayload, b: SnapshotPayload): boolean {
  // absent == absent 一定没变；text 比 content。unrecoverable **永不相等**——
  // 正文未知，改没改无从判断，当成变了（照实记账，回退时标无法回退）
  if (a.kind === "absent" && b.kind === "absent") return true;
  return a.kind === "text" && b.kind === "text" && a.content === b.content;
}

/** 一条路径在本轮内的账目。 */
interface PathEntry {
  before: SnapshotPayload;
  after: SnapshotPayload | null;
}

export class TurnFileTracker {
  private readonly cwd: string;
  private readonly read: PathReader;
  /** toolCallId → 改动路径（execution_end 按调用对回路） */
  private readonly callPaths = new Map<string, string>();
  private readonly paths = new Map<string, PathEntry>();
  /** 在途的 after 读盘（execution_end 触发，不 await 事件流）：finalize 先等它们落定 */
  private readonly inflightReads = new Set<Promise<void>>();

  constructor(cwd: string, read: PathReader = diskReader) {
    this.cwd = cwd;
    this.read = read;
  }

  /**
   * 闸门放行后记一笔：write / edit 的路径首次出现时读 before。**必须在放行后**——
   * plan 档直接拒的调用不会执行，记了就是假账；ask 档等用户点了允许再记，
   * 读到的才是「这一批动手前」的内容。
   */
  async noteAllowed(toolCallId: string, toolName: string, input: unknown): Promise<void> {
    if (toolName !== "write" && toolName !== "edit") return;
    const target = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["path"] : null;
    if (typeof target !== "string" || target === "") return;
    const path = resolveToolPath(target, this.cwd);
    this.callPaths.set(toolCallId, path);
    if (this.paths.has(path)) return; // 本轮已记过 before——最早的才是还原目标
    this.paths.set(path, { before: toSnapshot(await this.read(path)), after: null });
  }

  /** 工具执行落定：更新该路径的 after（一轮多次改动只留最后一份）。 */
  noteExecutionEnd(toolCallId: string): Promise<void> {
    const path = this.callPaths.get(toolCallId);
    if (path === undefined) return Promise.resolve();
    const entry = this.paths.get(path);
    if (entry === undefined) return Promise.resolve();
    const reading = this.read(path)
      .then((outcome) => {
        entry.after = toSnapshot(outcome);
      })
      .finally(() => {
        this.inflightReads.delete(reading);
      });
    this.inflightReads.add(reading);
    return reading;
  }

  /**
   * 轮落定：补齐没读到 after 的路径（执行被中断等），丢弃 before == after 的，
   * 算统计。**每次轮结束都新建一个 tracker**，轮与轮互不渗透。abort 的轮同样
   * finalize——工具已经改过的盘是事实，不落账它们就永远回退不了。
   */
  async finalize(): Promise<FileChangePayload[]> {
    // 先等在途的 after 读盘全部落定：execution_end 的读不 await 事件流，
    // 这里不等的话最后一批工具的 after 会缺席
    await Promise.all([...this.inflightReads]);
    const changes: FileChangePayload[] = [];
    for (const [path, entry] of this.paths) {
      const after = entry.after ?? toSnapshot(await this.read(path));
      if (sameSnapshot(entry.before, after)) continue;
      changes.push({ path, before: entry.before, after, ...lineStats(entry.before, after) });
    }
    return changes;
  }
}
