/**
 * 右栏面板位里「某个插件的面板」怎么编码成一种面板（RightPanelKind 的模板字面量分支）。
 * 单独成文件只为可测、且让 right-panel-memory 这类纯模块不必依赖 React 组件。
 */
const PREFIX = "plugin-panel:";

export type PluginPanelKind = `plugin-panel:${string}`;

export function pluginPanelKind(pluginName: string): PluginPanelKind {
  return `${PREFIX}${pluginName}`;
}

/** 是插件面板就返回插件名，否则 null。 */
export function pluginPanelNameOf(kind: string | null): string | null {
  return kind !== null && kind.startsWith(PREFIX) && kind.length > PREFIX.length ? kind.slice(PREFIX.length) : null;
}
