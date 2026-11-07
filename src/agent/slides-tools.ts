import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CommandCardData, OpenPanelHint } from "../shared/builtin-command.ts";
import { readImageInfo } from "../shared/image-size.ts";
import { isSlidesExportFormat, SLIDES_EXPORT_FORMATS, type SlidesAgentRequest, type SlidesOutcome } from "../shared/slides-export.ts";
import {
  applyEdit,
  applyWrite,
  createDeck,
  DeckOpError,
  insertImage,
  lintSlide,
  summarizeDeck,
  type EditOp,
  type WriteEntry,
} from "../shared/slides-ops.ts";
import { CANVAS_SIZE, DECK_MAX_BYTES, ElementError, isDeckPath, normalizeTheme, parseDeck, serializeDeck, type Aspect, type Deck } from "../shared/slides.ts";
import { writeTextAtomic } from "../main/atomic-write.ts";
import { ASSET_MAX_BYTES, saveAssetBytes } from "../main/slides/assets.ts";
import { isInside, realpathInside } from "../main/path-boundary.ts";
import type { RequestBroker } from "./request-broker.ts";

/**
 * agent 的演示文稿工具组：slides_create / read / write / edit / insert_image / export。
 *
 * **原生内置命令**：聊天里过程行显示中文名 + 参数摘要、完成卡与右栏自动打开都由本组工具结果的
 * `details`（`openPanel` / `card`，约定见 shared/builtin-command.ts）驱动，注册表在渲染层
 * `features/chat/builtin-commands.ts`。与用户在编辑器里的手动操作调**同一批纯函数**
 * （shared/slides-ops.ts）——agent 能做的与用户能做的不会各写一份。
 *
 * 文件读写在 agent 进程直做（同 write / edit 的边界；**路径必须落在工作区或附加目录内**，
 * 不是通用写盘后门）。写是「读 → 改 → 比对修改时间 → 原子 rename」：用户此刻在编辑器里也改着同一份，
 * 撞上就重读重试（≤5 次）；rename 之后编辑器靠文件监听并进来（比较后交换 + 三向合并，不丢用户的改动）。
 * 只有导出要主进程（PDF / PNG 要隐藏窗口），走 requestId 问答通道（照 browser_* 工具）。
 */

/** 元素的 JSON schema 说明：写在描述里让模型一次写对 */
const ELEMENT_GUIDE =
  "Canvas coordinates: 16:9 = 1280×720, 4:3 = 960×720 (px, origin top-left). Every element has id (optional, auto-generated), x, y, w, h, rotate (optional, deg). kinds:\n" +
  '- text: { kind:"text", html, fontSize (px, default 28), color ("#rrggbb"), align left|center|right, valign top|middle|bottom, fontFamily? }. html allows only <b> <i> <u> <br> <ul><li> <ol><li> and <span style="color:#...;font-size:NNpx">; plain "text" is accepted instead of html. Everything else is stripped.\n' +
  '- image: { kind:"image", src:"<name>.assets/x.png", fit: contain|cover } — only reference files already in the assets folder; to add a picture use slides_insert_image.\n' +
  '- table: { kind:"table", rows:[["head1","head2"],["a","b"]], header:true, fontSize, colWidths?:[0.4,0.6], headerFill, headerColor, borderColor, color }\n' +
  '- shape: { kind:"shape", shape: rect|roundRect|ellipse|triangle, fill:"#rrggbb"|"none", stroke:"#rrggbb"|"none", strokeWidth, text?, fontSize, color }\n' +
  '- line / arrow: { kind:"line", points:[[x1,y1],[x2,y2]] (relative to the element box), startArrow:"none"|"arrow", endArrow:"none"|"arrow", stroke, strokeWidth, dash? } — the box x,y,w,h must contain both points (e.g. left→right arrow: x=100,y=300,w=400,h=1, points [[0,0],[400,0]], endArrow "arrow").';

const DESIGN_GUIDE =
  "Design rules: keep 60–80px margins; one idea per slide; title 44–56px, body 24–32px (never below 20px); high contrast; " +
  "size each text box for its text (a line is ≈ fontSize×1.25 px tall; CJK glyph width ≈ fontSize); use full-bleed shapes / background colors for rhythm; " +
  "do not stack elements on top of each other unless on purpose; give every slide speaker notes when the user asked for a talk.";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export interface SlidesToolsOptions {
  /** 工作区根 */
  cwd: string;
  /** 可写 / 可建演示文稿的根：工作区 + 附加目录 */
  writeRoots: readonly string[];
  /** 会话所属工作区（主进程据此现算可写根，校验导出路径） */
  workspaceId: string | null;
}

