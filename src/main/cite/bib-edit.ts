/**
 * .bib 的两个 agent 动作：**排序**（sort）与**等号对齐**（align）。
 *
 * 都只返回「新全文」这一份事实，写盘由调用方（agent 的 edit_bib 工具）走现有写
 * 文件链路——这样轮尾改动卡、审查面板的 diff、单轮撤销全都看得见。这里不碰 fs，
 * 纯函数，node --test 直接喂文本。
 *
 * 三条口径（用户已拍）：
 * - 排序默认按 key（大小写不敏感，同 key 再按原样比，稳定）；`by=year` 时按
 *   「year → author → key」。
 * - **文件头注释、`@string` 块原位不动**：只在条目槽之间搬运条目，条目外的文本
 *   （前缀、块间空行、注释、@string）一个字节都不重排。
 * - 对齐只把条目内每个 `字段名 =` 的等号对齐到该条目最长字段名之后，缩进与字段值
 *   原样；**幂等**——已对齐的文件再跑一次必须一字不差。
 */
import { bibBlocks, parseBibtex, stripBibComments } from "./bib.ts";

/** 排序依据：默认 key；`year` 是 year + author + key */
export type BibSortBy = "key" | "year";

/** 一次 bib 动作的结果：新全文 + 给模型看的一小段对照 */
export interface BibEditOutcome {
  /** 改后的全文（原样行尾；与原文相同 = 没有可改的） */
  source: string;
  /** 文件里的条目数（坏条目不参与排序 / 对齐） */
  entries: number;
  /** 位置真的变了的条目数（排序用；对齐时为「改过的条目数」） */
  moved: number;
  /** 前几条 key（原文顺序 / 新顺序），给模型看的一小段，不是整篇 */
  before: string[];
  after: string[];
  changed: boolean;
}

/** 对照里最多列几个 key：模型要判断「是不是它想要的顺序」，5 个够 */
const PREVIEW_KEYS = 5;

/** 稳定的 key 比较：先小写，再原样（与 mergeBibEntries 同一口径） */
function compareKey(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  if (lower !== 0) return lower;
  return a < b ? -1 : a > b ? 1 : 0;
}

function yearNumber(year: string | null): number {
  if (year === null) return Number.POSITIVE_INFINITY;
  const match = /\d{4}/.exec(year);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[0]);
}

/**
 * 排序。返回新全文；已有序时 `source` 与原文相同、`changed:false`（调用方据此
 * **不写盘**，免得轮尾卡出现一张空 diff）。
 */
export function sortBib(source: string, by: BibSortBy = "key"): BibEditOutcome {
  const blocks = bibBlocks(source);
  const entries = blocks.filter((block) => block.kind === "entry" && block.key !== null);
  const parsed = parseBibtex(source).entries;
  const slots = entries.map((block, index) => {
    const entry = parsed[index];
    return {
      block,
      key: block.key ?? "",
      year: entry?.year ?? null,
      author: entry?.author ?? null,
      index,
    };
  });

  const sorted = [...slots].sort((a, b) => {
    if (by === "year") {
      const yearDiff = yearNumber(a.year) - yearNumber(b.year);
      if (yearDiff !== 0 && !Number.isNaN(yearDiff)) return yearDiff;
      const authorDiff = (a.author ?? "").toLowerCase().localeCompare((b.author ?? "").toLowerCase(), "en");
      if (authorDiff !== 0) return authorDiff;
    }
    return compareKey(a.key, b.key) || a.index - b.index;
  });

  const moved = sorted.reduce((count, item, index) => (item.index === index ? count : count + 1), 0);
  const next = replaceEntries(source, blocks, sorted.map((item) => item.block));
  return {
    source: next,
    entries: slots.length,
    moved,
    before: slots.slice(0, PREVIEW_KEYS).map((item) => item.key),
    after: sorted.slice(0, PREVIEW_KEYS).map((item) => item.key),
    changed: next !== source,
  };
}

/**
 * 把原文里的条目槽按 `replacements` 的顺序换掉；条目外的文本（前缀、块间空行、
 * `@string` / `@comment` 块）原样留在原位。`replacements` 与原文里的条目块数量
 * 必须一致（排序不增删条目）。
 */
