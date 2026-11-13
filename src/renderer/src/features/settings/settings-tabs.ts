/**
 * 设置页的页签清单（侧栏设置导航按它铺）。「插件」「记忆库」两个页签 2026-11-06 随功能转正常驻，
 * 不再挂实验开关。
 */
import type { IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";

export type SettingsTab = "general" | "guide" | "providers" | "external-sources" | "browser" | "voice" | "plugins" | "memory" | "experimental";

export interface SettingsTabDef {
  id: SettingsTab;
  icon: IconName;
}

export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: "general", icon: "sliders" },
  // 新手引导：全屏引导的唯一常驻入口（2026-11-07 用户：「应该在设置里有个独立的 tab」）
  { id: "guide", icon: FEATURE_ICON.guide },
  { id: "providers", icon: "cpu" },
  // 外部来源（原「迁移」）：别的工具里的聊天记录只读 + 技能 / MCP 导入
  { id: "external-sources", icon: FEATURE_ICON.externalSources },
  { id: "browser", icon: FEATURE_ICON.browser },
  { id: "voice", icon: "mic" },
  // 插件页的全屏版（右栏图标条的积木图标开的是右栏单列版，两处是同一个组件）
  { id: "plugins", icon: FEATURE_ICON.plugins },
  // 记忆库（原右侧图标条的入口，2026-11-06 挪进设置）
  { id: "memory", icon: FEATURE_ICON.memory },
  { id: "experimental", icon: "flask-conical" },
];
