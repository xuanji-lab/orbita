/**
 * 迁移页的 MCP 一段：读其他 agent 的 MCP 配置，按名字勾选加进 orbita 的 mcp.json，**一律停用**
 * （设计稿裁决 #7：用户按需打开）。纯 node 模块，`node --test` 直接测。源配置文件只读。
 *
 * 各家的形状（2026-09-25 本机）：
 * - Proma：`agent-workspaces/<slug>/mcp.json` → `{ servers: { 名: { type: stdio|http|sse, command, args, env,
 *   url, headers, enabled } } }`，一个工作区一份。
 * - Claude Code：`~/.claude.json` 顶层 `mcpServers`（全局）与 `projects[目录].mcpServers`（只对那个项目），
 *   `{ type: stdio|http|sse, command, args, env, url, headers }`，缺 type 的按 stdio。
 * - Kimi Code：`~/.kimi-code/mcp.json` → `{ mcpServers: {…} }`，与 Claude Code 同形。
 *
 * 转成 orbita 的形状（McpServer）：stdio → command / args / env / cwd；http → url / headers。
 * **SSE 传输 orbita 不支持**（只有 stdio 与 streamable HTTP），列出来标 unsupported，不硬转成 http——
 * 协议不同，转过去也连不上，还会让人以为导成功了。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeServer, isMcpServerName, type McpServer } from "../../shared/mcp.ts";
import type { ImportMcpItem, ImportMcpOrigin } from "../../shared/import.ts";

/** 源里的一台 server：出处 + 名字 + 转换结果（转不了时 server 为 null、reason 写原因）。 */
export interface McpSourceEntry {
  origin: ImportMcpOrigin;
  name: string;
  server: McpServer | null;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Claude Desktop 系的一条配置（Proma 与 Claude Code 同形）→ orbita 的 McpServer。
 * 转不了返回原因字符串。
 */
export function toOrbitaServer(raw: unknown): McpServer | string {
  if (!isRecord(raw)) return "not a server entry";
  const type = raw["type"];
  if (type === "sse") return "SSE transport isn't supported here";
  const url = typeof raw["url"] === "string" && raw["url"] !== "" ? raw["url"] : null;
  if (type === "http" || type === "streamable-http" || (type === undefined && url !== null && raw["command"] === undefined)) {
    if (url === null) return "no URL";
    const headers = stringRecord(raw["headers"]);
    return { transport: "http", url, ...(headers === null ? null : { headers }) };
  }
  if (type !== undefined && type !== "stdio") return `unknown transport: ${String(type)}`;
  const command = typeof raw["command"] === "string" && raw["command"] !== "" ? raw["command"] : null;
  if (command === null) return "no command";
  const args = stringList(raw["args"]);
  const env = stringRecord(raw["env"]);
  const cwd = typeof raw["cwd"] === "string" && raw["cwd"] !== "" ? raw["cwd"] : null;
  return {
    transport: "stdio",
    command,
    ...(args === null || args.length === 0 ? null : { args }),
    ...(env === null ? null : { env }),
    ...(cwd === null ? null : { cwd }),
  };
}

function entriesOf(servers: unknown, origin: ImportMcpOrigin): McpSourceEntry[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const converted = toOrbitaServer(raw);
    return typeof converted === "string"
      ? { origin, name, server: null, reason: converted }
      : { origin, name, server: converted, reason: null };
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // 不在、读不了、坏 JSON：这个来源就没有 MCP 可导（别的来源照常）
    return null;
  }
}

/** Proma：每个工作区一份 mcp.json（工作区列表与 skills 共用 promaWorkspaceFolders）。 */
export async function readPromaMcp(promaRoot: string, workspaces: readonly { slug: string; name: string }[]): Promise<McpSourceEntry[]> {
  const entries: McpSourceEntry[] = [];
  for (const workspace of workspaces) {
    const parsed = await readJson(join(promaRoot, "agent-workspaces", workspace.slug, "mcp.json"));
    if (!isRecord(parsed)) continue;
    entries.push(...entriesOf(parsed["servers"], { source: "proma", where: workspace.name }));
  }
  return entries;
}

