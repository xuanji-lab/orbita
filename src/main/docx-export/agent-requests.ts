/**
 * agent 的 export_docx 请求 → 授权 → 导出流水线 → 回执。
 *
 * **授权与 compile_latex 同一道**：源文件 / 输出 / 显式模板都必须落在会话授权目录
 * （工作区根 + 附加目录）内。pandoc 会读 `\input{}` / 图片 / `.bib`，让它转一个目录
 * 外的文件等于让模型读那些文件；写侧同理，不能变成通用写盘后门。
 *
 * 例外只有一条：设置里的「学校模板」是用户自己选的机器级文件，可能在任何盘——
 * 它不进 roots 校验（用户显式授权），但必须是真实存在的 .docx（导出器会体检）。
 *
 * 输出路径可以还不存在：取最近已存在祖先的 realpath，再把剩下的段拼回去判越界
 * （与 new_paper 的目标目录同一条判据）。
 */
import { realpath as fsRealpath, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DocxExportOutcome, DocxExportRequest, DocxTemplateMode } from "../../shared/docx-export.ts";
import { isDocxTemplateMode } from "../../shared/docx-export.ts";
import {
  sessionAuthorizedRoots,
  type SessionRootsSource,
  type WorkspaceRootsSource,
} from "../agent/session-roots.ts";
import { isInside } from "../path-boundary.ts";
import type { DocxExporter } from "./export.ts";

export interface DocxExportSettings {
  pandocPath: string | null;
  templateMode: DocxTemplateMode;
  customTemplatePath: string | null;
}

export interface DocxExportEvent {
  sessionId: string;
  request: DocxExportRequest;
}

export async function applyDocxExportRequest(
  exporter: Pick<DocxExporter, "export">,
  sessions: SessionRootsSource,
  workspaces: WorkspaceRootsSource,
  settings: () => Promise<DocxExportSettings>,
  event: DocxExportEvent,
): Promise<DocxExportOutcome> {
  try {
    const roots = await sessionAuthorizedRoots(sessions, workspaces, event.sessionId);
    if (roots.length === 0) {
      return { ok: false, code: "out-of-scope", error: "This session has no authorized directory.", warnings: [] };
    }
    const base = roots[0] as string;

    const source = await resolveSource(event.request.source, roots, base);
    if ("error" in source) return { ok: false, code: "source-missing", error: source.error, warnings: [] };

    const out = await authorizeOutput(event.request.out, roots, base);
    if ("error" in out) return { ok: false, code: "out-of-scope", error: out.error, warnings: [] };

    let explicitTemplate: string | null = null;
    const rawTemplate = event.request.template?.trim();
    if (rawTemplate !== undefined && rawTemplate !== "") {
      const authorized = await authorizeExisting(rawTemplate, roots, base);
      if ("error" in authorized) return { ok: false, code: "out-of-scope", error: authorized.error, warnings: [] };
      if (!/\.docx$/i.test(authorized.path)) {
        return { ok: false, code: "template-invalid", error: "The template must be a .docx file.", warnings: [] };
      }
      explicitTemplate = authorized.path;
    }

    const current = await settings();
    const mode = isDocxTemplateMode(current.templateMode) ? current.templateMode : "default";
    return await exporter.export({
      sourcePath: source.path,
      outPath: out.path,
      pandocPath: current.pandocPath ?? undefined,
      explicitTemplate,
      templateMode: mode,
      customTemplatePath: current.customTemplatePath,
    });
  } catch (cause) {
    return {
      ok: false,
      code: "write-failed",
      error: cause instanceof Error ? cause.message : String(cause),
      warnings: [],
    };
  }
}

type Resolved = { path: string } | { error: string };

/** 源：.md / .tex 文件，或一个目录（main.tex / 唯一的 .tex / 唯一的 .md） */
async function resolveSource(raw: unknown, roots: readonly string[], base: string): Promise<Resolved> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: 'The "source" argument is required: a .md / .tex file, or a directory that contains one.' };
  }
  const absolute = resolve(base, raw.trim());
  const authorized = await authorizeExisting(absolute, roots, base);
  if ("error" in authorized) return authorized;
  const target = authorized.path;

  const info = await stat(target).catch(() => null);
  if (info === null) return { error: `Source not found: ${raw}` };
  if (info.isFile()) {
    if (!/\.(?:md|markdown|tex)$/i.test(target)) {
      return { error: "The source must be a .md / .markdown / .tex file." };
    }
    return { path: target };
  }
  if (!info.isDirectory()) return { error: `Source is neither a file nor a directory: ${raw}` };

  const entries = await readdir(target).catch(() => [] as string[]);
  const lower = entries.map((name) => name.toLowerCase());
  const mainTex = entries[lower.indexOf("main.tex")];
  if (mainTex !== undefined) return { path: join(target, mainTex) };
  const tex = entries.filter((name) => /\.tex$/i.test(name));
  if (tex.length === 1) return { path: join(target, tex[0] as string) };
  const md = entries.filter((name) => /\.(?:md|markdown)$/i.test(name));
  if (tex.length === 0 && md.length === 1) return { path: join(target, md[0] as string) };
  return {
    error:
      `Cannot tell which file in ${raw} to export: found ${tex.length} .tex and ${md.length} .md files. ` +
      "Pass the source file explicitly (or add main.tex).",
  };
}

async function authorizeExisting(raw: string, roots: readonly string[], base: string): Promise<Resolved> {
  const absolute = resolve(base, raw);
  let real: string;
  try {
    real = await fsRealpath(absolute);
  } catch {
    return { error: `File not found: ${raw}` };
  }
  const realRoots = await realRootsOf(roots);
  return realRoots.some((root) => isInside(root, real))
    ? { path: real }
    : { error: `Path is outside this session's authorized directories: ${raw}` };
}

/**
 * 输出：可以还不存在。取最近已存在祖先的 realpath（解析 symlink 跳板），
 * 再把剩余路径段拼回去，最后按词法判越界。
 */
async function authorizeOutput(raw: unknown, roots: readonly string[], base: string): Promise<Resolved> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: 'The "out" argument is required (a .docx path).' };
  }
  const candidate = resolve(base, raw.trim());
  if (!/\.docx$/i.test(candidate)) return { error: "The output path must end with .docx." };

  let existing = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fsRealpath(existing);
      const finalPath = tail.length === 0 ? real : join(real, ...[...tail].reverse());
      const realRoots = await realRootsOf(roots);
      return realRoots.some((root) => isInside(root, finalPath))
        ? { path: finalPath }
        : { error: `Output path is outside this session's authorized directories: ${raw}` };
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return { error: `Cannot resolve the output location: ${raw}` };
      tail.push(basename(existing));
      existing = parent;
    }
  }
}

async function realRootsOf(roots: readonly string[]): Promise<string[]> {
  const real: string[] = [];
  for (const root of roots) {
    try {
      real.push(await fsRealpath(root));
    } catch {
      // 不存在的根跳过（工作台没建 / 附加目录被挪走），不连累别的根
    }
  }
  return real;
}