function fail(message: string): never {
  throw new Error(message);
}

function describeError(cause: unknown): string {
  if (cause instanceof DeckOpError || cause instanceof ElementError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export function createSlidesTools(broker: RequestBroker, sessionId: string, options: SlidesToolsOptions): ToolDefinition[] {
  const { cwd } = options;
  const roots = options.writeRoots.length > 0 ? options.writeRoots : [cwd];

  /** 演示文稿路径 → 绝对路径；必须 `.slides.json`、必须落在可写根内（含 symlink 解析后） */
  const resolveDeck = async (raw: unknown, mode: "existing" | "new"): Promise<string> => {
    const value = text(raw);
    if (value === null) fail('"path" is required (a .slides.json file in the workspace)');
    const absolute = resolve(isAbsolute(value) ? value : join(cwd, value));
    if (!isDeckPath(absolute)) fail(`The presentation file must end with .slides.json: ${value}`);
    if (!roots.some((root) => isInside(root, absolute))) fail(`Presentations must live inside the workspace (or an attached directory): ${value}`);
    if (mode === "existing") {
      const real = await realpathInside(absolute, roots);
      if (real === null) fail(`Presentation not found (or outside the workspace): ${value}. Create it with slides_create first.`);
      return real;
    }
    return absolute;
  };

  /** 读 → 改 → 比对 → 原子写，撞上别的写者就重试 */
  const updateDeck = async <T>(path: string, mutate: (deck: Deck) => { deck: Deck; result: T }): Promise<{ deck: Deck; result: T }> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await stat(path);
      if (before.size > DECK_MAX_BYTES) fail(`Presentation file is too large (${before.size} bytes)`);
      const parsed = parseDeck(await readFile(path, "utf8"));
      const changed = mutate(parsed.deck);
      const after = await stat(path);
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) continue;
      await writeTextAtomic(path, serializeDeck(changed.deck), { mode: before.mode & 0o7777 });
      return changed;
    }
    return fail("The presentation keeps changing underneath (the user is editing it); try again in a moment");
  };

  const openDetails = (path: string, force: boolean): { openPanel: OpenPanelHint } => ({
    openPanel: { kind: "slides", path, ...(force ? { force: true as const } : {}) },
  });

  const ok = (message: string, details?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: message }],
    details: details ?? undefined,
  });

  const create: ToolDefinition = {
    name: "slides_create",
    label: "slides_create",
    description:
      "Create a new presentation file (<name>.slides.json) in the workspace and open it in the right panel. " +
      "The deck starts with 0 slides — fill it with slides_write. The file is JSON (a list of slides, each a list of positioned elements), " +
      "pictures live in a sibling <name>.assets/ folder; the user can edit everything by hand in the panel and export to PDF / PPTX / HTML / PNG. " +
      "Use this (not markdown or html files) whenever the user wants a presentation / slides / deck.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title (also used for the default file name)" },
        aspect: { type: "string", enum: ["16:9", "4:3"], description: "Slide ratio, default 16:9" },
        path: { type: "string", description: "Where to create it (relative to the workspace, must end with .slides.json). Default: <title>.slides.json in the workspace root" },
      },
      required: ["title"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const title = text(args["title"]) ?? fail('"title" is required');
      const aspect: Aspect = args["aspect"] === "4:3" ? "4:3" : "16:9";
      let target: string;
      if (text(args["path"]) !== null) {
        target = await resolveDeck(args["path"], "new");
        try {
          await stat(target);
          fail(`${basename(target)} already exists. Pick another path, or edit the existing deck with slides_write / slides_edit.`);
        } catch (cause) {
          if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      } else {
        const stem = title.replace(/[\\/:*?"<>|\0]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "演示文稿";
        target = join(cwd, `${stem}.slides.json`);
        for (let n = 2; n < 200; n += 1) {
          try {
            await stat(target);
            target = join(cwd, `${stem} ${n}.slides.json`);
          } catch {
            break;
          }
        }
      }
      await mkdir(dirname(target), { recursive: true });
      const deck: Deck = { ...createDeck({ title, aspect }), slides: [] };
      await writeTextAtomic(target, serializeDeck(deck));
      const canvas = CANVAS_SIZE[aspect];
      const card: CommandCardData = { kind: "slides", path: target, title, subtitle: `演示文稿 · ${basename(target)}` };
      return ok(
        `Created ${target} (${aspect}, canvas ${canvas.w}×${canvas.h}, 0 slides) and opened it in the right panel.\n` +
          "Next: fill it with slides_write (slides:[{at:1,elements:[...]}, {at:2,...}] — at is a 1-based page number or \"append\"), " +
          "and add pictures with slides_insert_image.\n" +
          DESIGN_GUIDE,
        { ...openDetails(target, true), card },
      );
    },
  };

  const read: ToolDefinition = {
    name: "slides_read",
    label: "slides_read",
    description:
      "Read a presentation: slide count, and for every slide its elements (id, kind, position, text preview, image path, table first row, arrow ends) and speaker notes. " +
      "Pass slide (1-based) to read one slide. Always read before editing a deck you did not just write — the user may have changed it in the panel.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slide: { type: "number", description: "Only this slide (1-based)" },
      },
      required: ["path"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const parsed = parseDeck(await readFile(path, "utf8"));
      const slide = typeof args["slide"] === "number" ? args["slide"] : undefined;
      const summary = summarizeDeck(parsed.deck, slide);
      const warnings = parsed.warnings.length > 0 ? `\nWarnings:\n${parsed.warnings.join("\n")}` : "";
      return ok(summary + warnings, openDetails(path, false));
    },
  };

  const write: ToolDefinition = {
    name: "slides_write",
    label: "slides_write",
    description:
      "Add slides or replace whole slides in a presentation. slides is a list of { at, elements, background, notes }: " +
      'at = a 1-based page number (replaces that slide; page = current count + 1 appends) or "append" (default). ' +
      "elements replaces the slide's elements (omit it to keep them and only change background / notes). background = css color. notes = speaker notes (plain text). " +
      "Several slides can be written in one call. The result lists layout problems (text overflowing its box, elements outside the canvas) — fix them with slides_edit.\n" +
      ELEMENT_GUIDE +
      "\n" +
      DESIGN_GUIDE,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slides: {
          type: "array",
          description: "Slides to write, in order",
          items: {
            type: "object",
            properties: {
              at: { description: '1-based page number, or "append"' },
              elements: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["text", "image", "table", "shape", "line"] } }, required: ["kind"] } },
              background: { type: "string" },
              notes: { type: "string" },
            },
          },
        },
      },
      required: ["path", "slides"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const rawSlides = Array.isArray(args["slides"]) ? args["slides"] : fail('"slides" must be an array');
      if (rawSlides.length === 0) fail('"slides" is empty');
      const entries: WriteEntry[] = rawSlides.map((item) => {
        const entry = asRecord(item);
        const at = entry["at"];
        return {
          at: typeof at === "number" ? at : "append",
          ...(Array.isArray(entry["elements"]) ? { elements: entry["elements"] as unknown[] } : {}),
          ...(typeof entry["background"] === "string" ? { background: entry["background"] } : {}),
          ...(typeof entry["notes"] === "string" ? { notes: entry["notes"] } : {}),
        };
      });
      let outcome;
      try {
        outcome = await updateDeck(path, (deck) => {
          const written = applyWrite(deck, entries);
          return { deck: written.deck, result: written };
        });
      } catch (cause) {
        throw new Error(describeError(cause));
      }
      const { deck, result } = outcome;
      const issues = result.pages.flatMap((page) => lintSlide(deck, page));
      const missing = await missingImages(path, deck, result.pages);
      return ok(
        `Wrote slide(s) ${result.pages.join(", ")}; the deck now has ${deck.slides.length} slide(s).` +
          (issues.length + missing.length > 0 ? `\nLayout notes:\n${[...issues, ...missing].join("\n")}` : ""),
        openDetails(path, false),
      );
    },
  };

  /** 引用了 assets 里不存在的图：提醒 agent 用 slides_insert_image */
  const missingImages = async (deckPath: string, deck: Deck, pages: readonly number[]): Promise<string[]> => {
    const notes: string[] = [];
    for (const page of pages) {
      for (const element of deck.slides[page - 1]?.elements ?? []) {
        if (element.kind !== "image") continue;
        try {
          await stat(join(dirname(deckPath), element.src));
        } catch {
          notes.push(`slide ${page}: image ${element.id} points at ${element.src}, which does not exist — add the picture with slides_insert_image instead`);
        }
      }
    }
    return notes;
  };

  const edit: ToolDefinition = {
    name: "slides_edit",
    label: "slides_edit",
    description:
      "Change part of an existing presentation without rewriting whole slides. ops is a list, applied in order (slide = 1-based page, id = element id from slides_read):\n" +
      '- { op:"patch", slide, id, patch:{...} } — change fields of one element (e.g. patch:{ html:"新标题" } or patch:{ x:100, w:500 }); id and kind cannot change\n' +
      '- { op:"add", slide, element:{...} } — add one element\n' +
      '- { op:"delete", slide, id } — remove an element\n' +
      '- { op:"set_slide", slide, background?, notes? }\n' +
      '- { op:"delete_slide", slide } and { op:"move_slide", slide, to }\n' +
      '- { op:"set_deck", title?, aspect?, theme? } — theme: { fontFamily, color, background }\n' +
      "The user may be looking at another slide; the panel is not moved.\n" +
      ELEMENT_GUIDE,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        ops: { type: "array", description: "Operations, in order", items: { type: "object", properties: { op: { type: "string", enum: ["patch", "add", "delete", "set_slide", "delete_slide", "move_slide", "set_deck"] } }, required: ["op"] } },
      },
      required: ["path", "ops"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const rawOps = Array.isArray(args["ops"]) ? args["ops"] : fail('"ops" must be an array');
      if (rawOps.length === 0) fail('"ops" is empty');
      const ops: EditOp[] = rawOps.map((item, index) => parseOp(item, index));
      let outcome;
      try {
        outcome = await updateDeck(path, (deck) => {
          const edited = applyEdit(deck, ops);
          return { deck: edited.deck, result: edited };
        });
      } catch (cause) {
        throw new Error(describeError(cause));
      }
      const { deck, result } = outcome;
      const issues = result.pages.flatMap((page) => lintSlide(deck, page));
      return ok(
        `Applied ${ops.length} change(s)${result.pages.length > 0 ? ` (slide ${result.pages.join(", ")})` : ""}; the deck has ${deck.slides.length} slide(s).` +
          (issues.length > 0 ? `\nLayout notes:\n${issues.join("\n")}` : ""),
        openDetails(path, false),
      );
    },
  };

  const insertImageTool: ToolDefinition = {
    name: "slides_insert_image",
    label: "slides_insert_image",
    description:
      "Put a picture on a slide: copies the image (PNG / JPEG / GIF / WebP, ≤30 MB) from image_path — a workspace file, or a file the user attached to this conversation — " +
      "into the deck's .assets folder and adds an image element. Size and position default to a centred box at the picture's own aspect ratio (≤ half the canvas); " +
      "pass w / h / x / y (px) to place it exactly, fit contain|cover.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slide: { type: "number", description: "1-based page" },
        image_path: { type: "string", description: "Path of the picture to insert (absolute, or relative to the workspace)" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        fit: { type: "string", enum: ["contain", "cover"] },
        alt: { type: "string", description: "Short description of the picture" },
      },
      required: ["path", "slide", "image_path"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const slide = typeof args["slide"] === "number" ? args["slide"] : fail('"slide" (1-based page number) is required');
      const imageRaw = text(args["image_path"]) ?? fail('"image_path" is required');
      const imagePath = isAbsolute(imageRaw) ? imageRaw : join(cwd, imageRaw);
      let bytes: Buffer;
      try {
        const info = await stat(imagePath);
        if (!info.isFile()) fail(`Not a file: ${imageRaw}`);
        if (info.size > ASSET_MAX_BYTES) fail(`Image is too large (${Math.round(info.size / 1024 / 1024)} MB, limit 30 MB)`);
        bytes = await readFile(imagePath);
      } catch (cause) {
        throw new Error(cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT" ? `Image not found: ${imageRaw}` : describeError(cause));
      }
      if (readImageInfo(bytes) === null) fail(`Not a supported image (PNG / JPEG / GIF / WebP): ${imageRaw}`);
      const saved = await saveAssetBytes(path, basename(imagePath), bytes);
      const num = (key: string): number | undefined => (typeof args[key] === "number" ? (args[key] as number) : undefined);
      let outcome;
      try {
        outcome = await updateDeck(path, (deck) => {
          const placed = insertImage(deck, slide, saved.src, { w: saved.info.width, h: saved.info.height }, {
            ...(num("x") === undefined ? {} : { x: num("x") as number }),
            ...(num("y") === undefined ? {} : { y: num("y") as number }),
            ...(num("w") === undefined ? {} : { w: num("w") as number }),
            ...(num("h") === undefined ? {} : { h: num("h") as number }),
            ...(args["fit"] === "cover" || args["fit"] === "contain" ? { fit: args["fit"] } : {}),
            ...(typeof args["alt"] === "string" ? { alt: args["alt"] } : {}),
          });
          return { deck: placed.deck, result: placed.element };
        });
      } catch (cause) {
        throw new Error(describeError(cause));
      }
      const el = outcome.result;
      return ok(
        `Inserted ${saved.src} (${saved.info.width}×${saved.info.height}px) on slide ${slide} as element ${el.id} at x=${Math.round(el.x)} y=${Math.round(el.y)} w=${Math.round(el.w)} h=${Math.round(el.h)}.`,
        openDetails(path, false),
      );
    },
  };

  const exportTool: ToolDefinition = {
    name: "slides_export",
    label: "slides_export",
    description:
      "Export a presentation to a file next to it (or to out): pdf (one page per slide), html (single self-contained file with page turning, images inlined), " +
      "png (one slide, 2× resolution — give page), pptx (PowerPoint, fonts kept as set), pptx-basic (PowerPoint with every font mapped to Arial / Microsoft YaHei, " +
      "displays the same on any machine). Returns the output path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        format: { type: "string", enum: [...SLIDES_EXPORT_FORMATS] },
        page: { type: "number", description: "png only: which slide (1-based), default 1" },
        out: { type: "string", description: "Output path (relative to the deck's folder or absolute, inside the workspace). Default <name>.<ext>" },
      },
      required: ["path", "format"],
    } as never,
    async execute(_id, params, signal) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const format = args["format"];
      if (!isSlidesExportFormat(format)) fail(`"format" must be one of ${SLIDES_EXPORT_FORMATS.join(", ")}`);
      const request: SlidesAgentRequest = {
        path,
        format,
        ...(typeof args["page"] === "number" ? { page: args["page"] } : {}),
        ...(text(args["out"]) === null ? {} : { out: text(args["out"]) as string }),
      };
      if (signal?.aborted === true) fail("Stopped");
      const outcome = await broker.request<SlidesOutcome>({ type: "slidesRequest", sessionId, workspaceId: options.workspaceId, request }, 120_000);
      if (!outcome.ok) fail(outcome.error);
      const card: CommandCardData = {
        kind: "export",
        path: outcome.path,
        title: basename(outcome.path),
        subtitle: `${format === "pptx-basic" ? "PPTX 通用字体" : format.toUpperCase()} · ${outcome.pages} 页 · ${Math.max(1, Math.round(outcome.bytes / 1024))} KB`,
      };
      return ok(`Exported ${format} to ${outcome.path} (${outcome.pages} page(s), ${outcome.bytes} bytes).`, { card });
    },
  };

  return [create, read, write, edit, insertImageTool, exportTool];
}

