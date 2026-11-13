/**
 * 草稿的视图：还没安装的插件文件夹，用与已装页同一形状的 `PluginView` 给出——
 * 「正在做」就是同一张详情长页，所以草稿也走同一份解析（安装前预览的结果）。纯函数，不碰盘。
 * 草稿没有启用范围（off）、没有安装记录（install 为 null）、不报冲突（装上之前冲突不是此刻要看的事）。
 */
import {
  pluginViewId,
  type PluginConfigState,
  type PluginPreview,
  type PluginView,
} from "../../shared/plugin.ts";
import { EMPTY_PLUGIN_IO } from "../../shared/plugin-board.ts";

export function draftViewOf(preview: PluginPreview): PluginView {
  const config: PluginConfigState[] = preview.config.map((field) => ({ field, value: null, isSet: false }));
  return {
    id: pluginViewId("plugin", preview.name),
    origin: "plugin",
    name: preview.displayName,
    description: preview.description,
    author: preview.author,
    version: preview.version,
    license: preview.license,
    scope: { kind: "off" },
    placement: null,
    contents: { skills: preview.skills.length, mcp: preview.mcp.length, scripts: preview.hasScripts },
    skills: preview.skills,
    workflow: preview.workflow,
    io: preview.io,
    external: preview.external,
    board: preview.board,
    tuned: preview.tuned,
    mcp: preview.mcp,
    unsupported: preview.unsupported,
    config,
    conflicts: [],
    problems: preview.problems,
    install: null,
    location: preview.root,
  };
}

/** 文件夹里什么都还没有（没有清单、没有技能）：一张什么都没聊到的页。 */
export function emptyDraftView(name: string, root: string): PluginView {
  return {
    id: pluginViewId("plugin", name),
    origin: "plugin",
    name,
    description: "",
    author: null,
    version: null,
    license: null,
    scope: { kind: "off" },
    placement: null,
    contents: { skills: 0, mcp: 0, scripts: false },
    skills: [],
    workflow: [],
    io: EMPTY_PLUGIN_IO,
    external: [],
    board: null,
    tuned: false,
    mcp: [],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: null,
    location: root,
  };
}