/** Claude Code：~/.claude.json 的全局 mcpServers，再是各项目的（出处写项目目录）。 */
export async function readClaudeCodeMcp(claudeJson: string): Promise<McpSourceEntry[]> {
  const parsed = await readJson(claudeJson);
  if (!isRecord(parsed)) return [];
  const entries = entriesOf(parsed["mcpServers"], { source: "claude-code", where: null });
  const projects = parsed["projects"];
  if (isRecord(projects)) {
    for (const [path, project] of Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))) {
      if (isRecord(project)) entries.push(...entriesOf(project["mcpServers"], { source: "claude-code", where: path }));
    }
  }
  return entries;
}

/** Kimi Code：~/.kimi-code/mcp.json 的 mcpServers（没有按项目的配置）。 */
export async function readKimiCodeMcp(file: string): Promise<McpSourceEntry[]> {
  const parsed = await readJson(file);
  return isRecord(parsed) ? entriesOf(parsed["mcpServers"], { source: "kimi-code", where: null }) : [];
}

/**
 * 按名字归并成页面的行：同名的第一份（来源顺序）是要导的配置，其余只进 origins。
 * 同名但第一份转不了、后面有能转的，取能转的那份——名字相同时用户要的是「这台 server」。
 */
export function mergeMcpEntries(entries: readonly McpSourceEntry[], existing: ReadonlySet<string>): {
  items: ImportMcpItem[];
  servers: Map<string, McpServer>;
} {
  const byName = new Map<string, McpSourceEntry[]>();
  for (const entry of entries) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  const items: ImportMcpItem[] = [];
  const servers = new Map<string, McpServer>();
  for (const [name, group] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const chosen = group.find((entry) => entry.server !== null) ?? group[0];
    if (chosen === undefined) continue;
    const origins: ImportMcpOrigin[] = [];
    for (const entry of group) {
      if (!origins.some((origin) => origin.source === entry.origin.source && origin.where === entry.origin.where)) {
        origins.push(entry.origin);
      }
    }
    const server = chosen.server;
    const reason = server === null ? chosen.reason : !isMcpServerName(name) ? "the name has characters orbita doesn't allow" : null;
    const status: ImportMcpItem["status"] = existing.has(name) ? "in-orbita" : reason !== null ? "unsupported" : "new";
    items.push({
      name,
      transport: server?.transport === "http" ? "http" : "stdio",
      detail: server === null ? "" : describeServer(server),
      carriesSecrets:
        server !== null &&
        ((server.transport === "http" && server.headers !== undefined) || (server.transport !== "http" && server.env !== undefined)),
      origins,
      status,
      reason: status === "unsupported" ? reason : null,
    });
    if (status === "new" && server !== null) servers.set(name, server);
  }
  return { items, servers };
}

/**
 * 执行：勾选的名字里、重扫仍是 new 的，逐台加进 orbita（**停用**）。单台失败记下继续；
 * 至少加了一台时调一次 reload，让 MCP 面板与运行时读到新配置。
 */
export async function importMcpServers(
  servers: ReadonlyMap<string, McpServer>,
  chosen: ReadonlySet<string>,
  target: { add(name: string, server: McpServer): Promise<void>; reload(): Promise<void> },
): Promise<{ imported: number; failed: { name: string; error: string }[] }> {
  let imported = 0;
  const failed: { name: string; error: string }[] = [];
  for (const [name, server] of servers) {
    if (!chosen.has(name)) continue;
    try {
      await target.add(name, { ...server, disabled: true });
      imported += 1;
    } catch (cause) {
      failed.push({ name, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  if (imported > 0) {
    await target.reload().catch((cause: unknown) => {
      console.error("[import] MCP 配置已写入，重读失败（下次开轮会用新配置）", cause);
    });
  }
  return { imported, failed };
}
