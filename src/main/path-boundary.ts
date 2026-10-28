/**
 * 读盘边界的两条判据。主进程里「按别人给的路径去读盘」的入口共用这一套，不各写各的：
 *
 * - isInside：path 是不是 root 本身或在它下面（纯词法）。
 * - realpathInside：两侧都 realpath 之后再判一次——顺带堵住 symlink / junction 跳板
 *   （根内一个链接指向根外，解析后落在根外，当场不放）。
 *
 * 调用方：审查面板的 git 来源（review/git-source.ts，renderer 传来的相对路径）、
 * 文件面板的白名单（files/list.ts）、内置浏览器的本地网页闸（browser/local-file.ts）、
 * 会话导入（session/importer.ts，索引里记的源文件路径）。
 */
import { realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * path 是不是 root 本身或在它下面。用 relative 判断，不用前缀比较（拼 `${root}/`、
 * `${root}${sep}`，或 shared/path 的 pathWithin）：
 * - 写死 `/` 在 Windows 上永远不成立（resolve 产出反斜杠），根里每个文件都被判「越界」；
 * - 前缀比较区分大小写，而 Windows 路径不区分——盘符 `c:` / `C:`、索引里记的用户目录与
 *   homedir() 的大小写不一致时同样误判越界。path.win32.relative 按不区分大小写比较；
 * - 不能只看 `rel.startsWith("..")`：根里名叫 `..cache` 的目录也以 `..` 开头。
 * pathWithin 留给 renderer（那里没有 node:path）；主进程判越界走这里。
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * path realpath 之后落在 roots（各自 realpath）之一内 → 返回 path 的真实路径；
 * path 不存在 / 读不了 / 落在所有根之外 → null。不存在的根跳过（工作台还没建、附加目录被挪走），
 * 不连累别的根。realpath 可注入，测试用。
 */
export async function realpathInside(
  path: string,
  roots: readonly string[],
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, real)) return real;
  }
  return null;
}
