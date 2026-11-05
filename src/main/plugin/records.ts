/**
 * `<userData>/plugins.json`：真插件的安装记录。**只存事实，不存派生物**——清单里的技能 / MCP
 * 每次从目录现读（改了源文件夹下一轮就生效），记录里只有「谁、从哪来、哪个版本、在哪启用、
 * 用户填了什么」。非敏感配置值在这里；敏感值走系统密钥库，这里只记「哪几个键有值」
 * （`secretKeys`），卸载时据此清掉，密文永远不进这个文件（它和 providers.json 一样是能贴给别人看的）。
 *
 * 读坏的单条记录跳过并留日志，不让一条坏记录挡住其余插件；文件本身解析不了则往上抛——
 * 把「读不出来」说成「一个都没装」会让用户去重装，而重装会覆盖（D-3 同款）。
 */
import { readFile } from "node:fs/promises";
import { isNotFound } from "../fs-errors.ts";
import {
  isPluginName,
  type PluginConfigValue,
  type PluginPlacement,
  type PluginScope,
  type PluginSourceRecord,
} from "../../shared/plugin.ts";

export interface PluginRecord {
  name: string;
  source: PluginSourceRecord;
  version: string | null;
  installedAt: number;
  updatedAt: number;
  /** 有效范围（spec：off | global | workspaces[ids]） */
  scope: PluginScope;
  /** 停用前的位置：停用的行仍落在原来的组里；开关一拨回到它 */
  placement: PluginPlacement;
  /** 非敏感配置值 */
  config: Record<string, PluginConfigValue>;
  /** 有值存在密钥库里的敏感配置键（不含值） */
  secretKeys: string[];
}

export interface PluginsFile {
  version: 1;
  plugins: Record<string, PluginRecord>;
}

export async function readPluginRecords(filePath: string): Promise<PluginRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return parsePluginRecords(JSON.parse(raw));
}

export function parsePluginRecords(raw: unknown): PluginRecord[] {
  if (typeof raw !== "object" || raw === null) return [];
  const table = (raw as Record<string, unknown>)["plugins"];
  if (typeof table !== "object" || table === null || Array.isArray(table)) return [];
  const out: PluginRecord[] = [];
  for (const [name, value] of Object.entries(table)) {
    const record = parseRecord(name, value);
    if (record === null) {
      console.error(`[plugin] plugins.json 里「${name}」这条记录读不了，已跳过（文件不动）`);
      continue;
    }
    out.push(record);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function parseRecord(name: string, value: unknown): PluginRecord | null {
  if (!isPluginName(name) || typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const source = parseSource(r["source"]);
  if (source === null) return null;
  const scope = parseScope(r["scope"]);
  if (scope === null) return null;
  // 旧记录没有 placement 时：有效范围本身就是位置；停用且没位置记忆的回到「所有工作区」
  const placement = parsePlacement(r["placement"]) ?? (scope.kind === "off" ? { kind: "global" as const } : scope);
  const now = Date.now();
  return {
    name,
    source,
    version: typeof r["version"] === "string" && r["version"] !== "" ? r["version"] : null,
    installedAt: typeof r["installedAt"] === "number" ? r["installedAt"] : now,
    updatedAt: typeof r["updatedAt"] === "number" ? r["updatedAt"] : now,
    scope,
    placement,
    config: parseConfig(r["config"]),
    secretKeys: Array.isArray(r["secretKeys"]) ? r["secretKeys"].filter((key): key is string => typeof key === "string") : [],
  };
}

function parseSource(raw: unknown): PluginSourceRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s["kind"] === "copy" && typeof s["from"] === "string") return { kind: "copy", from: s["from"] };
  if (s["kind"] === "link" && typeof s["path"] === "string" && s["path"] !== "") return { kind: "link", path: s["path"] };
  if (s["kind"] === "git" && typeof s["url"] === "string" && typeof s["commit"] === "string") {
    return { kind: "git", url: s["url"], commit: s["commit"] };
  }
  return null;
}

export function parseScope(raw: unknown): PluginScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s["kind"] === "off") return { kind: "off" };
  if (s["kind"] === "global") return { kind: "global" };
  if (s["kind"] === "workspaces" && Array.isArray(s["ids"])) {
    const ids = [...new Set(s["ids"].filter((id): id is string => typeof id === "string" && id !== ""))];
    return { kind: "workspaces", ids };
  }
  return null;
}

function parsePlacement(raw: unknown): PluginPlacement | null {
  const scope = parseScope(raw);
  return scope === null || scope.kind === "off" ? null : scope;
}

function parseConfig(raw: unknown): Record<string, PluginConfigValue> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, PluginConfigValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) out[key] = value;
  }
  return out;
}

export function serializePluginRecords(records: readonly PluginRecord[]): PluginsFile {
  const plugins: Record<string, PluginRecord> = {};
  for (const record of [...records].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    plugins[record.name] = record;
  }
  return { version: 1, plugins };
}
