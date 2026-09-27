/**
 * 下载的两个纯逻辑：同名不覆盖的保存路径，以及把 PDF 这类文件响应改成下载。
 * 纯函数（fs 只用 existsSync 探测），node --test 可直接加载。
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

/** `dir/name` 已存在就试 `name (1).ext`、`name (2).ext`…；文件名里的路径分隔符与控制字符先剥掉 */
export function availableDownloadPath(dir: string, filename: string, exists: (path: string) => boolean = existsSync): string {
  const clean = sanitizeFilename(filename);
  const ext = extname(clean);
  const stem = ext === "" ? clean : clean.slice(0, -ext.length);
  let candidate = join(dir, clean);
  for (let n = 1; exists(candidate); n += 1) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function sanitizeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, "_").replace(/^\.+/, "").trim();
  return clean === "" ? "download" : clean.slice(0, 200);
}

/** 这些类型在 tab 里显示对 agent 没用（读不到字）：改成下载，交给文件工具 */
const DOWNLOAD_TYPES = [/^application\/pdf\b/i, /^application\/(x-)?(research-info-systems|bibtex|x-bibtex)\b/i, /^text\/csv\b/i];

/**
 * 响应头 → 需要改写时返回新头（加 `Content-Disposition: attachment`），不需要返回 undefined。
 * 已经是 attachment 的不动（服务器本来就要下载）。
 */
export function forceDownloadHeaders(
  headers: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (headers === undefined) return undefined;
  const find = (name: string): [string, string[]] | undefined =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const type = find("content-type")?.[1][0] ?? "";
  if (!DOWNLOAD_TYPES.some((pattern) => pattern.test(type))) return undefined;
  const disposition = find("content-disposition");
  if (disposition !== undefined && /^\s*attachment/i.test(disposition[1][0] ?? "")) return undefined;
  const next = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-disposition"));
  // 保留服务器给的文件名（inline; filename=...）——改成 attachment 时不能把名字丢了
  const filename = disposition?.[1][0]?.match(/filename\*?=[^;]+/i)?.[0];
  return { ...next, "Content-Disposition": [filename === undefined ? "attachment" : `attachment; ${filename}`] };
}
