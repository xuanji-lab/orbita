/**
 * `orbita-reader://app/...` 的应答（不碰 Electron，可单测；装配在 protocol.ts）。
 *
 * 只给得出三样东西：
 * - 阅读器产物（build/pdf-reader/app 下的文件，路径过 isInside，`..` 与编码绕不出去）；
 *   入口页 reader.html 在 `</head>` 前加上我们的桥脚本与样式；
 * - 桥脚本与样式（out/reader-host/orbita-host.js、orbita-host.css，固定两个名字）；
 * - 当前打开的那份 PDF（`/doc/<token>`，token 不是当前的就 404），支持单段 Range。
 * 其余一律 404；只认 GET / HEAD。所有应答带同一份严格 CSP（试验里零违规的那组）。
 */
import { open, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { isInside } from "../path-boundary.ts";
import { PDF_READER_DOC_PREFIX, PDF_READER_HOST, PDF_READER_SCHEME } from "../../shared/pdf-reader.ts";

/**
 * 页面的 CSP：不联网（connect-src 只到自己与 blob/data），脚本只来自同源（加 wasm-unsafe-eval：pdf.js 的
 * openjpeg / quickjs 是 wasm），样式允许内联（阅读器大量内联样式），worker 同源或 blob。
 */
export const PDF_READER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'self'",
  "child-src 'self' blob:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ftl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** 桥脚本插在入口页 `</head>` 之前（产物是我们钉住的构建，不是不可信模板；找不到 `</head>` 就当产物坏了） */
export const HOST_TAGS = '<link rel="stylesheet" href="orbita-host.css"><script defer src="orbita-host.js"></script>';

export interface ReaderResponseDeps {
  buildDir: string;
  hostDir: string;
  /** token → 当前 PDF 的路径；不是当前那份回 null */
  pdfPathOf: (token: string) => string | null;
}

export type ReaderReply =
  | { status: number; headers: Record<string, string>; body: string | Uint8Array }
  /** 文件片段：协议层按 [start, end] 流式读出（含两端） */
  | { status: number; headers: Record<string, string>; file: { path: string; start: number; end: number } };

function headers(type: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": type,
    "content-security-policy": PDF_READER_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    ...extra,
  };
}

const plain = (status: number, text: string): ReaderReply => ({ status, headers: headers("text/plain; charset=utf-8"), body: text });

/**
 * 解析单段 Range（`bytes=a-b` / `bytes=a-` / `bytes=-n`）。null = 不是我们支持的写法（多段、单位不对）→ 整份给；
 * "unsatisfiable" = 越界 → 416。
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, a = "", b = ""] = match;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

async function fileReply(path: string, type: string, method: string, rangeHeader: string | null): Promise<ReaderReply> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return plain(404, "not found");
    size = info.size;
  } catch {
    return plain(404, "not found");
  }
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") return { status: 416, headers: headers(type, { "content-range": `bytes */${size}` }), body: "" };
  const base = { "accept-ranges": "bytes" };
  if (range === null) {
    if (method === "HEAD" || size === 0) return { status: 200, headers: headers(type, { ...base, "content-length": String(size) }), body: "" };
    return { status: 200, headers: headers(type, { ...base, "content-length": String(size) }), file: { path, start: 0, end: size - 1 } };
  }
  const extra = { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) };
  if (method === "HEAD") return { status: 206, headers: headers(type, extra), body: "" };
  return { status: 206, headers: headers(type, extra), file: { path, start: range.start, end: range.end } };
}

/** 读入口页并插桥脚本 */
async function readerPage(buildDir: string): Promise<ReaderReply> {
  let html: string;
  try {
    html = await readFile(join(buildDir, "app", "reader.html"), "utf8");
  } catch {
    return plain(404, "not found");
  }
  const at = html.indexOf("</head>");
  if (at < 0) return plain(500, "reader.html 里没有 </head>");
  // 页面标题里的品牌名一并换掉（不上屏，但辅助技术会读出 iframe 的标题）
  const page = `${html.slice(0, at)}${HOST_TAGS}${html.slice(at)}`.replace(/<title>[^<]*<\/title>/, "<title>PDF</title>");
  return { status: 200, headers: headers(MIME[".html"] ?? "text/html"), body: page };
}

export async function respondReader(url: string, method: string, rangeHeader: string | null, deps: ReaderResponseDeps): Promise<ReaderReply> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return plain(400, "bad request");
  }
  if (parsed.protocol !== `${PDF_READER_SCHEME}:` || parsed.hostname !== PDF_READER_HOST) return plain(404, "not found");
  if (method !== "GET" && method !== "HEAD") return plain(405, "method not allowed");
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return plain(400, "bad request");
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return plain(400, "bad request");

  if (pathname.startsWith(PDF_READER_DOC_PREFIX)) {
    const token = pathname.slice(PDF_READER_DOC_PREFIX.length);
    const pdfPath = /^[0-9a-f]{32}$/.test(token) ? deps.pdfPathOf(token) : null;
    if (pdfPath === null) return plain(404, "not found");
    return fileReply(pdfPath, MIME[".pdf"] ?? "application/pdf", method, rangeHeader);
  }
  if (pathname === "/reader.html") return readerPage(deps.buildDir);
  if (pathname === "/orbita-host.js" || pathname === "/orbita-host.css") {
    const name = pathname.slice(1);
    return fileReply(join(deps.hostDir, name), MIME[extname(name)] ?? "application/octet-stream", method, rangeHeader);
  }
  const appDir = join(deps.buildDir, "app");
  const target = normalize(join(appDir, pathname));
  if (!isInside(appDir, target) || target === appDir) return plain(404, "not found");
  const type = MIME[extname(target).toLowerCase()];
  if (type === undefined) return plain(404, "not found");
  return fileReply(target, type, method, rangeHeader);
}
