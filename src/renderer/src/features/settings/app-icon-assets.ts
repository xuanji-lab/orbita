/// <reference types="vite/client" />
/**
 * 应用图标 SVG 的取用。32 个文件在 `design-system/assets/app-icons/<kind>-<id>.svg`：
 * - 缩略图用 URL（eager 只是拿到 URL 字符串，文件由浏览器按需加载，不进 JS 包）；
 * - 栅格化用文本（lazy，选中某一款时才动态加载那一个文件，不把 840 KB 的 SVG 塞进启动包）。
 */
import type { AppIconId } from "@shared/app-icon";

const urls = import.meta.glob<string>("../../../../../design-system/assets/app-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
const sources = import.meta.glob<string>("../../../../../design-system/assets/app-icons/*.svg", {
  query: "?raw",
  import: "default",
});

function byId<T>(table: Record<string, T>, id: AppIconId): T {
  const hit = Object.entries(table).find(([path]) => path.endsWith(`/${id}.svg`));
  if (hit === undefined) throw new Error(`缺少应用图标素材：${id}.svg`);
  return hit[1];
}

/** 缩略图的 URL */
export function appIconUrl(id: AppIconId): string {
  return byId(urls, id);
}

/** 栅格化用的 SVG 文本 */
export async function loadAppIconSvg(id: AppIconId): Promise<string> {
  return byId(sources, id)();
}
