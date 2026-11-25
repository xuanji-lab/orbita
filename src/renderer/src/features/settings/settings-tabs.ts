/**
 * 设置页的页签清单（侧栏设置导航按它铺）。「插件」「记忆库」两个页签 2026-11-06 随功能转正常驻，
 * 不再挂实验开关。
 */
import type { IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";

export type SettingsTab = "general" | "guide" | "providers" | "migration" | "browser" | "voice" | "mobile" | "plugins" | "memory" | "experimental";

export interface SettingsTabDef {
  id: SettingsTab;
  icon: IconName;
}

export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: "general", icon: "sliders" },
  // 新手引导：全屏引导的唯一常驻入口（2026-11-07 用户：「应该在设置里有个独立的 tab」）
  { id: "guide", icon: FEATURE_ICON.guide },
  { id: "providers", icon: "cpu" },
  { id: "migration", icon: "download" },
  { id: "browser", icon: FEATURE_ICON.browser },
  { id: "voice", icon: "mic" },
  // 手机：配对码、已配对设备、监听开关（2026-11-25，手机端「看与回」第一刀）
  { id: "mobile", icon: FEATURE_ICON.mobile },
  // 插件页的全屏版（右栏图标条的积木图标开的是右栏单列版，两处是同一个组件）
  { id: "plugins", icon: FEATURE_ICON.plugins },
  // 记忆库（原右侧图标条的入口，2026-11-06 挪进设置）
  { id: "memory", icon: FEATURE_ICON.memory },
  { id: "experimental", icon: "flask-conical" },
];
