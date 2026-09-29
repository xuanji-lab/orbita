/**
 * 登录状态导入的账本：哪些网站、从哪个浏览器、什么时候导进了受管浏览器。
 *
 * 为什么要记账：受管浏览器的 cookie 库分不出「导入的」和「浏览时网站自己种的」，
 * 而设置页要告诉用户「你把哪些网站的登录交给了内置浏览器」——只能导入时自己记下。
 * 账本只记事实（网站、来源、时刻），不记 cookie；「此刻还在不在」每次去 cookie 库现查
 * （chrome-import.ts 的 LoginImporter.imported），账本不替 cookie 库说话。
 *
 * 落盘：userData/browser-imports.json，原子写。读不出来（不存在 / 坏 JSON）当空账本——
 * 丢的只是「导入过」的记录，登录状态本身在 cookie 库里不受影响。
 * 纯 node 模块，不 import electron（node --test 直接加载）。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";

export interface ImportLedgerEntry {
  site: string;
  browserName: string;
  profileName: string;
  /** 毫秒 */
  importedAt: number;
}

const LEDGER_VERSION = 1;

/** 容错解析：整体形状不对回空；逐条校验，坏条目丢掉不连累别的；同一网站只留最新一次 */
export function parseImportLedger(raw: unknown): ImportLedgerEntry[] {
  if (raw === null || typeof raw !== "object") return [];
  const sites = (raw as { sites?: unknown }).sites;
  if (!Array.isArray(sites)) return [];
  const bySite = new Map<string, ImportLedgerEntry>();
  for (const item of sites) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const { site, browserName, profileName, importedAt } = record;
    if (typeof site !== "string" || site === "") continue;
    if (typeof browserName !== "string" || typeof profileName !== "string") continue;
    if (typeof importedAt !== "number" || !Number.isFinite(importedAt)) continue;
    const previous = bySite.get(site);
    if (previous === undefined || previous.importedAt < importedAt) {
      bySite.set(site, { site, browserName, profileName, importedAt });
    }
  }
  return sortBySite([...bySite.values()]);
}

/** 记一次导入：这些网站的条目换成本次的来源与时刻（重新导入 = 刷新），其余不动 */
export function recordImports(
  entries: readonly ImportLedgerEntry[],
  sites: readonly string[],
  source: { browserName: string; profileName: string },
  importedAt: number,
): ImportLedgerEntry[] {
  const fresh = new Set(sites);
  const kept = entries.filter((entry) => !fresh.has(entry.site));
  const added = [...fresh].map((site) => ({ site, ...source, importedAt }));
  return sortBySite([...kept, ...added]);
}

export async function readImportLedger(path: string): Promise<ImportLedgerEntry[]> {
  try {
    return parseImportLedger(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}

export async function writeImportLedger(path: string, entries: readonly ImportLedgerEntry[]): Promise<void> {
  await writeJsonAtomic(path, { version: LEDGER_VERSION, sites: entries });
}

function sortBySite(entries: ImportLedgerEntry[]): ImportLedgerEntry[] {
  return entries.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
}
