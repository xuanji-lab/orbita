/**
 * 旧会话本子（还没迁进新运行时的库的 pi JSONL）的原地编辑：回退、单轮撤销、挪工作区的告知、分支。
 * 住在库里的会话由 kernel-edit.ts 编辑；这里的本子下一次开轮时由 kernel 按编辑后的样子迁（legacy-migrate.ts）。
 *
 * 本子是一棵树：每行一个 entry，parentId 指向上一条；**文件最后一行就是当前叶子**，从它沿 parentId 走到根
 * 就是当前分支（pi-book.ts 的 branchEntries）。所以编辑只有两种写法：
 * - 回退：把新叶子定在裁点上，追加一条 `custom`（orbita-revert）挂在裁点下面——custom 不进上下文，
 *   它唯一的作用是让「文件最后一行」落在新枝上；不追加的话下次读还是从废枝末尾开始，回退就丢了。
 * - 撤销 / 挪工作区：在当前叶子下追加一条 `custom_message`（进上下文，迁移后是一条用户侧消息），
 *   模型由此知道用户撤销了文件改动 / 换了工作目录。
 * - 分支：把源本子当前分支到裁点为止的 entry 写进同目录下的新文件（新的会话 id，头里记 parentSession）。
 *
 * 以前这些由旧 agent 库的 SessionManager 做；行为照它的落盘规则：
 * - 文件不存在（会话首轮还没落过盘）：只改内存、不建文件——本子里没有对话，回退 / 撤销都没有可写的；
 * - 文件为空：先写本子头再追加；文件非空却不是本子：报错，不动它；
 * - v1 / v2 的老本子：先整份改写成 v3（补 id / parentId 链），再追加。
 * 追加是 appendFileSync 一行（与旧库同）：中途崩溃最多丢这一行，不会写坏已有的行。
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { branchEntries, parsePiBook, PI_BOOK_VERSION, type PiBookEntry } from "../main/session/pi-book.ts";
import { planBranchCut, planCutEntry, type BranchCutEntry } from "./branch-cut.ts";

/** 本子里的一行（除 header 外），按原样保留未知字段 */
type BookLine = Omit<PiBookEntry, "message"> & { message?: BranchCutEntry["message"]; [key: string]: unknown };

