import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CommandCardData, OpenPanelHint } from "../shared/builtin-command.ts";
import { DOC_EXPORT_EXT, docTitle, type DocExportDocFormat, type DocOutcome } from "../shared/doc.ts";
import type { FileRoot } from "../shared/files.ts";
import { splitFrontmatter } from "../shared/ofm/properties.ts";
import { isDocumentName, isImageName } from "../shared/ofm/syntax.ts";
import { saveAttachment } from "../main/doc-panel/ofm-files.ts";
import { writeTextAtomic } from "../main/atomic-write.ts";
import { isInside, realpathInside } from "../main/path-boundary.ts";
import type { RequestBroker } from "./request-broker.ts";

/**
 * agent 的文档工具组：doc_open / doc_insert_image / doc_export。
 *
 * **原生内置命令**：聊天里过程行显示中文名 + 参数摘要、完成卡与右栏自动打开由本组工具结果的 `details`
 * （`openPanel` / `card`，约定见 shared/builtin-command.ts）驱动，注册表在渲染层 `features/chat/builtin-commands.ts`。
 * 文档正文的改写仍用现有 read / edit / write（`.md` 是真身，改完文件面板里的文档视图靠监听实时并进来）。
 *
 * 文件读写在 agent 进程直做（同 write / edit 的边界；**路径必须落在工作区或附加目录内**，不是通用写盘后门）。
 * 插图落盘与用户在文档面板里插图是同一个函数（main/doc-panel/ofm-files.ts 的 saveAttachment）。
 * 只有导出要主进程（PDF 要隐藏窗口），走 requestId 问答通道（照 browser_* 工具）；
 * docx / md 其实在哪都能生成，但与菜单点导出共用主进程那一套（一处真源）。
 */

export interface DocToolsOptions {
  /** 工作区根 */
  cwd: string;
  /** 可写 / 可建文档的根：工作区 + 附加目录 */
  writeRoots: readonly string[];
  /** 会话所属工作区（主进程据此现算可写根，校验导出路径） */
  workspaceId: string | null;
  /** 当前权限档（plan 档不许新建文件） */
  mode: () => string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function fail(message: string): never {
  throw new Error(message);
}

const toPosix = (path: string): string => path.split("\\").join("/");

/** 文档大纲：前 40 个标题（行号 + 级别 + 文字），frontmatter 与围栏代码里的 `#` 不算 */
export function outlineOf(markdown: string): { line: number; level: number; title: string }[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const bodyStart = splitFrontmatter(markdown.replace(/\r\n?/g, "\n")).bodyStart;
  const skipLines = bodyStart === 0 ? 0 : markdown.replace(/\r\n?/g, "\n").slice(0, bodyStart).split("\n").length - 1;
  const out: { line: number; level: number; title: string }[] = [];
  let fence: string | null = null;
  for (let i = skipLines; i < lines.length && out.length < 40; i += 1) {
    const line = lines[i] as string;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null && (fenceMatch[1] as string)[0] === fence[0]) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) out.push({ line: i + 1, level: (heading[1] as string).length, title: heading[2] as string });
  }
  return out;
}

const humanBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createDocTools(broker: RequestBroker, sessionId: string, options: DocToolsOptions): ToolDefinition[] {
  const { cwd } = options;
  const roots = options.writeRoots.length > 0 ? options.writeRoots : [cwd];
  const fileRoots: FileRoot[] = roots.map((path) => ({ kind: "workspace", label: basename(path), path, exists: true }));

  /** 文档路径 → 绝对路径；必须 .md / .markdown / .txt、必须落在可写根内（含 symlink 解析后） */
  const resolveDoc = async (raw: unknown, mode: "existing" | "new"): Promise<string> => {
    const value = text(raw);
    if (value === null) fail('"path" is required (a .md / .markdown / .txt file in the workspace)');
    const absolute = resolve(isAbsolute(value) ? value : join(cwd, value));
    if (!isDocumentName(absolute)) fail(`A document must end with .md, .markdown or .txt: ${value}`);
    if (!roots.some((root) => isInside(root, absolute))) fail(`Documents must live inside the workspace (or an attached directory): ${value}`);
    if (mode === "existing") {
      const real = await realpathInside(absolute, roots);
      if (real === null) fail(`Document not found (or outside the workspace): ${value}. Pass create:true to doc_open to create it.`);
      return real;
    }
    return absolute;
  };

  const openDetails = (path: string, force: boolean): { openPanel: OpenPanelHint } => ({
    openPanel: { kind: "files", path, ...(force ? { force: true as const } : {}) },
  });

  const ok = (message: string, details?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: message }],
    details: details ?? undefined,
  });

  const open: ToolDefinition = {
    name: "doc_open",
    label: "doc_open",
    description:
      "Open a document (.md / .markdown / .txt) in the Files panel on the right, and return its outline (headings with line numbers). " +
      "Use it whenever the user asks you to open / show / work on a document, before editing it with read / edit / write — " +
      "the panel then shows your edits live. create:true makes a new empty document if the path does not exist (never overwrites). " +
      "The document panel understands Obsidian-flavoured markdown: [[wikilinks]], ![[image.png]], > [!warning] callouts " +
      "(> [!tip]- is collapsible), ==highlight==, #tags, YAML frontmatter, task lists, tables, $math$. " +
      "Write plain markdown unless the user's notes already use that syntax.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The document file (relative to the workspace, or absolute inside it)" },
        create: { type: "boolean", description: "Create the document (empty) if it does not exist" },
      },
      required: ["path"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const create = args["create"] === true;
      const target = await resolveDoc(args["path"], create ? "new" : "existing");
      let created = false;
      try {
        await stat(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (!create) fail(`Document not found: ${text(args["path"])}. Pass create:true to create it.`);
        if (options.mode() === "plan") fail("Plan mode does not create files. Ask the user to leave plan mode, or just describe the document.");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "", { flag: "wx" });
        created = true;
      }
      const real = (await realpathInside(target, roots)) ?? fail(`Document is outside the workspace: ${target}`);
      const content = await readFile(real, "utf8");
      const lineCount = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
      const headings = outlineOf(content);
      const outline =
        headings.length === 0
          ? "(no headings)"
          : headings.map((h) => `${"  ".repeat(h.level - 1)}L${h.line} ${"#".repeat(h.level)} ${h.title}`).join("\n");
      const card: CommandCardData = {
        kind: "doc",
        path: real,
        title: docTitle(real),
        subtitle: `文档 · ${toPosix(relative(cwd, real)) || basename(real)}${lineCount > 0 ? ` · ${lineCount} 行` : ""}`,
      };
      return ok(
        `${created ? "Created and opened" : "Opened"} ${real} in the Files panel (${lineCount} lines).\nOutline:\n${outline}\n` +
          "Edit it with the normal read / edit / write tools; the panel updates live.",
        { ...openDetails(real, created), card },
      );
    },
  };

  const insertImage: ToolDefinition = {
    name: "doc_insert_image",
    label: "doc_insert_image",
    description:
      "Insert an image into a document: copies the picture into the document's attachments folder " +
      "(the vault's attachmentFolderPath from .obsidian/app.json when present, else attachments/) and inserts the reference " +
      "(![[name.png]] in an Obsidian vault, ![](attachments/name.png) otherwise) as its own paragraph. " +
      "Use it instead of hand-writing image paths. The image must be a png / jpg / gif / webp / svg / bmp / avif file ≤ 25 MB.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The document (.md / .markdown / .txt)" },
        image_path: { type: "string", description: "The picture to insert (a file path)" },
        after_line: {
          type: "number",
          description: "Insert after this 1-based line of the document (0 = right after the frontmatter / at the top). Default: end of the document",
        },
      },
      required: ["path", "image_path"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const doc = await resolveDoc(args["path"], "existing");
      const imageRaw = text(args["image_path"]) ?? fail('"image_path" is required');
      const image = resolve(isAbsolute(imageRaw) ? imageRaw : join(cwd, imageRaw));
      if (!isImageName(image)) fail(`Not an image file: ${imageRaw}`);
      let imageInfo;
      try {
        imageInfo = await stat(image);
      } catch {
        return fail(`Image not found: ${imageRaw}`);
      }
      if (!imageInfo.isFile()) fail(`Not a file: ${imageRaw}`);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const before = await stat(doc);
        const original = (await readFile(doc, "utf8")).replace(/\r\n?/g, "\n");
        const lines = original.split("\n");
        const bodyStart = splitFrontmatter(original).bodyStart;
        const frontLines = bodyStart === 0 ? 0 : original.slice(0, bodyStart).split("\n").length - 1;
        const afterRaw = args["after_line"];
        const after = typeof afterRaw === "number" && Number.isFinite(afterRaw) ? Math.floor(afterRaw) : lines.length;
        if (after < 0 || after > lines.length) fail(`after_line must be between 0 and ${lines.length}`);
        if (after > 0 && after < frontLines) fail(`after_line ${after} is inside the frontmatter (lines 1–${frontLines}); use ${frontLines} or later`);
        const saved = await saveAttachment(fileRoots, doc, { kind: "file", path: image });
        const at = Math.max(after, frontLines);
        // 图片自成一段：前后各留一个空行（已有空行不重复加）
        const head = lines.slice(0, at);
        const tail = lines.slice(at);
        const pieces = [...head];
        if (pieces.length > 0 && pieces[pieces.length - 1]?.trim() !== "") pieces.push("");
        pieces.push(saved.markdown);
        if (tail.length > 0 && tail[0]?.trim() !== "") pieces.push("");
        // 原文以换行结尾的，改完仍以换行结尾
        const joined = [...pieces, ...tail].join("\n");
        const next = original.endsWith("\n") && !joined.endsWith("\n") ? `${joined}\n` : joined;
        const after2 = await stat(doc);
        if (after2.mtimeMs !== before.mtimeMs || after2.size !== before.size) continue;
        await writeTextAtomic(doc, next, { mode: before.mode & 0o7777 });
        const insertedLine = pieces.length;
        return ok(
          `Inserted ${saved.markdown} at line ${insertedLine} of ${doc}. The picture was copied to ${saved.path}.`,
          { ...openDetails(doc, false) },
        );
      }
      return fail("The document keeps changing underneath (the user is editing it); try again in a moment");
    },
  };

  const exportDoc: ToolDefinition = {
    name: "doc_export",
    label: "doc_export",
    description:
      "Export a document: docx (Word: headings, lists, tables, images, code, callouts become quote blocks with a coloured bar, " +
      "wikilinks become plain text, ==highlights== get a shading), pdf (rendered with the reading view's page style, images inlined), " +
      "md (a copy of the markdown as is) or md-plain (a universal markdown: Obsidian syntax is converted — wikilinks to text, callouts to quotes, " +
      "embeds to ![](path), ==x== to <mark>). Returns the output path. By default the file is written next to the document " +
      "(<name>.docx / <name>.pdf / <name> 副本.md / <name> (通用).md); out must stay inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The document (.md / .markdown / .txt)" },
        format: { type: "string", enum: ["docx", "pdf", "md", "md-plain"] },
        out: { type: "string", description: "Output file (relative to the document's folder). Must end with the format's extension (.docx / .pdf / .md)" },
      },
      required: ["path", "format"],
    } as never,
    async execute(_id, params, signal) {
      const args = asRecord(params);
      const doc = await resolveDoc(args["path"], "existing");
      const format = args["format"];
      if (format !== "docx" && format !== "pdf" && format !== "md" && format !== "md-plain") fail('"format" must be one of docx, pdf, md, md-plain');
      const out = text(args["out"]);
      if (signal?.aborted === true) fail("Stopped");
      const outcome = await broker.request<DocOutcome>(
        {
          type: "docRequest",
          sessionId,
          workspaceId: options.workspaceId,
          request: { path: doc, format: format as DocExportDocFormat, ...(out === null ? {} : { out }) },
        },
        // PDF 要起隐藏窗口加载内联图片：比默认 30 秒宽一点（主进程侧不设更短的上限，这里兜「失联」）
        120_000,
      );
      if (!outcome.ok) fail(outcome.error);
      const label: Record<DocExportDocFormat, string> = { docx: "Word", pdf: "PDF", md: "Markdown", "md-plain": "Markdown（通用格式）" };
      const card: CommandCardData = {
        kind: "export",
        path: outcome.path,
        title: basename(outcome.path),
        subtitle: `${label[format as DocExportDocFormat]} · ${humanBytes(outcome.bytes)}`,
      };
      return ok(
        `Exported ${doc} to ${outcome.path} (${humanBytes(outcome.bytes)}, .${DOC_EXPORT_EXT[format as DocExportDocFormat]}).`,
        { card },
      );
    },
  };

  return [open, insertImage, exportDoc];
}
