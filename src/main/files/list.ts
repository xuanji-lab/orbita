/**
 * `fs:list` 的实做（契约在 `shared/files.ts`）。**纯模块**：白名单（roots 清单）由调用方
 * 现算好传进来，这里只管校验与列目录——ipc.ts import electron，逻辑放那里没法直接测。
 *
 * 白名单两道都在这里：`root` 必须是 `fs:roots` 回过的路径之一；`dir` 与 `root` 都过
 * realpath 再判包含（path-boundary.ts 的 isInside，与审查面板 / 内置浏览器同一条判据）。
 * **realpath 解析顺带堵住 symlink 跳板**：根内一个链接指向根外，解析后落在根外，当场拒绝。
 * 两侧都过 realpath 后天然是同一规范形（permission.ts 的 foldPath 只在 win 上需要，那是 resolve 不解析的场合）。
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  sortFileEntries,
  type FileEntry,
  type FileListRequest,
  type FileListResponse,
  type FileRoot,
} from "../../shared/files.ts";
import { isNotFound } from "../fs-errors.ts";
import { isInside } from "../path-boundary.ts";

/**
 * 白名单校验，返回 `dir` realpath 后的真实路径。`fs:list` 与 `fs:reveal` 共用——
 * 两处各写一份，迟早一份改了另一份没跟（「揭示」绕过白名单比「列目录」更糟）。
 */
export async function whitelistedPath(roots: readonly FileRoot[], req: FileListRequest): Promise<string> {
  if (!roots.some((root) => root.path === req.root)) {
    throw new Error(`「${req.root}」不是这条会话允许的根目录之一`);
  }
  let rootReal: string;
  try {
    rootReal = await realpath(req.root);
  } catch {
    // exists=false 的根（工作台还没建、附加目录被挪走）：面板显示占位，硬列就该拒绝
    throw new Error(`根目录不存在：${req.root}`);
  }
  let dirReal: string;
  try {
    dirReal = await realpath(req.dir);
  } catch {
    throw new Error(`目录不存在：${req.dir}`);
  }
  // 以前是 `relative(...).startsWith("..")`：根里名叫 `..cache` 的目录也被当成「跑出根」
  if (!isInside(rootReal, dirReal)) {
    throw new Error(`「${req.dir}」不在允许的根之内`);
  }
  return dirReal;
}

export async function listDirectory(
  roots: readonly FileRoot[],
  req: FileListRequest,
): Promise<FileListResponse> {
  const dir = await whitelistedPath(roots, req);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    // 大小 / mtime 不在 Dirent 上，逐条 lstat。列表与 lstat 之间条目被删（竞态）
    // 就跳过它——面板是快照视图，不为一条已经不在的东西废掉整层。
    let stats: Stats;
    try {
      stats = await lstat(join(dir, dirent.name));
    } catch (cause) {
      if (isNotFound(cause)) continue;
      throw cause;
    }
    // kind 用 lstat 判（与 Dirent 同语义）：symlink 不跟——跟的话链接环转不出来，
    // 而且面板该展示「这里有个链接」而不是假装它是目标目录
    const kind: FileEntry["kind"] = stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other"; // socket / fifo / 设备文件
    entries.push({
      name: dirent.name,
      kind,
      size: kind === "file" ? stats.size : undefined,
      modifiedAt: stats.mtimeMs,
    });
  }
  return { dir, entries: sortFileEntries(entries) };
}
