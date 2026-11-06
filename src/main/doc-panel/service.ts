/**
 * 文档面板的主进程服务 —— `doc:*` 的实做（契约在 `shared/doc.ts`）。
 * **纯模块**（roots 由调用方现算后传进来），不 import electron，可被 `node --test` 直接测。
 *
 * 一份文档就是白名单根里的一个 `.md`。四件事：
 * - 读 / 写：写是比较后交换（`expectedHash`）+ 原子写（临时文件 + rename）。换行统一成 `\n`
 *   再算摘要：CRLF 文件读出来是 LF、写回也是 LF（编辑器里本来就只有 `\n`），
 *   摘要两边口径一致，不会因为换行符天天报「盘上被改过」；
 * - 新建：工作区根下 `未命名文档.md`，重名加序号（`wx` 独占创建，并发新建不会互相覆盖）；
 * - 列表：工作区根下几层以内的 `.md`，最近改的在前；
 * - 监听：监听**所在目录**而不是文件本身——原子写是 rename 换 inode，直接监听文件的
 *   watcher 在第一次写之后就聋了。fs.watch 之外再留一条 2 秒一次的 stat 兜底（网络盘 /
 *   个别平台 fs.watch 丢事件），两边撞上的重复事件由 renderer 按摘要去重。
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  DOC_LIST_DEPTH,
  DOC_LIST_LIMIT,
  DOC_MAX_BYTES,
  NEW_DECK_NAME,
  NEW_DOC_NAME,
  type DocCreated,
  type DocCreateRequest,
  type DocFile,
  type DocKind,
  type DocListEntry,
  type DocWriteRequest,
  type DocWriteResult,
} from "../../shared/doc.ts";
import { isDeckText, NEW_DECK_TEXT } from "../../shared/doc-slides.ts";
import type { FileRoot } from "../../shared/files.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { errorCode } from "../fs-errors.ts";
import { realpathInside } from "../path-boundary.ts";

/** 能放文档的根：附件副本根只读，不放 */
const WRITABLE_KINDS: ReadonlySet<FileRoot["kind"]> = new Set(["session", "workspace", "attached"]);

export function normalizeNewlines(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

const isMarkdownPath = (path: string): boolean => /\.md$/i.test(path);

/**
 * 白名单：path realpath 之后落在可写根之内、是 `.md`、是个文件。返回真实路径。
 * 越界 / 不存在 / 不是 .md 一律抛——这条通道不能变成读写任意文件的后门。
 */
export async function resolveDocPath(roots: readonly FileRoot[], path: string): Promise<string> {
  if (!isMarkdownPath(path)) throw new Error(`只能打开 .md 文件：${path}`);
  const allowed = roots.filter((root) => root.exists && WRITABLE_KINDS.has(root.kind)).map((root) => root.path);
  const real = await realpathInside(path, allowed);
  if (real === null) throw new Error(`「${path}」不在这条会话允许的目录里，或文件不存在`);
  if (!isMarkdownPath(real)) throw new Error(`只能打开 .md 文件：${real}`);
  const stats = await stat(real);
  if (!stats.isFile()) throw new Error(`不是文件：${real}`);
  return real;
}

async function readDocAt(real: string): Promise<DocFile> {
  const stats = await stat(real);
  if (stats.size > DOC_MAX_BYTES) throw new Error(`文件太大（${stats.size} 字节），不当文档打开：${real}`);
  const text = normalizeNewlines(await readFile(real, "utf8"));
  return { text, hash: hashText(text), modifiedAt: stats.mtimeMs };
}

export async function readDoc(roots: readonly FileRoot[], path: string): Promise<DocFile> {
  return readDocAt(await resolveDocPath(roots, path));
}

/** 同一份文件的写入排队：两次写不交错（比较与 rename 之间不被另一次写插进来） */
const writeQueues = new Map<string, Promise<unknown>>();

export async function writeDoc(roots: readonly FileRoot[], req: DocWriteRequest): Promise<DocWriteResult> {
  const real = await resolveDocPath(roots, req.path);
  const previous = writeQueues.get(real) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => writeDocAt(real, req));
  writeQueues.set(real, run);
  try {
    return await run;
  } finally {
    if (writeQueues.get(real) === run) writeQueues.delete(real);
  }
}

async function writeDocAt(real: string, req: DocWriteRequest): Promise<DocWriteResult> {
  const text = normalizeNewlines(req.text);
  if (Buffer.byteLength(text) > DOC_MAX_BYTES) throw new Error("文档太大，不写");
  const current = await readDocAt(real);
  if (current.hash !== req.expectedHash) return { ok: false, reason: "conflict", file: current };
  // 内容没变就不写：不白动 mtime，也不制造一次自己的回声
  if (current.text === text) return { ok: true, hash: current.hash, modifiedAt: current.modifiedAt };
  await writeTextAtomic(real, text);
  const stats = await stat(real);
  return { ok: true, hash: hashText(text), modifiedAt: stats.mtimeMs };
}

