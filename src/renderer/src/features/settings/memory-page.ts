/**
 * 设置 › 记忆页的纯函数层：把「工作区清单 + 各作用域的条目」整理成显示用的分组。
 * 不碰 React、不碰 IPC，`node --test` 直接测（memory-page.test.ts）。
 *
 * 作用域语义与主进程一致（shared/memory.ts：workspaceId ?? cwd）。这一页只列
 * **工作区**的记忆：不属于任何工作区的会话记忆 v1 不展示，UI 也不处理
 * workspaceId=null——条目按 workspaceApi 给的工作区逐个取，取不到的就是没有。
 */
import type { MemoryEntry } from "@shared/memory";
import type { Workspace } from "@shared/workspace";

export interface MemoryGroup {
  workspace: Workspace;
  /** 该工作区的条目，最近发生的在前 */
  entries: MemoryEntry[];
}

/**
 * 分组：按 workspaceApi 给的顺序（用户自己的排序）过一遍。
 *
 * **没有条目的工作区不成组**——页面列的单位是记忆条目，空组只是一行顶着工作区
 * 名字的标题，底下什么都没有；整个库都空时由页面的空态说话（memoryGroups 返回
 * 空数组就是那个信号）。
 *
 * 组内按 timestamp 新的在前：用户翻记忆库时先看到最近沉淀的。同一轮蒸馏出的
 * 多条时间戳相同，稳定排序保持落盘顺序（Array.prototype.sort 在 ES2019 后稳定）。
 */
export function memoryGroups(
  workspaces: readonly Workspace[],
  entriesOf: (workspace: Workspace) => readonly MemoryEntry[],
): MemoryGroup[] {
  const groups: MemoryGroup[] = [];
  for (const workspace of workspaces) {
    const entries = [...entriesOf(workspace)].sort((a, b) => b.timestamp - a.timestamp);
    if (entries.length === 0) continue;
    groups.push({ workspace, entries });
  }
  return groups;
}
