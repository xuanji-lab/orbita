import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { realpathInside } from "../main/path-boundary.ts";

/**
 * 「把一张盘上的图拷进文档 / 演示文稿」的来源闸：slides_write 的图片槽位、slides_insert_image、doc_insert_image 共用。
 *
 * 为什么要闸：image_path 是模型给的字符串，`../outside.png` 与工作区外的绝对路径都能把任意位置的图
 * （含用户别的项目里的截图）复制进工作区，再随导出 / 提交外泄。边界与演示文稿、文档自身路径同一套
 * （main/path-boundary.ts 的 realpathInside：词法 + realpath 双判，symlink 指到根外同样不放）。
 *
 * 允许的根：工作区 + 附加目录（writeRoots），再加调用方给的额外只读根（会话工作台、本会话附件副本、浏览器下载目录——
 * 这些都是系统提示词里明说「你可以去读」的地方）。不存在 → missing（调用方报「找不到」），存在但在所有根之外 → outside。
 */
export type ImageSource = { kind: "ok"; path: string } | { kind: "missing" } | { kind: "outside" };

export async function resolveImageSource(raw: string, cwd: string, roots: readonly string[]): Promise<ImageSource> {
  const absolute = resolve(isAbsolute(raw) ? raw : join(cwd, raw));
  try {
    await access(absolute);
  } catch {
    return { kind: "missing" };
  }
  const real = await realpathInside(absolute, roots);
  return real === null ? { kind: "outside" } : { kind: "ok", path: real };
}
