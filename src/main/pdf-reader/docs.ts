/**
 * PDF 阅读器当前打开的那一份 PDF 与它的批注数据文件（契约见 shared/pdf-reader.ts）。
 *
 * **只有一份是「当前」的**：`open` 发一个新 token 并作废上一个。协议（读 PDF 字节）与存 / 删
 * 都只认 token——renderer 传不进路径，主进程也就不会变成任意路径读写的口子。
 *
 * **数据文件**：`<PDF 同目录>/<PDF 文件名>.annotations.json`。每次写都先重读盘上的现状再合并
 * （别人在中间改过不被我们的内存副本盖掉），写走原子写（临时文件 + rename）；同一份文件的读-改-写
 * 排队执行，阅读器连发两次 save 不会互相覆盖。还没有批注时不建文件。
 *
 * 写不了（目录只读、同名文件读不懂）时不抛到 renderer：回 ok:false + 原因，界面给出错态；
 * 批注仍在阅读器里，不会因为一次写失败就从屏上消失。
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import {
  ANNOTATIONS_PER_SAVE_MAX,
  annotationsFileName,
  emptyAnnotationsFile,
  mergeAnnotations,
  parseAnnotation,
  parseAnnotationsFile,
  PDF_READER_DOC_PREFIX,
  PDF_READER_ORIGIN,
  removeAnnotations,
  type PdfAnnotationsBlock,
  type PdfAnnotationsFile,
  type PdfReaderWriteResult,
  type ReaderAnnotation,
} from "../../shared/pdf-reader.ts";

interface OpenDoc {
  token: string;
  pdfPath: string;
  dataPath: string;
}

export interface OpenedDoc {
  token: string;
  docUrl: string;
  dataFile: string;
  annotations: ReaderAnnotation[];
  blocked: PdfAnnotationsBlock | null;
}

type DiskState =
  | { kind: "ok"; file: PdfAnnotationsFile; exists: boolean }
  | { kind: "blocked"; reason: PdfAnnotationsBlock };

const isErrno = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);

export class PdfReaderDocs {
  private current: OpenDoc | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly newToken: () => string;

  constructor(newToken: () => string = () => randomBytes(16).toString("hex")) {
    this.newToken = newToken;
  }

  /** 打开 `pdfPath`（调用方已过白名单并 realpath）：作废上一份，读数据文件 */
  async open(pdfPath: string): Promise<OpenedDoc> {
    const token = this.newToken();
    const dataPath = join(dirname(pdfPath), annotationsFileName(basename(pdfPath)));
    this.current = { token, pdfPath, dataPath };
    const state = await readDisk(dataPath, basename(pdfPath));
    const blocked = state.kind === "blocked" ? state.reason : (await canWrite(dataPath, state.exists)) ? null : "read-only";
    return {
      token,
      docUrl: `${PDF_READER_ORIGIN}${PDF_READER_DOC_PREFIX}${token}`,
      dataFile: basename(dataPath),
      annotations: state.kind === "ok" ? state.file.annotations : [],
      blocked,
    };
  }

  /** 协议用：token 对应的 PDF 路径；不是当前那份回 null */
  pdfPathOf(token: string): string | null {
    return this.current !== null && this.current.token === token ? this.current.pdfPath : null;
  }

  /** 关掉：只作废自己那份（切文件时旧组件的卸载晚于新组件的打开，不能把新的也关了） */
  close(token: string): void {
    if (this.current?.token === token) this.current = null;
  }

  /** 按 id 合并保存。空数组什么都不做（阅读器偶尔发 save([])） */
  save(token: string, raw: readonly unknown[]): Promise<PdfReaderWriteResult> {
    const incoming = raw.map(parseAnnotation).filter((item): item is ReaderAnnotation => item !== null);
    if (raw.length > ANNOTATIONS_PER_SAVE_MAX) return Promise.resolve(fail("failed", `一次最多存 ${ANNOTATIONS_PER_SAVE_MAX} 条`));
    if (incoming.length === 0) return Promise.resolve({ ok: true, count: 0 });
    return this.write(token, (list) => mergeAnnotations(list, incoming));
  }

  /** 按 id 删除 */
  remove(token: string, ids: readonly unknown[]): Promise<PdfReaderWriteResult> {
    const clean = ids.filter((id): id is string => typeof id === "string");
    if (clean.length === 0) return Promise.resolve({ ok: true, count: 0 });
    return this.write(token, (list) => removeAnnotations(list, clean));
  }

  private write(token: string, change: (list: ReaderAnnotation[]) => ReaderAnnotation[]): Promise<PdfReaderWriteResult> {
    const doc = this.current !== null && this.current.token === token ? this.current : null;
    if (doc === null) return Promise.resolve(fail("expired", "这份 PDF 已经不是当前打开的那一份"));
    const run = async (): Promise<PdfReaderWriteResult> => {
      const state = await readDisk(doc.dataPath, basename(doc.pdfPath));
      if (state.kind === "blocked") return fail(state.reason, blockMessage(state.reason));
      const annotations = change(state.file.annotations);
      try {
        await writeTextAtomic(doc.dataPath, `${JSON.stringify({ ...state.file, annotations }, null, 2)}\n`);
      } catch (error) {
        if (isErrno(error, "EACCES", "EPERM", "EROFS")) return fail("read-only", blockMessage("read-only"));
        return fail("failed", error instanceof Error ? error.message : String(error));
      }
      return { ok: true, count: annotations.length };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function fail(reason: PdfAnnotationsBlock | "expired" | "failed", message: string): PdfReaderWriteResult {
  return { ok: false, reason, message };
}

function blockMessage(reason: PdfAnnotationsBlock): string {
  switch (reason) {
    case "read-only":
      return "PDF 所在的文件夹不可写";
    case "corrupt":
      return "批注文件读不出来（不是合法的 JSON），没有覆盖它";
    case "foreign":
      return "同名的批注文件不是 Orbita 写的，没有覆盖它";
    case "newer":
      return "批注文件是更新版本的 Orbita 写的，这一版只读";
  }
}

async function readDisk(dataPath: string, pdfName: string): Promise<DiskState> {
  let text: string;
  try {
    text = await readFile(dataPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "ok", file: emptyAnnotationsFile(pdfName), exists: false };
    if (isErrno(error, "EACCES", "EPERM")) return { kind: "blocked", reason: "read-only" };
    throw error;
  }
  const parsed = parseAnnotationsFile(text);
  if (!parsed.ok) return { kind: "blocked", reason: parsed.reason };
  return { kind: "ok", file: { ...parsed.file, pdf: pdfName }, exists: true };
}

/** 写得了吗：文件在就看文件本身，不在就看目录（原子写要在目录里建临时文件，所以目录也得可写） */
async function canWrite(dataPath: string, exists: boolean): Promise<boolean> {
  try {
    await access(dirname(dataPath), constants.W_OK);
    if (exists) await access(dataPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
