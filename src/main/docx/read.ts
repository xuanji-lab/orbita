/**
 * `docx:open` 的实做（契约在 `shared/docx.ts`）。**纯模块**：不 import electron，
 * 白名单校验在 ipc.ts 做完才把真实路径传进来，`node --test` 能直接加载测。
 *
 * 主进程只做三件事：判大小、判这个文件到底是不是一个能打开的 docx、算内容 hash。
 * 解析与分页全在 renderer 的引擎（@stll/folio）里——两边各解析一次是浪费，但主进程
 * 这份判定很便宜（zip 中央目录 + 一个文件项的存在性），换来的是「加密包 / 坏 zip /
 * 改名成 .docx 的别的东西」在 renderer 解析之前就有明确结论。
 */
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  DOCX_MAX_BYTES,
  type DocxInvalidReason,
  type DocxOpenResult,
  type DocxPackageStats,
} from "../../shared/docx.ts";

/** Word 加密保存的 .docx 整包是 OLE2 容器（D0 CF 11 E0），与老的 .doc 同魔数 */
function isOle2(bytes: Uint8Array): boolean {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/** zip 本地文件头的 "PK" */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 从包的正文里数两件便宜的事实：`w:p` 数目与显式分页符。全量 XML 解析在 renderer 里
 * 由引擎做，这里只是为了让「页数异常」在挂载之前就能说出来（见 estimateDocxPages）。
 * 正则是有意为之：只要计数，不要结构；属性顺序 / 命名空间前缀都不影响 `<w:p` 与
 * `w:type="page"` 这两处。
 */
function packageStats(documentXml: string): DocxPackageStats {
  const paragraphs = documentXml.match(/<w:p[\s>]/g)?.length ?? 0;
  const pageBreaks = documentXml.match(/<w:br\b[^>]*w:type="page"/g)?.length ?? 0;
  return { paragraphs, pageBreaks };
}

/**
 * 判这份字节是不是可打开的 docx。
 * - OLE2 魔数 → `password`（Word 加密保存的整包就是 OLE2 容器）
 * - 不是 zip → `not-docx`（改名成 .docx 的文本 / RTF / 图片都落这里）
 * - zip 打不开或缺 `word/document.xml` → `corrupt`（半截下载、被截断的包）
 */
async function classify(bytes: Uint8Array): Promise<{ invalid: DocxInvalidReason } | { stats: DocxPackageStats }> {
  if (isOle2(bytes)) return { invalid: "password" };
  if (!isZip(bytes)) return { invalid: "not-docx" };
  try {
    const zip = await JSZip.loadAsync(bytes);
    const body = zip.file("word/document.xml");
    if (body === null) return { invalid: "corrupt" };
    return { stats: packageStats(await body.async("string")) };
  } catch {
    return { invalid: "corrupt" };
  }
}

/**
 * 读一份 docx 给 renderer。`limit` 只为测试注入小上限，生产路径用契约常量。
 * 大小判定在读之前：50 MB 的文件整个读进内存再丢掉没有意义。
 */
export async function readDocxFile(path: string, limit: number = DOCX_MAX_BYTES): Promise<DocxOpenResult> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch (error) {
    // 文件在打开这一刻已经不在了（外部删除 / 改名）：回一个可读的结论，而不是把
    // stat 的原始报错经 IPC 糊到界面上
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "invalid", reason: "missing", size: 0, modifiedAt: 0 };
    }
    throw error;
  }
  if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;
  if (size > limit) return { kind: "too-large", limit, size, modifiedAt };

  const bytes = await readFile(path);
  const classified = await classify(bytes);
  if ("invalid" in classified) {
    return { kind: "invalid", reason: classified.invalid, size, modifiedAt };
  }

  return {
    kind: "docx",
    // Buffer 过 IPC 结构化克隆后是 Uint8Array；契约上直接写成它，renderer 交给引擎不必再转
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    size,
    modifiedAt,
    hash: sha256Hex(bytes),
    stats: classified.stats,
  };
}