/** 新建：工作区根下，重名加序号（`未命名文档 2.md`）。根不存在不建，报出来 */
export async function createDoc(roots: readonly FileRoot[], req: DocCreateRequest): Promise<DocCreated> {
  const root = roots.find((candidate) => candidate.kind === "workspace" && candidate.exists);
  if (root === undefined) throw new Error("工作区目录不存在，无处新建文档");
  const base = req.kind === "slides" ? NEW_DECK_NAME : NEW_DOC_NAME;
  const initial = req.kind === "slides" ? NEW_DECK_TEXT : "";
  for (let n = 1; n < 1000; n += 1) {
    const path = join(root.path, `${n === 1 ? base : `${base} ${n}`}.md`);
    try {
      // wx：已存在就 EEXIST，不覆盖；并发新建各拿各的序号
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(initial, "utf8");
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") continue;
      throw cause;
    }
    const real = await realpath(path);
    return { path: real, text: initial, hash: hashText(initial), modifiedAt: (await stat(real)).mtimeMs };
  }
  throw new Error("同名文档太多，换个名字再建");
}

/** 列表扫描时不进的目录：依赖与构建产物里的 .md 不是用户的文档 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  "__pycache__",
]);
/** 扫描的目录数闸：Home 指到一个巨大的目录树也不会扫到天荒地老 */
const LIST_DIR_BUDGET = 1500;
/** 判类型只看文件开头这么多字节（front matter 在最前面） */
const HEAD_BYTES = 1024;

async function kindOfFile(path: string): Promise<DocKind> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return isDeckText(normalizeNewlines(buffer.toString("utf8", 0, bytesRead))) ? "slides" : "doc";
  } catch {
    return "doc";
  } finally {
    await handle?.close();
  }
}

/** 工作区根下的 .md，最近改的在前，最多 DOC_LIST_LIMIT 个 */
export async function listDocs(roots: readonly FileRoot[]): Promise<DocListEntry[]> {
  const root = roots.find((candidate) => candidate.kind === "workspace" && candidate.exists);
  if (root === undefined) return [];
  const found: { path: string; modifiedAt: number }[] = [];
  let budget = LIST_DIR_BUDGET;
  const queue: { dir: string; depth: number }[] = [{ dir: root.path, depth: 0 }];
  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    budget -= 1;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不了的子目录（被删 / 权限）跳过：列表是找文档的便利，不为一个目录废掉整份
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth < DOC_LIST_DEPTH && !SKIP_DIRS.has(dirent.name)) queue.push({ dir: full, depth: depth + 1 });
      } else if (dirent.isFile() && isMarkdownPath(dirent.name)) {
        try {
          found.push({ path: full, modifiedAt: (await stat(full)).mtimeMs });
        } catch {
          // 列表与 stat 之间被删：跳过
        }
      }
    }
  }
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const top = found.slice(0, DOC_LIST_LIMIT);
  return Promise.all(
    top.map(
      async (file): Promise<DocListEntry> => ({
        path: file.path,
        name: basename(file.path),
        relative: relative(root.path, file.path),
        kind: await kindOfFile(file.path),
        modifiedAt: file.modifiedAt,
      }),
    ),
  );
}

/**
 * 文档监听。key 由调用方定（窗口 id + 路径）；同一个 key 重复 watch 是换新的、不叠加。
 * 事件合并：60ms 内同一份文件的多次触发只报一次（一次保存常带 2–3 个 fs 事件）。
 */
export class DocWatchers {
  private readonly entries = new Map<string, { close: () => void }>();

  /** @param onChange 被监听的文件在盘上变了（可能是自己刚写的，renderer 去回声） */
  async watch(key: string, real: string, onChange: () => void): Promise<void> {
    this.unwatch(key);
    const dir = dirname(real);
    const name = basename(real);
    let timer: NodeJS.Timeout | null = null;
    const fire = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 60);
    };
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // filename 缺失（个别平台）当作「可能是它」
        if (filename === null || filename === undefined || filename.toString() === name) fire();
      });
      watcher.on("error", () => undefined);
    } catch {
      // 目录监听建不起来：只靠下面的兜底轮询
    }
    let last = await statSignature(real);
    const poll = setInterval(() => {
      void statSignature(real).then((signature) => {
        if (signature !== last) {
          last = signature;
          fire();
        }
      });
    }, 2000);
    poll.unref();
    this.entries.set(key, {
      close: () => {
        if (timer !== null) clearTimeout(timer);
        clearInterval(poll);
        watcher?.close();
      },
    });
  }

  unwatch(key: string): void {
    this.entries.get(key)?.close();
    this.entries.delete(key);
  }

  /** 关掉某个前缀下的全部（窗口关了：`<窗口 id>:`） */
  unwatchPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.unwatch(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

async function statSignature(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "gone";
  }
}