/** 时间序的 UUID v7（本子的会话 id 用它，与旧库同形） */
function uuidv7(now = Date.now()): string {
  const hex = now.toString(16).padStart(12, "0").slice(-12);
  const rand = randomUUID().replace(/-/g, "");
  const variant = ((parseInt(rand.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(13, 16)}-${variant}${rand.slice(17, 20)}-${rand.slice(20, 32)}`;
}

/** 8 位短 id，避开本子里已有的 */
function shortId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomUUID().slice(0, 8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/** 打开的一本旧会话本子 */
export class PiBookFile {
  readonly path: string;
  private readonly cwd: string;
  private exists: boolean;
  private header: Record<string, unknown> | null;
  private readonly entries: BookLine[];
  private leafId: string | null;

  private constructor(path: string, cwd: string, exists: boolean, header: Record<string, unknown> | null, entries: BookLine[]) {
    this.path = path;
    this.cwd = cwd;
    this.exists = exists;
    this.header = header;
    this.entries = entries;
    this.leafId = entries.at(-1)?.id ?? null;
  }

  /** 读本子。`cwd`：会话现在的工作目录（挪过工作区时与本子头里的不同；分支的新本子头写它） */
  static open(path: string, cwd: string): PiBookFile {
    const resolved = resolve(path);
    if (!existsSync(resolved)) return new PiBookFile(resolved, cwd, false, null, []);
    const raw = readFileSync(resolved, "utf8");
    if (raw.trim() === "") {
      if (statSync(resolved).size > 0) throw new Error(`not a session book: ${resolved}`);
      return new PiBookFile(resolved, cwd, true, null, []);
    }
    const book = parsePiBook(raw);
    const headerLine = raw.split("\n").find((line) => line.includes('"type":"session"') || line.includes('"type": "session"'));
    const header = headerLine === undefined ? { type: "session", id: book.header.id, cwd: book.header.cwd } : (JSON.parse(headerLine) as Record<string, unknown>);
    const file = new PiBookFile(resolved, cwd, true, header, book.entries as BookLine[]);
    if (book.header.version < PI_BOOK_VERSION) file.rewriteAsCurrentVersion();
    return file;
  }

  private rewriteAsCurrentVersion(): void {
    if (this.header === null) return;
    this.header = { ...this.header, version: PI_BOOK_VERSION };
    writeFileSync(this.path, [this.header, ...this.entries].map((line) => `${JSON.stringify(line)}\n`).join(""));
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  /** 当前叶子路径上的 entry，root → leaf */
  getBranch(): BookLine[] {
    if (this.leafId === null) return [];
    const at = this.entries.findIndex((entry) => entry.id === this.leafId);
    return branchEntries(this.entries.slice(0, at + 1));
  }

  /** 新叶子定在某条 entry 上（只改内存；下一次追加才落盘） */
  branch(id: string): void {
    if (!this.entries.some((entry) => entry.id === id)) throw new Error(`entry ${id} not found`);
    this.leafId = id;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  private append(fields: Record<string, unknown>): void {
    const entry = { ...fields, id: shortId(new Set(this.entries.map((each) => each.id))), parentId: this.leafId, timestamp: new Date().toISOString() } as BookLine;
    if (this.exists) {
      if (this.header === null) {
        this.header = { type: "session", version: PI_BOOK_VERSION, id: uuidv7(), timestamp: new Date().toISOString(), cwd: this.cwd };
        writeFileSync(this.path, `${JSON.stringify(this.header)}\n`);
      }
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    }
    this.entries.push(entry);
    this.leafId = entry.id;
  }

  /** 不进上下文的标记条目 */
  appendCustomEntry(customType: string, data: unknown): void {
    this.append({ type: "custom", customType, data });
  }

  /** 进上下文的扩展消息（迁移后是一条用户侧消息） */
  appendCustomMessageEntry(customType: string, content: string): void {
    this.append({ type: "custom_message", customType, content, display: false });
  }

  /**
   * 当前分支截到 `leafId` 为止，写成同目录下的一本新本子，返回新文件路径。标签条目（label）不跟过去——
   * 它们是 pi TUI 的书签，璇玑从来不写；跳过时把后面条目的 parentId 接回前一条，链不断。
   */
  createBranchedSession(leafId: string): string {
    const at = this.entries.findIndex((entry) => entry.id === leafId);
    if (at === -1) throw new Error(`entry ${leafId} not found`);
    const path: BookLine[] = [];
    let parentId: string | null = null;
    for (const entry of branchEntries(this.entries.slice(0, at + 1))) {
      if (entry.type === "label") continue;
      path.push({ ...entry, parentId });
      parentId = entry.id;
    }
    const timestamp = new Date().toISOString();
    const id = uuidv7();
    const file = join(dirname(this.path), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    const header = { type: "session", version: PI_BOOK_VERSION, id, timestamp, cwd: this.cwd, parentSession: this.path };
    writeFileSync(file, [header, ...path].map((line) => `${JSON.stringify(line)}\n`).join(""), { flag: "wx" });
    return file;
  }
}

/** 回退：裁到 roles 前缀之后，追加 orbita-revert 把新叶子落盘 */
export function revertPiBook(book: PiBookFile, roles: readonly ("user" | "assistant")[], details: { targetMessageId: string }): void {
  if (book.getLeafId() === null && roles.length > 0) {
    // 空本子对不出非空前缀：本子还没写过任何东西（典型：首轮失败、文件从未落盘）
    throw new Error("pi book is empty — nothing to revert");
  }
  const cut = planCutEntry(book.getBranch(), roles);
  if (cut === null) book.resetLeaf();
  else book.branch(cut);
  book.appendCustomEntry("orbita-revert", details);
}

/** 单轮撤销：在当前叶子追加一条告知模型的 custom_message（进上下文） */
export function undoPiBook(book: PiBookFile, notice: string): void {
  book.appendCustomMessageEntry("orbita-undo", notice);
}

/**
 * 换了工作目录：追加一条进上下文的 custom_message——历史里的相对路径是相对旧目录说的，模型得知道。
 * 与 undo 同一个机制，customType 分开便于排障时认出是哪一种。
 */
export function movePiBook(book: PiBookFile, notice: string): void {
  book.appendCustomMessageEntry("orbita-move", notice);
}

/** 分支：源本子当前分支上裁到 roles 前缀（锚点必须是回答），写成新本子，返回新文件路径 */
export function branchPiBook(book: PiBookFile, roles: readonly ("user" | "assistant")[]): string {
  return book.createBranchedSession(planBranchCut(book.getBranch(), roles));
}
