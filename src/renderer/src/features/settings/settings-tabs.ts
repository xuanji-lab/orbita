/**
 * 设置页的页签清单，以及「哪些页签此刻该出现」的判定。
 *
 * 单独成 .ts 只为可测（`node --test` 只加载 .ts，SettingsView.tsx 带 JSX）。
 * 页签可以挂在某个实验功能后面（`flag`）：开关关着时页签不出现，停在它上面的人退回「通用」——
 * 与记忆库 / 插件页「开关关掉就退回聊天」同一条纪律，只藏入口不动数据。
 */
import type { ExperimentalFeatureId } from "@shared/settings";
import type { IconName } from "../../shell/Icon";

export type SettingsTab = "general" | "providers" | "migration" | "browser" | "voice" | "plugins" | "experimental";

export interface SettingsTabDef {
  id: SettingsTab;
  icon: IconName;
  /** 挂在哪个实验功能后面；缺席 = 常驻 */
  flag?: ExperimentalFeatureId;
}

export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: "general", icon: "sliders" },
  { id: "providers", icon: "cpu" },
  { id: "migration", icon: "download" },
  { id: "browser", icon: "globe" },
  { id: "voice", icon: "mic" },
  // 插件页的全屏版（右栏图标条的积木图标开的是右栏单列版，两处是同一个组件）
  { id: "plugins", icon: "blocks", flag: "plugins" },
  { id: "experimental", icon: "flask-conical" },
];

type Flags = Readonly<Partial<Record<ExperimentalFeatureId, boolean>>>;

/** 此刻该列出的页签（挂了实验开关的，开关开着才在） */
export function visibleSettingsTabs(flags: Flags): SettingsTabDef[] {
  return SETTINGS_TABS.filter((tab) => tab.flag === undefined || flags[tab.flag] === true);
}

/** 停着的页签若已不该出现（开关被关掉），退回「通用」 */
export function resolveSettingsTab(tab: SettingsTab, flags: Flags): SettingsTab {
  return visibleSettingsTabs(flags).some((visible) => visible.id === tab) ? tab : "general";
}
