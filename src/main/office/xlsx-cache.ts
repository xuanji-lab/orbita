/**
 * 批写之后补公式缓存值（2026-11-14 验收 B9）。
 *
 * 现象：`edit_office` 改 C4 89→66 后，网格里 E4（`=C4*D4`）与 E7（`=SUM(E2:E6)`）变空；
 * 渲染视图（OfficeCLI）是 660 与正确合计。字节层原因：officecli 重算后只写公式不写缓存——
 * `<c r="E4"><f>C4*D4</f></c>`，没动过的 E2/E3 仍是 `<v>597</v>`。ExcelJS 读公式格时
 * 用缓存值当显示值（与 Excel 打开时的行为一致），没有缓存就没有文字。
 *
 * 修法（选了「补写 XML」而不是「网格显示占位」）：写批次成功之后，扫描工作表 XML 里
 * **有 `<f>` 没有 `<v>`** 的格，问 officecli 要它们的计算值（一次 `batch get`，officecli
 * 读公式格时会求值），把 `<v>` 插回对应 `<c>` 里，再用原子写落盘。
 * 只改动这些格、只发生在写批次之后；没有缺缓存的格时不 spawn、不写盘。
 *
 * 为什么不让 officecli 自己重算一遍：实测 `set` 同一个公式会写回缓存，但会让**依赖它的
 * 其它公式**再次丢缓存（链式），修完再扫一轮可能又有新的——与其多轮猜，直接按「谁缺就补谁」
 * 一次写清。数值结果之外的（字符串 / 日期格式化的结果）不补，网格那边显示 `—` 占位。
 */
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { writeBytesAtomic } from "../atomic-write.ts";

/** 一次补缓存最多处理多少格（防病态工作簿把一次编辑拖成几分钟） */
export const MAX_CACHED_CELLS = 200;

export interface FormulaCellRef {
  sheet: string;
  cell: string;
}

/** 数值文本才写进 `<v>`（字符串 / 日期结果让网格走占位，避免写错类型） */
export function isNumericValue(text: string): boolean {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text.trim());
}

/** `<sheet name="…" r:id="…"/>`（属性顺序不固定，逐个取） */
function parseWorkbookSheets(xml: string): { name: string; rid: string }[] {
  const out: { name: string; rid: string }[] = [];
  for (const match of xml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(match[0])?.[1];
    const rid = /\br:id="([^"]*)"/.exec(match[0])?.[1];
    if (name !== undefined && rid !== undefined) out.push({ name, rid });
  }
  return out;
}

/** rels：`Id → Target`（target 相对 `xl/`） */
function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1];
    if (id !== undefined && target !== undefined) map.set(id, target);
  }
  return map;
}

/** 工作表 XML 路径归一化：`/xl/worksheets/sheet1.xml` / `worksheets/sheet1.xml` → `xl/worksheets/sheet1.xml` */
function worksheetPath(target: string): string {
  const cleaned = target.replace(/^\/+/, "");
  return cleaned.startsWith("xl/") ? cleaned : `xl/${cleaned}`;
}

/** `<c r="A1" …>…</c>`（允许前缀；自闭合的格不可能带公式，不匹配） */
const cellPattern = (): RegExp => /<((?:[A-Za-z0-9_.-]+:)?)c\b([^>]*)>([\s\S]*?)<\/\1c>/g;

interface MissingCell extends FormulaCellRef {
  xmlName: string;
}

/** 扫出「有公式、没有缓存值」的格（不修改文件） */
async function scanMissing(zip: JSZip): Promise<MissingCell[]> {
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (workbook === undefined || rels === undefined) return [];
  const targets = parseRels(rels);
  const missing: MissingCell[] = [];
  for (const sheet of parseWorkbookSheets(workbook)) {
    const target = targets.get(sheet.rid);
    if (target === undefined) continue;
    const xmlName = worksheetPath(target);
    const xml = await zip.file(xmlName)?.async("string");
    if (xml === undefined) continue;
    for (const match of xml.matchAll(cellPattern())) {
      const inner = match[3] as string;
      if (!/<(?:[A-Za-z0-9_.-]+:)?f\b/.test(inner)) continue;
      if (/<(?:[A-Za-z0-9_.-]+:)?v\b/.test(inner)) continue;
      const cell = /\br="([A-Za-z]{1,3}[0-9]{1,7})"/.exec(match[2] as string)?.[1];
      if (cell !== undefined) missing.push({ sheet: sheet.name, cell, xmlName });
    }
  }
  return missing;
}