/** 把模型给的一个 op 规整成 EditOp（字段类型不对给出带序号的人话） */
function parseOp(item: unknown, index: number): EditOp {
  const raw = asRecord(item);
  const label = `ops[${index}]`;
  const num = (key: string): number => (typeof raw[key] === "number" ? (raw[key] as number) : fail(`${label}: "${key}" must be a number (1-based page)`));
  const str = (key: string): string => text(raw[key]) ?? fail(`${label}: "${key}" is required`);
  switch (raw["op"]) {
    case "patch": {
      const patch = asRecord(raw["patch"]);
      if (Object.keys(patch).length === 0) fail(`${label}: "patch" must be a non-empty object`);
      return { op: "patch", slide: num("slide"), id: str("id"), patch };
    }
    case "add":
      return { op: "add", slide: num("slide"), element: raw["element"] };
    case "delete":
      return { op: "delete", slide: num("slide"), id: str("id") };
    case "set_slide":
      return {
        op: "set_slide",
        slide: num("slide"),
        ...(typeof raw["background"] === "string" ? { background: raw["background"] } : {}),
        ...(typeof raw["notes"] === "string" ? { notes: raw["notes"] } : {}),
      };
    case "delete_slide":
      return { op: "delete_slide", slide: num("slide") };
    case "move_slide":
      return { op: "move_slide", slide: num("slide"), to: num("to") };
    case "set_deck": {
      const theme = asRecord(raw["theme"]);
      return {
        op: "set_deck",
        ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
        ...(raw["aspect"] === "16:9" || raw["aspect"] === "4:3" ? { aspect: raw["aspect"] } : {}),
        ...(Object.keys(theme).length > 0 ? { theme: normalizeTheme(theme) ?? {} } : {}),
      };
    }
    default:
      return fail(`${label}: unknown op ${JSON.stringify(raw["op"])} (patch / add / delete / set_slide / delete_slide / move_slide / set_deck)`);
  }
}

