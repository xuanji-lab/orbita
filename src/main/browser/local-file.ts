/**
 * browser_navigate 打开本地文件（agent 写的 HTML 预览——Canvas 的替代：画东西就写一页 HTML，
 * 在受管浏览器里打开给用户看）。
 *
 * 只放行**本会话能用的目录**里的网页类文件：会话工作台、工作目录（cwd）、工作区附加目录、
 * 浏览器下载目录——和 agent 的文件工具看得到的范围一致，不开新口子。判定前先 realpath：
 * 目录里放一个指向外面的软链接，不能借它跳出去。
 *
 * 用户地址栏不走这里：「你的」tab 不属于任何会话，没有「本会话的目录」可以对照。
 * 文件面板的「在内置浏览器打开」也不走这里：它在「你的」tab 打开，白名单是文件面板自己那道
 * （main/files/ipc.ts 的 fs:open-in-browser）。
 */
import { realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isWebPageFile } from "../../shared/files.ts";

/** 形如本地路径的输入：绝对路径（POSIX / Windows 盘符 / UNC 与设备路径 `\\…`）或 file:// 地址 */
export function looksLikeLocalPath(input: string): boolean {
  const text = input.trim();
  // Windows 的绝对路径除了盘符还有两类不以盘符开头：UNC（\\server\share\…）与设备路径（\\?\C:\…）。
  // 不认它们的话它们会漏到网址/搜索那条路：UNC 被解析成 https://server/share/… 并对该主机发请求，
  // \\?\C:\… 整条被 URL 编码后送进搜索——本地路径外泄给第三方。
  return /^file:\/\//i.test(text) || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

export type LocalFileResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * 输入 → 可以加载的本地文件真实路径。roots 是本会话能用的目录（不必存在——不在的跳过）。
 * realpath 可注入，测试用。
 */
export async function resolveLocalPage(
  input: string,
  roots: readonly string[],
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<LocalFileResult> {
  const text = input.trim();
  let path: string;
  try {
    path = /^file:\/\//i.test(text) ? fileURLToPath(text) : text;
  } catch {
    return { ok: false, error: `"${input}" is not a valid file address.` };
  }
  if (!isAbsolute(path)) return { ok: false, error: `"${input}" is not an absolute path.` };
  if (!isWebPageFile(path)) {
    return { ok: false, error: `Only web pages (.html, .htm, .xhtml, .svg) can be opened from disk; "${path}" is not one.` };
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { ok: false, error: `The file ${path} does not exist.` };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(realRoot, real);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..")) {
      return { ok: true, path: real };
    }
  }
  return {
    ok: false,
    error:
      `${path} is outside the directories this session can use ` +
      "(session workbench, working directory, attached directories, browser downloads).",
  };
}
