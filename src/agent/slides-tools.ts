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
import { imageSlotOf, isLayoutName, LAYOUT_GUIDE, LAYOUT_NAMES, type LayoutImage } from "../shared/slides-layouts.ts";
import { DEFAULT_THEME_ID, presetTheme, THEME_BLURBS, THEME_IDS, THEME_PRESETS } from "../shared/slides-theme.ts";
import { writeTextAtomic } from "../main/atomic-write.ts";
import { ASSET_MAX_BYTES, saveAssetBytes } from "../main/slides/assets.ts";
import { isInside, pathUnderRoots, realpathInside } from "../main/path-boundary.ts";
import { resolveImageSource } from "./image-source.ts";
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

/**
 * 工具描述只留「做什么 + 关键参数 + 先读 slides 技能」：版式清单、设计规矩、元素格式、主题搭配、
 * slides_edit 各操作与导出差异的细则在内置插件 docs-slides 的 slides 技能里（resources/builtin-plugins/docs-slides），
 * 按需加载——此前这些写在描述里（单 slides_write 就 5.4k 字符）每轮都发给模型。
 * 版式清单与主题说明的真源仍是 LAYOUT_GUIDE / THEME_BLURBS，builtin-content.test 要求技能里逐条同文。
 */
const SKILL_HINT = "Before the first slides_create / slides_write in a conversation, read the `slides` skill (layouts, design rules, element format).";

