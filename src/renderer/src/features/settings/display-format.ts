/**
 * 设置面里显示路径与日期的小件（外部来源页、技能 / MCP 两步、登录导入行共用）。纯函数。
 */
import { pathWithin } from "../../../../shared/path.ts";

/** 路径里的家目录缩成 ~（机器事实照样 mono 显示，只是短一点）。 */
export function abbreviateHome(path: string, home: string): string {
  if (home === "") return path;
  if (path === home) return "~";
  return pathWithin(home, path) ? `~${path.slice(home.length)}` : path;
}

/** 行上的日期：今年的只写月-日，往年的带年份。 */
export function formatDay(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() === new Date(now).getFullYear() ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 长路径中间省略：留开头与结尾（结尾最认得出——是哪个目录），中间换成「…」。CSS 只会截尾，
 * 截尾会把行尾的标签（如「手动添加」）一起挤掉，所以在这里按字符数截。不超长原样返回。
 */
export function middleEllipsis(path: string, max = 64): string {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}
