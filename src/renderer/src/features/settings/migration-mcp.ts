/**
 * Migration 页 MCP 一段的纯逻辑：默认勾选与出处的写法。`node --test` 直接测。
 */
import type { ImportMcpItem, ImportMcpOrigin } from "@shared/import";
import { SOURCE_LABEL, abbreviateHome } from "./migration-groups.ts";

/** 能勾的：只有 new。 */
export function isSelectableMcp(item: ImportMcpItem): boolean {
  return item.status === "new";
}

/** 默认勾选：new 全勾（导进来是停用的，勾上不会让任何东西开始运行）。 */
export function defaultMcpSelection(items: readonly ImportMcpItem[]): Set<string> {
  return new Set(items.filter((item) => item.status === "new").map((item) => item.name));
}

export function selectedMcpNames(items: readonly ImportMcpItem[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => item.status === "new" && selected.has(item.name)).map((item) => item.name);
}

/**
 * 出处：「Proma · Claude Code」；只在某个项目里配的写出项目（「Claude Code, only in ~/repo/app」）。
 * 同一来源出现多次（Proma 的几个工作区都配了）只写一次来源名。
 */
export function mcpOriginLabel(origins: readonly ImportMcpOrigin[], home: string): string {
  const parts: string[] = [];
  for (const origin of origins) {
    const label =
      origin.source === "claude-code" && origin.where !== null
        ? `${SOURCE_LABEL[origin.source]}, only in ${abbreviateHome(origin.where, home)}`
        : SOURCE_LABEL[origin.source];
    if (!parts.includes(label)) parts.push(label);
  }
  return parts.join(" · ");
}

/** 行尾的状态字；可导的 new 没有。 */
export function mcpStatusLabel(item: ImportMcpItem): string | null {
  if (item.status === "in-orbita") return "Already in orbita";
  if (item.status === "unsupported") return item.reason ?? "Can't be imported";
  return null;
}
