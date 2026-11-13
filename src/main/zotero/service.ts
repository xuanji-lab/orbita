/**
 * Zotero 只读服务：agent 的三个工具（查文献 / 读条目 / 读全文）在主进程的落点。**纯模块**（不 import electron）。
 *
 * 每次调用：找数据目录（data-dir.ts，读 Zotero 的 profiles.ini / prefs.js）→ 只读打开 zotero.sqlite
 * （../session/sqlite-readonly.ts：-wal 空时 immutable 直读，非空时克隆库与 -wal 到 Orbita 自己的临时目录读、读完即删）
 * → 跑查询（library.ts，只有 SELECT）→ 关库；全文另读附件目录里的 `.zotero-ft-cache`，附件在不在本机另 stat。
 * **不依赖 Zotero 进程**（Zotero 关着是主场景），不发任何网络请求，对数据目录零写入。
 *
 * 不缓存、不预热、不轮询：构造不碰磁盘，只有工具被调用时才读（剧本第 10 条：启动与空闲时不扫描数据目录）。
 * 本机实测一次查文献在几十毫秒内（含取快照，数字见 PR 描述），缓存换来的只有「Zotero 里改了这里还是旧的」。
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ZOTERO_ANNOTATION_DEFAULT_LIMIT,
  ZOTERO_ANNOTATION_MAX_LIMIT,
  ZOTERO_FULLTEXT_DEFAULT_CHARS,
  ZOTERO_FULLTEXT_MAX_CHARS,
  ZOTERO_SEARCH_DEFAULT_LIMIT,
  ZOTERO_SEARCH_MAX_LIMIT,
  zoteroUnavailableMessage,
  type ZoteroAgentRequest,
  type ZoteroFulltextRequest,
  type ZoteroFulltextResult,
  type ZoteroItemRequest,
  type ZoteroItemResult,
  type ZoteroOutcome,
  type ZoteroSearchRequest,
  type ZoteroSearchResult,
  type ZoteroUnavailable,
} from "../../shared/zotero.ts";
import { withReadOnlyDb } from "../session/sqlite-readonly.ts";
import type { ZoteroDataDir } from "./data-dir.ts";
import { checkSchema, fulltextTargets, readItem, searchItems, type LibraryLocation } from "./library.ts";

/** 读不了：带上是哪一种，handle 翻成给模型的一句话 */
export class ZoteroUnavailableError extends Error {
  readonly kind: ZoteroUnavailable;
  readonly detail: string;
  constructor(kind: ZoteroUnavailable, detail: string) {
    super(`Zotero unavailable: ${kind} ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

export interface ZoteroServiceOptions {
  /** 每次调用现找数据目录（找不到返回 null 与找过的位置） */
  locate: () => Promise<{ found: ZoteroDataDir | null; tried: string[] }>;
  /** 文件在不在（测试注入）；默认 stat */
  exists?: (path: string) => Promise<boolean>;
}

/** Zotero 条目 key：8 位，字母表 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ（Zotero.Utilities.isValidObjectKey） */
export function normalizeKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)) {
    throw new Error(`"${raw}" is not a Zotero item key (8 characters such as ABCD2345); get keys from zotero_search`);
  }
  return key;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export class ZoteroService {
  private readonly locate: ZoteroServiceOptions["locate"];
  private readonly exists: (path: string) => Promise<boolean>;

  constructor(options: ZoteroServiceOptions) {
    this.locate = options.locate;
    this.exists = options.exists ?? fileExists;
  }

  /** agent 请求的总入口：任何失败都折成 `{ ok: false }`（读不了时带 unavailable 与给人看的说明） */
  async handle(request: ZoteroAgentRequest): Promise<ZoteroOutcome> {
    try {
      if (request.op === "search") return { ok: true, result: await this.search(request) };
      if (request.op === "item") return { ok: true, result: await this.item(request) };
      return { ok: true, result: await this.fulltext(request) };
    } catch (cause) {
      if (cause instanceof ZoteroUnavailableError) {
        return { ok: false, error: zoteroUnavailableMessage(cause.kind, cause.detail), unavailable: cause.kind };
      }
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** 找库 + 只读打开 + 核对版本，再交给 read（同步，在库开着时跑完） */
  private async withLibrary<T>(read: (db: DatabaseSync, location: LibraryLocation) => T): Promise<T> {
    const { found, tried } = await this.locate();
    if (found === null) throw new ZoteroUnavailableError("no-data-dir", `looked in: ${tried.join(", ")}`);
    const location: LibraryLocation = { dataDir: found.dir, baseAttachmentPath: found.baseAttachmentPath };
    return withReadOnlyDb(found.database, (db) => {
      const schema = checkSchema(db);
      if (!schema.ok) throw new ZoteroUnavailableError(schema.kind, schema.detail);
      return read(db, location);
    });
  }

  async search(request: ZoteroSearchRequest): Promise<ZoteroSearchResult> {
    const limit = clampInt(request.limit, 1, ZOTERO_SEARCH_MAX_LIMIT, ZOTERO_SEARCH_DEFAULT_LIMIT);
    const offset = clampInt(request.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const found = await this.withLibrary((db) => searchItems(db, request, limit, offset));
    return { op: "search", items: found.items, total: found.total, offset, collection: found.collection };
  }

  async item(request: ZoteroItemRequest): Promise<ZoteroItemResult> {
    const key = normalizeKey(request.key);
    const read = await this.withLibrary((db, location) => readItem(db, location, key));
    if (read === null) throw new Error(`No Zotero item with key ${key}`);
    const annotationOffset = clampInt(request.annotationOffset, 0, Number.MAX_SAFE_INTEGER, 0);
    const annotationLimit = clampInt(request.annotationLimit, 1, ZOTERO_ANNOTATION_MAX_LIMIT, ZOTERO_ANNOTATION_DEFAULT_LIMIT);
    const attachments = await Promise.all(
      read.detail.attachments.map(async (a) => ({ ...a, onDisk: a.path === null ? false : await this.exists(a.path) })),
    );
    return {
      op: "item",
      item: {
        ...read.detail,
        attachments,
        annotations: read.annotations.slice(annotationOffset, annotationOffset + annotationLimit),
        annotationTotal: read.annotations.length,
        annotationOffset,
      },
    };
  }

  async fulltext(request: ZoteroFulltextRequest): Promise<ZoteroFulltextResult> {
    const key = normalizeKey(request.key);
    let dataDir = "";
    const targets = await this.withLibrary((db, location) => {
      dataDir = location.dataDir;
      return fulltextTargets(db, location, key);
    });
    if (targets === null) throw new Error(`No Zotero item with key ${key}`);
    const pdf = targets.attachments.find((a) => a.contentType === "application/pdf" && a.path !== null) ?? null;
    const pdfPath = pdf?.path ?? null;
    for (const attachment of targets.attachments) {
      // 全文缓存与附件的 linkMode 无关，一律在 storage/<附件 key>/ 下（fulltext.js getItemCacheFile）
      let content: string;
      try {
        content = await readFile(join(dataDir, "storage", attachment.key, ".zotero-ft-cache"), "utf8");
      } catch {
        continue;
      }
      const total = content.length;
      const start = clampInt(request.start, 0, total, 0);
      const length = clampInt(request.length, 1, ZOTERO_FULLTEXT_MAX_CHARS, ZOTERO_FULLTEXT_DEFAULT_CHARS);
      const end = Math.min(total, start + length);
      return {
        op: "fulltext",
        title: targets.title,
        pdfPath,
        fulltext: {
          key,
          attachmentKey: attachment.key,
          path: attachment.path,
          text: content.slice(start, end),
          start,
          end,
          total,
          indexedPages: attachment.indexedPages,
          totalPages: attachment.totalPages,
        },
      };
    }
    return { op: "fulltext", title: targets.title, pdfPath, fulltext: null };
  }
}