/** 兜底：没读技能的模型至少在 create 的结果里看到版式名与技能指路 */
const LAYOUT_NAMES_LINE = `Layouts: ${LAYOUT_NAMES.join(", ")} — full rules (design rules, slots per layout, themes, element format) are in the \`slides\` skill; read it before writing slides if you have not yet.`;

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
  /**
   * 用户附在对话里的图片（附件副本的绝对路径，**最近的在前**）。模型看得见图但不知道它在盘上哪里，
   * 所以 `slides_insert_image` 认 `attached` / `attached:2`（第 N 张最近附的图）。缺席 = 不支持
   */
  attachedImages?: () => readonly string[];
  /** 读图额外允许的根（会话工作台、本会话附件副本、浏览器下载目录）；工作区与附加目录（writeRoots）恒允许 */
  imageReadRoots?: readonly string[];
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

  /** 真实路径 → 面板认得的路径（用户挂的根下的原样路径）；openPanel 请求与完成卡用它 */
  const shown = new Map<string, string>();

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
      shown.set(real, await pathUnderRoots(real, roots));
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
    openPanel: { kind: "slides", path: shown.get(path) ?? path, ...(force ? { force: true as const } : {}) },
  });

  const ok = (message: string, details?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: message }],
    details: details ?? undefined,
  });

  const create: ToolDefinition = {
    name: "slides_create",
    label: "slides_create",
    description:
      "Create a presentation (<name>.slides.json) and open it in the right panel; it starts empty — fill it with slides_write. " +
      "Use it, not markdown / html, whenever the user wants slides / a deck. Pick a theme that fits the topic. " +
      SKILL_HINT,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title (also the default file name)" },
        aspect: { type: "string", enum: ["16:9", "4:3"], description: "Default 16:9" },
        theme: { type: "string", enum: [...THEME_IDS], description: `Default ${DEFAULT_THEME_ID}` },
        path: { type: "string", description: "Relative to the workspace, ends with .slides.json. Default <title>.slides.json" },
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
      const themeId = typeof args["theme"] === "string" && THEME_PRESETS[args["theme"].trim().toLowerCase()] !== undefined ? args["theme"].trim().toLowerCase() : DEFAULT_THEME_ID;
      const theme = presetTheme(themeId);
      const deck: Deck = { ...createDeck({ title, aspect, ...(theme === undefined ? {} : { theme }) }), slides: [] };
      await writeTextAtomic(target, serializeDeck(deck));
      const canvas = CANVAS_SIZE[aspect];
      const card: CommandCardData = { kind: "slides", path: target, title, subtitle: `演示文稿 · ${basename(target)}` };
      return ok(
        `Created ${target} (${aspect}, canvas ${canvas.w}×${canvas.h}, theme ${themeId} — ${THEME_BLURBS[themeId]?.en ?? ""}, 0 slides) and opened it in the right panel.\n` +
          "Next: fill it with slides_write (slides:[{layout:\"cover\", slots:{...}}, {layout:\"bullets\", slots:{...}}, …] — pictures go in slots.image, no separate insert step needed).\n" +
          LAYOUT_NAMES_LINE,
        { ...openDetails(target, true), card },
      );
    },
  };

  const read: ToolDefinition = {
    name: "slides_read",
    label: "slides_read",
    description:
      "Read a presentation: per slide its elements (id, kind, position, text preview) and notes. Pass slide for one slide. " +
      "Read before editing a deck you did not just write — the user may have changed it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slide: { type: "number", description: "1-based page" },
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
      "Add or replace slides: slides = [{ at, layout, slots, notes }] (or free-form elements); at = 1-based page (replaces; count + 1 appends) or \"append\". " +
      "Several slides per call; slots.image takes a path or \"attached\" (the user's picture). Fix the returned warnings by rewriting the slide shorter or splitting it. " +
      SKILL_HINT,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slides: {
          type: "array",
          description: "In order",
          items: {
            type: "object",
            properties: {
              at: { description: '1-based page number, or "append"' },
              layout: { type: "string", enum: [...LAYOUT_NAMES], description: "Page type (not with elements)" },
              slots: { type: "object", description: "Layout content (eyebrow, title, bullets[], image …; per layout in the skill)" },
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
      const entries: WriteEntry[] = [];
      for (const item of rawSlides) {
        const entry = asRecord(item);
        const at = entry["at"];
        const layout = typeof entry["layout"] === "string" ? entry["layout"] : undefined;
        const slots = asRecord(entry["slots"]);
        let images: Record<string, LayoutImage> | undefined;
        if (layout !== undefined && isLayoutName(layout) && imageSlotOf(layout) !== null) {
          const ref = text(slots["image"]);
          if (ref !== null) images = { image: await stageLayoutImage(path, ref) };
        }
        entries.push({
          at: typeof at === "number" ? at : "append",
          ...(layout === undefined ? {} : { layout, slots }),
          ...(images === undefined ? {} : { images }),
          ...(Array.isArray(entry["elements"]) ? { elements: entry["elements"] as unknown[] } : {}),
          ...(typeof entry["background"] === "string" ? { background: entry["background"] } : {}),
          ...(typeof entry["notes"] === "string" ? { notes: entry["notes"] } : {}),
        });
      }
      let outcome;
      try {
        outcome = await updateDeck(path, (deck) => {
          const written = applyWrite(deck, entries);
          return { deck: written.deck, result: written };
        });
      } catch (cause) {
        // 版式用错（缺槽位、数量不对）时把这几个版式的说明一并回给模型，不必再去翻技能
        const used = [...new Set(entries.flatMap((entry) => (entry.layout !== undefined && isLayoutName(entry.layout) ? [entry.layout] : [])))];
        const reference = cause instanceof DeckOpError && used.length > 0 ? `\nLayout reference:\n${used.map((name) => `- ${LAYOUT_GUIDE[name]}`).join("\n")}` : "";
        throw new Error(describeError(cause) + reference);
      }
      const { deck, result } = outcome;
      const issues = result.pages.flatMap((page) => lintSlide(deck, page));
      const missing = await missingImages(path, deck, result.pages);
      const notes = [...result.warnings, ...issues, ...missing];
      return ok(
        `Wrote slide(s) ${result.pages.join(", ")}; the deck now has ${deck.slides.length} slide(s).` +
          (notes.length > 0 ? `\nWarnings (fix by rewriting the slide shorter / splitting it, not by shrinking text):\n${notes.join("\n")}` : ""),
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
      "Change part of a presentation: ops = list of { op: patch | add | delete | set_slide | delete_slide | move_slide | set_deck, slide, id, … } applied in order (id from slides_read). " +
      "Fields per operation and the element format: `slides` skill.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        ops: { type: "array", description: "In order", items: { type: "object", properties: { op: { type: "string", enum: ["patch", "add", "delete", "set_slide", "delete_slide", "move_slide", "set_deck"] } }, required: ["op"] } },
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

  /**
   * `attached` / `attached:N` → 第 N 张最近附的图（附件副本，走附件清单，不过边界闸）；
   * 其余按路径（相对工作区或绝对），realpath 后必须落在工作区 / 附加目录 / 额外读根内
   */
  const resolveImagePath = async (raw: string): Promise<string> => {
    const match = /^attached(?::(\d+))?$/i.exec(raw);
    if (match === null) {
      const source = await resolveImageSource(raw, cwd, [...roots, ...(options.imageReadRoots ?? [])]);
      if (source.kind === "missing") return fail(`Image not found: ${raw}`);
      if (source.kind === "outside") {
        return fail(`Image is outside the workspace: ${raw}. Pass a file inside the workspace (or an attached directory), or copy it there first`);
      }
      return source.path;
    }
    const list = options.attachedImages?.() ?? [];
    const n = match[1] === undefined ? 1 : Number(match[1]);
    const found = list[n - 1];
    if (found === undefined) {
      return fail(
        list.length === 0
          ? "The user has not attached any image to this conversation — pass a file path in image_path instead"
          : `Only ${list.length} attached image(s) — use attached or attached:1 … attached:${list.length}`,
      );
    }
    return found;
  };

  /** 版式的图片槽位：读图 → 校验 → 复制进 .assets，返回相对路径与像素尺寸（slides_insert_image 与 slides_write 共用） */
  const stageLayoutImage = async (deckPath: string, raw: string): Promise<LayoutImage> => {
    const imagePath = await resolveImagePath(raw);
    let bytes: Buffer;
    try {
      const info = await stat(imagePath);
      if (!info.isFile()) fail(`Not a file: ${raw}`);
      if (info.size > ASSET_MAX_BYTES) fail(`Image is too large (${Math.round(info.size / 1024 / 1024)} MB, limit 30 MB)`);
      bytes = await readFile(imagePath);
    } catch (cause) {
      throw new Error(cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT" ? `Image not found: ${raw}` : describeError(cause));
    }
    if (readImageInfo(bytes) === null) fail(`Not a supported image (PNG / JPEG / GIF / WebP): ${raw}`);
    const saved = await saveAssetBytes(deckPath, basename(imagePath), bytes);
    return { src: saved.src, width: saved.info.width, height: saved.info.height };
  };

  const insertImageTool: ToolDefinition = {
    name: "slides_insert_image",
    label: "slides_insert_image",
    description:
      "Put a picture on a slide: copies image_path (a file, or \"attached\" / \"attached:2\" for the user's chat pictures) into the deck's .assets folder as an image element, centred at its own aspect ratio by default. " +
      "Inside a layout, prefer slots.image in slides_write.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        slide: { type: "number", description: "1-based page" },
        image_path: { type: "string", description: 'File path, or "attached" / "attached:N" (N-th most recent picture in the chat)' },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        fit: { type: "string", enum: ["contain", "cover"] },
        alt: { type: "string" },
      },
      required: ["path", "slide", "image_path"],
    } as never,
    async execute(_id, params) {
      const args = asRecord(params);
      const path = await resolveDeck(args["path"], "existing");
      const slide = typeof args["slide"] === "number" ? args["slide"] : fail('"slide" (1-based page number) is required');
      const imageRaw = text(args["image_path"]) ?? fail('"image_path" is required');
      const saved = await stageLayoutImage(path, imageRaw);
      const num = (key: string): number | undefined => (typeof args[key] === "number" ? (args[key] as number) : undefined);
      let outcome;
      try {
        outcome = await updateDeck(path, (deck) => {
          const placed = insertImage(deck, slide, saved.src, { w: saved.width, h: saved.height }, {
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
        `Inserted ${saved.src} (${saved.width}×${saved.height}px) on slide ${slide} as element ${el.id} at x=${Math.round(el.x)} y=${Math.round(el.y)} w=${Math.round(el.w)} h=${Math.round(el.h)}.`,
        openDetails(path, false),
      );
    },
  };

  const exportTool: ToolDefinition = {
    name: "slides_export",
    label: "slides_export",
    description:
      "Export a presentation next to it (or to out): pdf, html, png (one slide, give page), pptx, pptx-basic (portable fonts). Returns the path. Format differences: `slides` skill.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .slides.json file" },
        format: { type: "string", enum: [...SLIDES_EXPORT_FORMATS] },
        page: { type: "number", description: "png only, 1-based, default 1" },
        out: { type: "string", description: "Relative to the deck's folder, inside the workspace. Default <name>.<ext>" },
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
      const rawTheme = raw["theme"];
      const theme = rawTheme === undefined ? undefined : normalizeTheme(rawTheme);
      if (rawTheme !== undefined && theme === undefined) fail(`${label}: unknown theme ${JSON.stringify(rawTheme)} (available: ${THEME_IDS.join(", ")}, or an object with palette / fonts / scale)`);
      return {
        op: "set_deck",
        ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
        ...(raw["aspect"] === "16:9" || raw["aspect"] === "4:3" ? { aspect: raw["aspect"] } : {}),
        ...(theme === undefined ? {} : { theme }),
      };
    }
    default:
      return fail(`${label}: unknown op ${JSON.stringify(raw["op"])} (patch / add / delete / set_slide / delete_slide / move_slide / set_deck)`);
  }
}

