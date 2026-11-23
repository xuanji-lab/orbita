/**
 * `orbita-media://` 协议的判定与应答规划（装配在 media-protocol.ts）。**纯模块**：不 import electron，
 * `node --test` 直接加载测。
 *
 * 安全面只有一条：协议只认 token。token 由 `fs:media-url` 在过完与 `fs:read` 同一道白名单（root 白名单 +
 * realpath 后在根内 + 媒体扩展名，ipc.ts）之后签发、映射到 realpath 之后的真实路径；URL 里没有路径，
 * renderer 构造不出指向别处的地址。应答时再做一次「这条路径现在还是它自己」的复核——签发之后
 * 文件被换成指向根外的符号链接，realpath 就变了，这里拒绝。
 */
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  MEDIA_HOST,
  MEDIA_SCHEME,
  mediaKindOf,
  mediaMimeOf,
  type FileListRequest,
  type FileMediaUrl,
  type FileRoot,
} from "../../shared/files.ts";
import { whitelistedPath } from "./list.ts";

/** 同时有效的 token 条数上限：播放面板一次最多一个，留给多标签 / 重开；超了淘汰最久没用的 */
export const MEDIA_TOKEN_LIMIT = 256;

/** token 的形状：24 随机字节的 base64url（32 字符）。放宽到 16–64 只为不把测试注入的短 token 误杀 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/** token → 真实路径（LRU）。同一路径重复要地址复用同一个 token，不让重开同一文件把表撑大 */
export class MediaTokens {
  private readonly byToken = new Map<string, string>();
  private readonly byPath = new Map<string, string>();
  private readonly limit: number;

  constructor(limit: number = MEDIA_TOKEN_LIMIT) {
    this.limit = limit;
  }

  /** 为一条**已过白名单、已 realpath** 的路径签发 token（调用方负责校验，这里不再看路径） */
  issue(realPath: string): string {
    const existing = this.byPath.get(realPath);
    if (existing !== undefined) {
      this.touch(existing, realPath);
      return existing;
    }
    const token = randomBytes(24).toString("base64url");
    this.byToken.set(token, realPath);
    this.byPath.set(realPath, token);
    while (this.byToken.size > this.limit) {
      const oldest = this.byToken.keys().next();
      if (oldest.done === true) break;
      const oldPath = this.byToken.get(oldest.value);
      this.byToken.delete(oldest.value);
      if (oldPath !== undefined) this.byPath.delete(oldPath);
    }
    return token;
  }

  /** 查 token 对应的路径（命中就顶到最新）；不认识回 null */
  resolve(token: string): string | null {
    const path = this.byToken.get(token);
    if (path === undefined) return null;
    this.touch(token, path);
    return path;
  }

  get size(): number {
    return this.byToken.size;
  }

  private touch(token: string, path: string): void {
    this.byToken.delete(token);
    this.byToken.set(token, path);
    this.byPath.delete(path);
    this.byPath.set(path, token);
  }
}

/** 播放地址：`orbita-media://stream/<token>` */
export function mediaUrlOf(token: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`;
}

/** 从请求 URL 取 token；协议 / 主机段不对、路径多于一段、token 形状不对都回 null（查询串与 hash 忽略） */
export function tokenOfUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 1) return null;
  const token = segments[0] ?? "";
  return TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * `fs:media-url` 的实做：与 `fs:read` 同一道白名单（root 必须是这条会话的根之一、dir 经 realpath 后在根内——
 * 指向根外的符号链接被拒），再要求 realpath 之后的路径是媒体扩展名的普通文件（改名成 foo.mp3 的符号链接
 * 指向别的文件同样被拒）。过了才签发 token，token 映射的是 realpath 之后的真实路径。
 */
export async function issueMediaUrl(
  tokens: MediaTokens,
  roots: readonly FileRoot[],
  req: FileListRequest,
): Promise<FileMediaUrl> {
  const path = await whitelistedPath(roots, req);
  const kind = mediaKindOf(path);
  const mime = mediaMimeOf(path);
  if (kind === null || mime === null) throw new Error(`Not a playable media file: ${path}`);
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  return { kind, url: mediaUrlOf(tokens.issue(path)), mime, size: stats.size, modifiedAt: stats.mtimeMs };
}

export type RangeSpec =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * 解析 `Range: bytes=…`（RFC 9110 §14）。只支持单段：
 * - `bytes=a-b` / `bytes=a-`（开放区间，到末尾）/ `bytes=-n`（最后 n 字节）；end 超过末尾夹到末尾；
 * - 起点 ≥ 文件长度（或 `-0`、空文件）→ 416；
 * - 语法不对、非 bytes 单位、多段（`a-b,c-d`）→ 忽略 Range，回完整 200（规范允许；Chromium 的媒体请求不发多段）。
 */
export function parseRange(header: string | null, size: number): RangeSpec {
  if (header === null) return { kind: "full" };
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (match === null) return { kind: "full" };
  const first = match[1] ?? "";
  const second = match[2] ?? "";
  if (first === "" && second === "") return { kind: "full" };
  if (first === "") {
    // 后缀区间：最后 n 字节
    const suffix = Number(second);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start)) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  if (second === "") return { kind: "range", start, end: size - 1 };
  const end = Number(second);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "full" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

export interface MediaPlan {
  status: 200 | 206 | 400 | 404 | 405 | 416;
  headers: Record<string, string>;
  /** 要流出去的文件区间（闭区间字节）；null = 无正文（错误、HEAD、空文件） */
  body: { path: string; start: number; end: number } | null;
}

const plain = (status: MediaPlan["status"], extra: Record<string, string> = {}): MediaPlan => ({
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  body: null,
});

/**
 * 一次协议请求的应答规划。只认 GET / HEAD；token 不认识、文件没了、路径复核失败一律 404（不区分原因，
 * 不给探路的信号）。流本身由 media-protocol.ts 按 `body` 区间开。
 */
export async function planMediaResponse(
  tokens: MediaTokens,
  req: { url: string; method: string; range: string | null },
): Promise<MediaPlan> {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, { Allow: "GET, HEAD" });
  const token = tokenOfUrl(req.url);
  if (token === null) return plain(400);
  const issued = tokens.resolve(token);
  if (issued === null) return plain(404);
  const mime = mediaMimeOf(issued);
  if (mime === null) return plain(404);

  let size: number;
  try {
    // 复核：签发之后这条路径若变成了指向别处的符号链接，realpath 就不再等于签发时的值
    if ((await realpath(issued)) !== issued) return plain(404);
    const stats = await stat(issued);
    if (!stats.isFile()) return plain(404);
    size = stats.size;
  } catch {
    return plain(404);
  }

  const base = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const spec = parseRange(req.range, size);
  if (spec.kind === "unsatisfiable") {
    return { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` }, body: null };
  }
  const head = req.method === "HEAD";
  if (spec.kind === "range") {
    return {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${spec.start}-${spec.end}/${size}`,
        "Content-Length": String(spec.end - spec.start + 1),
      },
      body: head ? null : { path: issued, start: spec.start, end: spec.end },
    };
  }
  return {
    status: 200,
    headers: { ...base, "Content-Length": String(size) },
    body: head || size === 0 ? null : { path: issued, start: 0, end: size - 1 },
  };
}
