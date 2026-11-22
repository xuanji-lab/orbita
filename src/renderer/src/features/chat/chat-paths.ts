/**
 * 对话里本地路径的纯推导（chat-file-scope.ts 用）：回答里写的图片路径 → 盘上绝对路径 → 它落在哪个根。
 * 纯模块：不碰 api / React，可被 node --test 直接加载。
 */
import type { FileRoot } from "../../../../shared/files.ts";

/** 绝对路径？（POSIX 的 / 开头、Windows 的盘符或 UNC） */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** markdown 管线会把路径里的中文、空格编成 %XX（mdast → hast 的 normalizeUri）；读盘前解回来，解不了就原样 */
function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function resolveChatPath(path: string, cwd: string | null): string | null {
  const clean = decodePath(path.startsWith("file://") ? path.slice("file://".length) : path);
  if (isAbsolute(clean)) return clean;
  if (cwd === null) return null;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${clean.replace(/^\.[\\/]/, "")}`;
}

/** 绝对路径落在哪个根里（最长前缀）；都不在 = null */
export function rootOf(path: string, roots: readonly FileRoot[]): FileRoot | null {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(path);
  let best: FileRoot | null = null;
  for (const root of roots) {
    const base = norm(root.path);
    if (target === base || target.startsWith(`${base}/`)) {
      if (best === null || base.length > norm(best.path).length) best = root;
    }
  }
  return best;
}