function replaceEntries(
  source: string,
  blocks: ReturnType<typeof bibBlocks>,
  replacements: ReturnType<typeof bibBlocks>,
): string {
  let out = "";
  let cursor = 0;
  let next = 0;
  for (const block of blocks) {
    out += source.slice(cursor, block.start);
    if (block.kind === "entry") {
      const replacement = replacements[next];
      out += replacement === undefined ? source.slice(block.start, block.end) : source.slice(replacement.start, replacement.end);
      next += 1;
    } else {
      out += source.slice(block.start, block.end);
    }
    cursor = block.end;
  }
  out += source.slice(cursor);
  return out;
}

/**
 * 对齐：每个条目内所有 `字段名 =` 的等号对齐到该条目最长字段名之后（至少一个
 * 空格）。只看**条目体里深度 0** 的行——字段值里跨行的 `title =` 字样不会被误认；
 * `%` 注释行跳过。行尾（含 CRLF）原样保留。
 */
export function alignBib(source: string): BibEditOutcome {
  const blocks = bibBlocks(source);
  const aligned = new Map<number, string>();
  let entryCount = 0;
  let changedEntries = 0;
  for (const block of blocks) {
    if (block.kind !== "entry") continue;
    entryCount += 1;
    const text = source.slice(block.start, block.end);
    const next = alignEntry(text);
    if (next !== text) changedEntries += 1;
    aligned.set(block.start, next);
  }
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += source.slice(cursor, block.start);
    out += aligned.get(block.start) ?? source.slice(block.start, block.end);
    cursor = block.end;
  }
  out += source.slice(cursor);
  const keys = blocks.filter((block) => block.kind === "entry").map((block) => block.key ?? "");
  return {
    source: out,
    entries: entryCount,
    moved: changedEntries,
    before: keys.slice(0, PREVIEW_KEYS),
    after: keys.slice(0, PREVIEW_KEYS),
    changed: out !== source,
  };
}

/** 一个条目块内的等号对齐（幂等：第二次跑的输出与第一次完全相同） */
function alignEntry(text: string): string {
  const clean = stripBibComments(text);
  const lines = text.split("\n");
  const cleanLines = clean.split("\n");
  if (lines.length !== cleanLines.length) return text;

  // 条目本身的外层定界符（`@article{…}` / `@misc(…)`）：字段行在它内部的一层，
  // 不能把外层 `{` 当成「正在跨行的字段值」。
  const outerOpen = clean.search(/[{(]/);
  if (outerOpen < 0) return text;
  const opener = clean[outerOpen] ?? "{";
  const closer = opener === "{" ? "}" : ")";

  const fields: { line: number; indent: string; name: string; equalsAt: number }[] = [];
  let outerDepth = 0;
  let braceDepth = 0;
  let quoted = false;
  for (let i = 0; i < cleanLines.length; i += 1) {
    const line = cleanLines[i] ?? "";
    const fieldLine = outerDepth === 1 && (opener === "{" || braceDepth === 0) && !/^\s*%/.test(line);
    if (fieldLine) {
      const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)([ \t]*)=/.exec(line);
      if (match !== null) {
        fields.push({
          line: i,
          indent: match[1] ?? "",
          name: match[2] ?? "",
          equalsAt: (match[0] ?? "").length - 1,
        });
      }
    }
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (ch === opener) outerDepth += 1;
      else if (ch === closer) outerDepth = Math.max(0, outerDepth - 1);
      if (opener === "(") {
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }
  if (fields.length === 0) return text;

  const width = fields.reduce((max, field) => Math.max(max, field.name.length), 0);
  for (const field of fields) {
    const original = lines[field.line] ?? "";
    // 原文与清理后的行等长；等号之后的原文原样保留（值、行尾、行内注释都不动）
    const rest = original.slice(field.equalsAt);
    lines[field.line] = `${field.indent}${field.name}${" ".repeat(width - field.name.length + 1)}${rest}`;
  }
  return lines.join("\n");
}
