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


/**
 * 产物卡要不要出：路径落在这条会话可读的根里（`fs:roots` 回的清单，与文件面板 `fs:read` 同一套）且那个根还在盘上。
 * 不在任何根里的文件点了也打不开（面板与「用默认应用打开」都过同一道白名单），不如不出卡。
 * 只做字面前缀判定，不解符号链接（那一道留给主进程读盘时的 realpath）。
 * roots 为 null = 根清单还没取回来：先放行，取回后再筛，免得卡片闪一下才出。
 */
export function isReadablePath(path: string, roots: readonly FileRoot[] | null): boolean {
  if (roots === null) return true;
  const root = rootOf(path, roots);
  return root !== null && root.exists;
}

/** 统一成正斜杠、去尾斜杠，比较两条路径是不是同一个 */
export function samePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 回答 markdown 里引用的图片路径（`![说明](路径)` / `![说明](<含空格的路径>)`），已解成绝对路径并归一。
 * show_image 给的图据此判断「回答里已经画了」——画了的不再在回答后面重复画一遍。
 * 远程图（http 等）不是本地路径，不算。
 */
export function markdownImagePaths(text: string, cwd: string | null): Set<string> {
  const found = new Set<string>();
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const ref = (match[1] ?? match[2] ?? "").trim();
    if (ref === "") continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^file:/i.test(ref) && !/^[A-Za-z]:[\\/]/.test(ref)) continue;
    const path = resolveChatPath(ref, cwd);
    if (path !== null) found.add(samePathKey(path));
  }
  return found;
}
