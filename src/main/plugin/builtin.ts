/**
 * 内置插件的内容目录。**纯模块**（不 import electron），可被 `node --test` 直接加载。
 *
 * 内置插件（plugin-creator 等，名字表见 shared/plugin.ts 的 BUILTIN_PLUGIN_NAMES）的内容是产品资源，
 * 源码在仓库 `resources/builtin-plugins/<名>/`：打包版由 electron-builder 的 extraResources 放进
 * `<resources>/builtin-plugins/`（asar 之外，agent 进程和 pi 能直接按文件路径读）；开发版直接读仓库里这份，
 * 改了技能内容下一轮就生效。
 */
import { join } from "node:path";

export function builtinPluginsDir(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged ? join(input.resourcesPath, "builtin-plugins") : join(input.appPath, "resources", "builtin-plugins");
}
