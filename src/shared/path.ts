/**
 * 平台无关的路径小工具。**刻意不引 node:path**：shared 是主进程与 renderer 共用层，
 * renderer 里没有 node 内置——vite 会把 `node:path` 标成 "externalized for browser
 * compatibility"，构建当场失败（2026-09 验收打回的那次）。这里自己切，两种分隔符
 * 都认：Windows 原生路径是反斜杠、POSIX 是正斜杠，两端混着来（原生根 + 渲染端拼的
 * `/`）也对——「不同系统很可能是不同的」，别假设路径只有一种形。
 */

/** 路径末段（文件名 / 文件夹名）。滤掉空段；全是分隔符（如 `/`）时返回空串，回退交给调用方。 */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "";
}

/**
 * `child` 是不是 `parent` 本身或其子孙，**按路径段判**（`/ws/a` 不算 `/ws/ab` 的父）。
 * 两种分隔符都认——父子可能一边是原生反斜杠、一边是渲染端拼的正斜杠。
 */
export function pathWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`);
}
