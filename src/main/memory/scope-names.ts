/**
 * 记忆作用域的**显示名**（纯模块）。存储与召回的作用域照旧按 memoryScopeOf（workspaceId ?? cwd），
 * 这里只决定界面上叫它什么。
 *
 * 为什么要它：会话 meta 里的 workspaceId 可能指向已经不在 workspaces.json 的工作区（从
 * OpenCode / MiniMax 等导入的旧会话、或工作区被删了）。以前直接拿 id 当名字，「从历史生成」
 * 的列表里出现一串 uuid（2026-10-30 用户：「为什么有这么多很长 id 的工作区」）。回落规则：
 * 用这些会话 cwd 的末段目录名，多个 cwd 取出现最多的那个，并标成「已不在」（kind missing），
 * 完整路径给悬停。
 */
import { memoryScopeOf } from "../../shared/memory.ts";

export interface ScopeLabel {
  /** workspace = 工作区还在；missing = 会话指向的工作区已不在；cwd = 没有工作区，按目录归 */
  kind: "workspace" | "missing" | "cwd";
  /** 显示名：工作区名 / 已不在的工作区取多数 cwd 的末段目录名 / cwd 作用域是路径本身 */
  name: string;
  /** 悬停的完整路径（missing 与 cwd 有） */
  path?: string;
}

/** 路径的末段目录名（兼容 Windows 分隔符）；取不出就回整条路径。 */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** 作用域 id → 显示名。现存工作区（哪怕没有会话）都在；其余由会话的 meta 推出。 */
export function scopeLabels(
  sessions: readonly { workspaceId: string | null; cwd: string }[],
  workspaces: readonly { id: string; name: string }[],
): Map<string, ScopeLabel> {
  const labels = new Map<string, ScopeLabel>();
  for (const workspace of workspaces) labels.set(workspace.id, { kind: "workspace", name: workspace.name });
  const missingCwds = new Map<string, Map<string, number>>();
  for (const meta of sessions) {
    const scopeId = memoryScopeOf(meta);
    if (labels.get(scopeId)?.kind === "workspace") continue;
    if (meta.workspaceId === null) {
      labels.set(scopeId, { kind: "cwd", name: meta.cwd, path: meta.cwd });
      continue;
    }
    const counts = missingCwds.get(scopeId) ?? new Map<string, number>();
    counts.set(meta.cwd, (counts.get(meta.cwd) ?? 0) + 1);
    missingCwds.set(scopeId, counts);
  }
  for (const [scopeId, counts] of missingCwds) {
    // 出现最多的 cwd；并列按路径字典序取第一个，结果稳定
    const [cwd] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    labels.set(scopeId, { kind: "missing", name: lastSegment(cwd), path: cwd });
  }
  return labels;
}