/** 给一格的内文插入 `<prefix:v>value</prefix:v>`（紧跟 `</f>` / 自闭合 `<f/>` 之后） */
function withCachedValue(inner: string, prefix: string, value: string): string {
  const f = /<((?:[A-Za-z0-9_.-]+:)?)f\b[^>]*\/>|<((?:[A-Za-z0-9_.-]+:)?)f\b[^>]*>[\s\S]*?<\/\2f>/.exec(inner);
  if (f === null) return inner;
  const tag = prefix === "" ? "v" : `${prefix}v`;
  const closed = prefix === "" ? "</v>" : `</${prefix}v>`;
  const insertAt = (f.index ?? 0) + f[0].length;
  return `${inner.slice(0, insertAt)}<${tag}>${value}</${closed.slice(2)}${inner.slice(insertAt)}`;
}

/**
 * 补写缺失的公式缓存值。
 *
 * `readValues` 由调用方给（生产是 officecli 的 get 批次；测试直接给 Map），
 * 返回 `{ patched, missing }`：missing 是发现的数量，patched 是真正补上的数量。
 * **不再改写原文件以外的东西**：只有 patched > 0 才原子写回整份工作簿（zip 重打包）。
 */
export async function fillMissingFormulaCaches(
  path: string,
  readValues: (cells: readonly FormulaCellRef[]) => Promise<Map<string, string>>,
  options: { maxCells?: number } = {},
): Promise<{ patched: number; missing: number }> {
  const maxCells = options.maxCells ?? MAX_CACHED_CELLS;
  const bytes = await readFile(path);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { patched: 0, missing: 0 };
  }
  const missing = await scanMissing(zip);
  if (missing.length === 0) return { patched: 0, missing: 0 };

  const wanted = missing.slice(0, maxCells);
  const values = await readValues(wanted.map(({ sheet, cell }) => ({ sheet, cell })));
  if (values.size === 0) return { patched: 0, missing: missing.length };

  // 按工作表分组，一次替换该表里的全部待补格
  const byXml = new Map<string, MissingCell[]>();
  for (const entry of wanted) {
    const list = byXml.get(entry.xmlName) ?? [];
    list.push(entry);
    byXml.set(entry.xmlName, list);
  }
  let patched = 0;
  for (const [xmlName, cells] of byXml) {
    const xml = await zip.file(xmlName)?.async("string");
    if (xml === undefined) continue;
    const wantedByCell = new Map(cells.map((entry) => [entry.cell, entry]));
    const next = xml.replace(cellPattern(), (block: string, prefix: string, attrs: string, inner: string) => {
      const cell = /\br="([A-Za-z]{1,3}[0-9]{1,7})"/.exec(attrs)?.[1];
      const entry = cell === undefined ? undefined : wantedByCell.get(cell);
      if (entry === undefined) return block;
      const value = values.get(`${entry.sheet}\u0000${entry.cell}`);
      if (value === undefined || !isNumericValue(value)) return block;
      patched += 1;
      return `<${prefix}c${attrs}>${withCachedValue(inner, prefix, value.trim())}</${prefix}c>`;
    });
    if (next !== xml) zip.file(xmlName, next);
  }
  if (patched === 0) return { patched: 0, missing: missing.length };

  const out = await zip.generateAsync({ type: "nodebuffer" });
  await writeBytesAtomic(path, out);
  return { patched, missing: missing.length };
}

/** 测试与调用方的键（sheet + 格） */
export function formulaCellKey(sheet: string, cell: string): string {
  return `${sheet}\u0000${cell}`;
}
