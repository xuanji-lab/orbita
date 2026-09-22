import type { FileEntry } from "@shared/files";

/**
 * 文件面板的**纯视图函数**（排序 / 过滤 / 判定 / footer 文案）。
 *
 * 独立成模块而不是住进 useFileTree.ts，同主进程 roots.ts / list.ts 与 ipc.ts 分离
 * 的先例：useFileTree.ts 顶层 import api（renderer 的 IPC 入口），而它模块加载时
 * 就摸 `window`——`node --test` 的进程里没有 window，纯函数住那儿就没法直接测。
 */

/**
 * 面板对一层的排序：主进程已按「目录在前、同类按名字」排好，这里只加一条 dotfile
 * 规则——`.` 开头的一律照列（**不做 `.orbita` 这类特殊豁免**：例外名单只会越养
 * 越长），但排在同层最后：它们是机器的文件，不是用户每天找的东西。
 */
export function orderEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [
    ...entries.filter((entry) => !entry.name.startsWith(".")),
    ...entries.filter((entry) => entry.name.startsWith(".")),
  ];
}

/** 本地过滤：只裁剪已加载的条目名，不递归拉取。大小写不敏感；空白词 = 不过滤。 */
export function filterEntries(entries: readonly FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(q));
}

/**
 * workspace 根第一层有没有 AGENTS.md。精确名匹配：agent 与所有模板写的都是这个
 * 大小写；「看起来有」的误报比漏报更糟——提示行是「在 Proma 里找不到规则文件」
 * 这个痛点的落点，不能错报。
 */
export function hasAgentsMd(entries: readonly FileEntry[]): boolean {
  return entries.some((entry) => entry.name === "AGENTS.md");
}

/** footer 文案：`N roots`；attached 根在盘上缺席时追 `· N missing`（如实标出，不静默）。 */
export function footerSummary(groupCount: number, missingAttached: number): string {
  const roots = `${groupCount} root${groupCount === 1 ? "" : "s"}`;
  return missingAttached > 0 ? `${roots} · ${missingAttached} missing` : roots;
}
