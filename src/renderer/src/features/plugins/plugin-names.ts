/**
 * 插件标识 → 中文显示名：`/plugin:<name>` 的 chip 显示的是显示名（输入框里与气泡里），
 * 取不到（插件被卸了、列表还没读到）显示 name 本身。
 *
 * 真源是 `plugin:list`（PluginView.name = 显示名，id = `plugin:<标识>`）。这里只放纯函数；
 * 模块级的小表与订阅在 usePluginNames.ts。
 */
import { parsePluginViewId, type PluginView } from "../../../../shared/plugin.ts";

/** 真插件的 标识 → 显示名；旧技能 / 旧 MCP 不是 `/plugin:` 的对象，不进表。 */
export function pluginNameMap(views: ReadonlyArray<Pick<PluginView, "id" | "origin" | "name">>): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const view of views) {
    if (view.origin !== "plugin") continue;
    const key = parsePluginViewId(view.id)?.key;
    if (key !== undefined) names.set(key, view.name);
  }
  return names;
}

/** chip 上写的名字：有显示名用显示名，没有就是标识本身。 */
export function pluginChipName(names: ReadonlyMap<string, string>, target: string): string {
  const shown = names.get(target);
  return shown === undefined || shown === "" ? target : shown;
}
