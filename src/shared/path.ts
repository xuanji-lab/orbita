/**
 * 平台无关的路径小工具。**刻意不引 node:path**：shared 是主进程与 renderer 共用层，
 * renderer 里没有 node 内置——vite 会把 `node:path` 标成 "externalized for browser
 * compatibility"，构建当场失败（2026-09 验收打回的那次）。
 *
 * 切分隔符**按路径自己的形**（looksLikeWindowsPath），不按宿主 OS 也不无条件双切：
 * Windows 原生是反斜杠、POSIX 是正斜杠，两端混着来（原生反斜杠根 + 渲染端拼的 `/`）
 * 也是 Windows 形——因为起头就是；而 POSIX 路径里 `\` 是文件夹名的合法字符
 * （Mac 上 `/Users/x/my\folder` 的末段就是 `my\folder`），无条件双切会把它切错。
 */

/**
 * 盘符、UNC / 设备命名空间、当前盘根相对起头：Windows 形路径。
 *
 * 盘符后面**不要求**跟分隔符：`C:proj` 也是 Windows 形（盘符相对）。代价是以 `\`
 * 起头的 POSIX **相对**路径（`\weird/proj`）会被当成 Windows 形——调用方喂进来的
 * 都是绝对路径，误判朝「多切一个分隔符」那一侧，是想要的那一边。
 */
export function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\");
}

/** 路径末段（文件名 / 文件夹名）。滤掉空段；全是分隔符（如 `/`）时返回空串，回退交给调用方。 */
export function pathTail(path: string): string {
  const parts = (looksLikeWindowsPath(path) ? path.split(/[\\/]/) : path.split("/")).filter(
    (part) => part !== "",
  );
  return parts[parts.length - 1] ?? "";
}

/**
 * `child` 是不是 `parent` 本身或其子孙，**按路径段判**（`/ws/a` 不算 `/ws/ab` 的父）。
 * 两种分隔符都认——父子可能一边是原生反斜杠、一边是渲染端拼的正斜杠；这里的喂入面
 * （renderer 的键、展示层的 `~` 缩写）不会出现「POSIX 名字里带 `\`」的形态，双前缀
 * 误判方向是「多算在内」，安全。
 */
export function pathWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`);
}
