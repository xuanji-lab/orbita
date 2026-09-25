/**
 * Migration 页 MCP 一段的纯逻辑：默认勾选与出处的写法。`node --test` 直接测。
 */
import type { ImportMcpItem, ImportMcpOrigin, ImportSourceId } from "@shared/import";
import { abbreviateHome } from "./migration-groups.ts";
import type { Messages } from "../../messages-en.ts";

/** 能勾的：只有 new。 */
export function isSelectableMcp(item: ImportMcpItem): boolean {
  return item.status === "new";
}

/** 默认勾选：new 全勾（导进来是停用的，勾上不会让任何东西开始运行）。 */
export function defaultMcpSelection(items: readonly ImportMcpItem[]): Set<string> {
  return new Set(items.filter((item) => item.status === "new").map((item) => item.name));
}

/** 各来源能导的 server 数（来源行上的计数）：同名的多份在每个出处来源各计一次。 */
export function mcpCountBySource(items: readonly ImportMcpItem[]): Partial<Record<ImportSourceId, number>> {
  const counts: Partial<Record<ImportSourceId, number>> = {};
  for (const item of items) {
    if (!isSelectableMcp(item)) continue;
    for (const source of new Set(item.origins.map((origin) => origin.source))) {
      counts[source] = (counts[source] ?? 0) + 1;
    }
  }
  return counts;
}

export function selectedMcpNames(items: readonly ImportMcpItem[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => item.status === "new" && selected.has(item.name)).map((item) => item.name);
}

/**
 * 出处：「Proma · Claude Code」；只在某个项目里配的写出项目（「Claude Code, only in ~/repo/app」）。
 * 同一来源出现多次（Proma 的几个工作区都配了）只写一次来源名。
 */
export function mcpOriginLabel(origins: readonly ImportMcpOrigin[], home: string, t: Messages): string {
  const parts: string[] = [];
  for (const origin of origins) {
    const source = t.migration.sources[origin.source];
    const label =
      origin.source === "claude-code" && origin.where !== null
        ? t.migration.onlyIn(source, abbreviateHome(origin.where, home))
        : source;
    if (!parts.includes(label)) parts.push(label);
  }
  return parts.join(" · ");
}

/** 行尾的状态字；可导的 new 没有。 */
export function mcpStatusLabel(item: ImportMcpItem, t: Messages): string | null {
  if (item.status === "in-orbita") return t.migration.alreadyInOrbita;
  if (item.status === "unsupported") return item.reason ?? t.migration.cantImport;
  return null;
}
