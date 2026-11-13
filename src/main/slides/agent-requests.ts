/**
 * agent 的 slides_export 请求 → 在主进程导出 → 回执载荷（browser / terminal 的 agent-requests 同款分层）。
 * 纯模块（roots 由调用方现算后传进来），不 import electron——导出实现（export.ts）才碰窗口，
 * 这里把它当依赖注入，所以路径规则能被 node --test 直接测。
 */
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FileRoot } from "../../shared/files.ts";
import { SLIDES_EXPORT_EXT, type SlidesAgentRequest, type SlidesOutcome } from "../../shared/slides-export.ts";
import { isDeckPath } from "../../shared/slides.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { realpathInside } from "../path-boundary.ts";
import type { ExportedDeck } from "./export.ts";

const WRITABLE: ReadonlySet<FileRoot["kind"]> = new Set(["session", "workspace", "attached"]);

export interface SlidesAgentDeps {
  roots: readonly FileRoot[];
  exportDeck: (deckPath: string, format: SlidesAgentRequest["format"], page?: number) => Promise<ExportedDeck>;
}

/** 默认输出路径：演示文稿旁边 `<名字>.<ext>`；png 带页号 `<名字>-p3.png` */
export function defaultOutPath(deckPath: string, format: SlidesAgentRequest["format"], page: number | undefined): string {
  const stem = basename(deckPath).replace(/\.slides\.json$/i, "");
  const suffix = format === "png" ? `-p${page ?? 1}` : format === "pptx-basic" ? "-basic" : "";
  return join(dirname(deckPath), `${stem}${suffix}.${SLIDES_EXPORT_EXT[format]}`);
}

export async function applySlidesRequest(deps: SlidesAgentDeps, request: SlidesAgentRequest): Promise<SlidesOutcome> {
  const allowed = deps.roots.filter((root) => root.exists && WRITABLE.has(root.kind)).map((root) => root.path);
  if (!isDeckPath(request.path)) return { ok: false, error: "只能导出 .slides.json 演示文稿" };
  const deckReal = await realpathInside(request.path, allowed);
  if (deckReal === null) return { ok: false, error: `演示文稿不在这条会话允许的目录里：${request.path}` };
  const ext = SLIDES_EXPORT_EXT[request.format];
  const out = request.out === undefined ? defaultOutPath(deckReal, request.format, request.page) : resolve(isAbsolute(request.out) ? request.out : join(dirname(deckReal), request.out));
  if (!out.toLowerCase().endsWith(`.${ext}`)) return { ok: false, error: `输出文件要以 .${ext} 结尾：${out}` };
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
    const exported = await deps.exportDeck(deckReal, request.format, request.page);
    await writeBytesAtomic(out, exported.bytes);
    return { ok: true, path: out, bytes: exported.bytes.length, pages: exported.pages };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
