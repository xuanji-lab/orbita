/**
 * 文档的 OFM 文件侧：工作区文件索引（解析双链 / 图片）与插图落盘。
 * **纯 node 模块**（不 import electron）：主进程的 IPC 与 agent 的 `doc_insert_image` 共用。
 *
 * 索引：从文档所在的根递归列文件（跳过 `.` 开头的目录与依赖 / 构建目录），4 秒内复用；
 * 目录数与文件数有闸（Home 指到巨大目录树也不会扫到天荒地老）。
 */
import { access, copyFile, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import type { DocInserted, OfmResolved, OfmTargetKind } from "../../shared/doc.ts";
import type { FileRoot } from "../../shared/files.ts";
import { attachmentDir, imageMarkdown, safeAttachmentName, uniqueAttachmentName } from "../../shared/ofm/attach.ts";
import { isImageName } from "../../shared/ofm/syntax.ts";
import { resolveOfmTarget } from "../../shared/ofm/resolve.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { isInside } from "../path-boundary.ts";

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "out", "build", "target", "vendor", "__pycache__"]);
const DIR_BUDGET = 4000;
const FILE_BUDGET = 30000;
const INDEX_TTL_MS = 4000;
/** 插图的体积上限（字节）：再大不是配图，是素材 */
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;

const toPosix = (path: string): string => path.split(sep).join("/");

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** 根下的全部文件（相对根，`/` 分隔）。`now` 可注入，测试用 */
export function indexRoot(rootPath: string, now: number = Date.now()): Promise<string[]> {
  const hit = cache.get(rootPath);
  if (hit !== undefined && now - hit.at < INDEX_TTL_MS) return hit.files;
  const files = scan(rootPath);
  cache.set(rootPath, { at: now, files });
  // 扫描失败不留缓存
  files.catch(() => cache.delete(rootPath));
  return files;
}

/** 测试与插图后用：丢掉某根的缓存（刚复制进来的图要马上能被解析到） */
export function dropIndex(rootPath: string): void {
  cache.delete(rootPath);
}

async function scan(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootPath];
  let dirs = 0;
  while (queue.length > 0 && dirs < DIR_BUDGET && out.length < FILE_BUDGET) {
    const dir = queue.shift() as string;
    dirs += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不了的子目录跳过：索引是找文件的便利，不为一个目录废掉整份
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(rootPath, full)));
        if (out.length >= FILE_BUDGET) break;
      }
    }
  }
  return out;
}

/**
 * 文档（真实路径）所在的那个根；不在任何根里 = null。根路径可能是软链（realpath 之后才与 `docReal` 同形），
 * 所以两种写法都比；`base` 是与文档同形的那个路径（算相对路径、读文件用它），`root` 是原根（回给 renderer 做白名单参数）。
 */
export async function rootOfDoc(roots: readonly FileRoot[], docReal: string): Promise<{ root: FileRoot; base: string } | null> {
  const owners: { root: FileRoot; base: string }[] = [];
  for (const root of roots) {
    if (!root.exists || root.kind === "attachments") continue;
    const real = await realpath(root.path).catch(() => root.path);
    if (isInside(real, docReal)) owners.push({ root, base: real });
    else if (isInside(root.path, docReal)) owners.push({ root, base: root.path });
  }
  // 嵌套的根取最深的那个（工作区在 Home 里时，文档属于更具体的）
  owners.sort((a, b) => b.base.length - a.base.length);
  return owners[0] ?? null;
}

export async function resolveTargets(
  roots: readonly FileRoot[],
  docReal: string,
  items: readonly { target: string; kind: OfmTargetKind }[],
  now?: number,
): Promise<OfmResolved[]> {
  const owner = await rootOfDoc(roots, docReal);
  if (owner === null) return items.map(() => null);
  const files = await indexRoot(owner.base, now);
  const docRel = toPosix(relative(owner.base, docReal));
  return items.map((item) => {
    const hit = resolveOfmTarget(files, docRel, item.target, item.kind);
    return hit === null ? null : { path: join(owner.base, ...hit.split("/")), root: owner.root.path, relative: hit };
  });
}

/** 库根：文档所在目录往上（不出根）第一个含 `.obsidian` 的目录；没有 = 根本身，vault=false */
async function findVault(rootPath: string, docReal: string): Promise<{ base: string; vault: boolean }> {
  let dir = dirname(docReal);
  for (let i = 0; i < 64 && isInside(rootPath, dir); i += 1) {
    try {
      if ((await stat(join(dir, ".obsidian"))).isDirectory()) return { base: dir, vault: true };
    } catch {
      // 没有就往上
    }
    const parent = dirname(dir);
    if (parent === dir || dir === rootPath) break;
    dir = parent;
  }
  return { base: rootPath, vault: false };
}

async function readAttachmentSetting(base: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(base, ".obsidian", "app.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as { attachmentFolderPath?: unknown }).attachmentFolderPath;
      if (typeof value === "string") return value;
    }
  } catch {
    // 没有 / 读不出 / 不是 JSON：按没设置
  }
  return undefined;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * 把一张图放进附件目录（重名加序号），回要插进文档的 markdown。
 * `source`：字节（拖入 / 粘贴）或已有文件的路径（agent 的 doc_insert_image / 选图对话框）。
 */
export async function saveAttachment(
  roots: readonly FileRoot[],
  docReal: string,
  source: { kind: "bytes"; name: string; bytes: Uint8Array } | { kind: "file"; path: string },
): Promise<DocInserted> {
  const owner = await rootOfDoc(roots, docReal);
  if (owner === null) throw new Error("文档不在任何可写的目录里，无处放图片");
  const rootBase = owner.base;
  const originalName = source.kind === "bytes" ? source.name : basename(source.path);
  const name0 = safeAttachmentName(originalName);
  if (!isImageName(name0)) throw new Error(`不是图片文件：${originalName}`);
  if (source.kind === "bytes" && source.bytes.byteLength > IMAGE_MAX_BYTES) throw new Error("图片太大（超过 25 MB）");
  if (source.kind === "file") {
    const info = await stat(source.path);
    if (!info.isFile()) throw new Error(`不是文件：${source.path}`);
    if (info.size > IMAGE_MAX_BYTES) throw new Error("图片太大（超过 25 MB）");
  }
  const { base, vault } = await findVault(rootBase, docReal);
  const setting = vault ? await readAttachmentSetting(base) : undefined;
  const docDir = toPosix(relative(base, dirname(docReal)));
  const dirRel = attachmentDir({ vault, setting, docDir });
  const targetDir = join(base, ...dirRel.split("/").filter((part) => part !== ""));
  if (!isInside(rootBase, targetDir)) throw new Error("附件目录不在工作区内");
  await mkdir(targetDir, { recursive: true });
  const taken = new Set<string>();
  for (const entry of await readdir(targetDir)) taken.add(entry.toLowerCase());
  const name = uniqueAttachmentName(name0, (candidate) => taken.has(candidate.toLowerCase()));
  const target = join(targetDir, name);
  if (await exists(target)) throw new Error("附件重名，请重试");
  if (source.kind === "bytes") await writeBytesAtomic(target, source.bytes);
  else await copyFile(source.path, target);
  dropIndex(rootBase);
  const relFromDoc = toPosix(relative(dirname(docReal), target));
  return { name, path: target, markdown: imageMarkdown({ vault, name, relFromDoc: posix.normalize(relFromDoc) }) };
}
