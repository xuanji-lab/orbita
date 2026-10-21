import { splitPathTail } from "./tool-results.ts";

/**
 * 一条文件路径 → 显示用的「文件名 + 目录」（轮尾卡 / 回退条 / 审查面板共用）。
 * cwd 之内剥成相对路径再切尾段：名字永远是最末一段，目录是剩下的前缀（不带尾斜杠）。
 * 住独立 .ts（不是 FileTurnCard.tsx）：纯函数要在 `node --test` 里直接测 / 被别的
 * 纯模块复用，.tsx 的 JSX 进不了 Node 的类型剥离。
 */
export function pathParts(path: string, cwd: string | null): { name: string; dir: string } {
  const display =
    cwd !== null && cwd !== "" && (path === cwd || path.startsWith(`${cwd}/`) || path.startsWith(`${cwd}\\`))
      ? path.slice(cwd.length + 1)
      : path;
  const tail = splitPathTail(display.replaceAll("\\", "/"));
  return { name: tail.name, dir: tail.dir.replace(/\/$/, "") };
}
