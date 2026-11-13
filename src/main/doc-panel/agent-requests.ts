/**
 * agent 的 `doc_export` 请求 → 在主进程导出 → 回执载荷（slides / browser / terminal 的 agent-requests 同款分层）。
 * 纯模块（roots 与打印函数由调用方注入），不 import electron——路径规则能被 node --test 直接测。
 * 生成函数是 `doc-export.ts` 的 `buildDocExport`，与文档面板导出菜单是同一个（一处真源，两个入口）。
 */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DOC_EXPORT_EXT, type DocAgentRequest, type DocExportDocFormat, type DocOutcome } from "../../shared/doc.ts";
import type { FileRoot } from "../../shared/files.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { realpathInside } from "../path-boundary.ts";
import { buildDocExport } from "./doc-export.ts";
import { readDoc, resolveDocPath } from "./service.ts";

const WRITABLE: ReadonlySet<FileRoot["kind"]> = new Set(["session", "workspace", "attached"]);

export interface DocAgentDeps {
  roots: readonly FileRoot[];
  printPdf: (html: string) => Promise<Uint8Array>;
}

/** 默认输出：文档旁边。md 与通用 md 不能与文档重名（会覆盖原文），所以加后缀 */
export function defaultDocOut(docReal: string, format: DocExportDocFormat): string {
  const stem = basename(docReal).replace(/\.(?:md|markdown|txt)$/i, "");
  const suffix = format === "md" ? " 副本" : format === "md-plain" ? " (通用)" : "";
  return join(dirname(docReal), `${stem}${suffix}.${DOC_EXPORT_EXT[format]}`);
}

export async function applyDocRequest(deps: DocAgentDeps, request: DocAgentRequest): Promise<DocOutcome> {
  const allowed = deps.roots.filter((root) => root.exists && WRITABLE.has(root.kind)).map((root) => root.path);
  let docReal: string;
  try {
    docReal = await resolveDocPath(deps.roots, request.path);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const ext = DOC_EXPORT_EXT[request.format];
  const out =
    request.out === undefined
      ? defaultDocOut(docReal, request.format)
      : resolve(isAbsolute(request.out) ? request.out : join(dirname(docReal), request.out));
  if (!out.toLowerCase().endsWith(`.${ext}`)) return { ok: false, error: `输出文件要以 .${ext} 结尾：${out}` };
  // 输出若指到文档本身（含软链 / 不同写法）会覆盖原文：按真实路径比
  if (out === docReal || (await realpath(out).catch(() => out)) === docReal) return { ok: false, error: "输出路径不能是文档本身（会覆盖原文）" };
  // 输出目录必须落在可写根内（目录可能还不存在：往上找最近的已存在祖先判）
  let ancestor = dirname(out);
  for (let i = 0; i < 20; i += 1) {
    try {
      await stat(ancestor);
      break;
    } catch {
      ancestor = dirname(ancestor);
    }
  }
  if ((await realpathInside(ancestor, allowed)) === null) return { ok: false, error: `输出路径不在工作区内：${out}` };
  try {
    const text = (await readDoc(deps.roots, docReal)).text;
    const title = basename(docReal).replace(/\.(?:md|markdown|txt)$/i, "");
    const built = await buildDocExport({ format: request.format, text, docReal, roots: deps.roots, title, printPdf: deps.printPdf });
    await writeBytesAtomic(out, built.bytes);
    return { ok: true, path: out, bytes: built.bytes.length };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
