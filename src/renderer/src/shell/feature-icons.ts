/**
 * 功能图标的单一来源：每个用户看得见的功能只有一枚图标。
 *
 * 右栏入口（RightRail 的 items / App 的 railEntries）、面板头与页签、空态、
 * 聊天里的卡片与行、设置页签、实验功能清单……凡是代表「这个功能」的图标，
 * 一律 `FEATURE_ICON.xxx` 取，不写图标名字面量。
 *
 * **换某功能的图标只改这张表**（新形状先在 Icon.tsx 登记 SVG 再改这里的值）；
 * `feature-icons.test.ts` 会拦下渲染层里新出现的字面量（撞通用义的少数名字有放行档，见该测试）。
 *
 * 键名跟功能走，不跟右栏条目的 id 走：task=这条任务（右栏 id 是 context）、
 * carryovers=以后再做、abilities=技能与 MCP。加新功能先在这里登记一行，再在表面里引用。
 */
import type { IconName } from "./Icon.tsx";

export const FEATURE_ICON = {
  /** 这条任务：右栏面板、面板里的「进度」页签、聊天里的计划卡 */
  task: "clipboard-list",
  /** 以后再做（遗留事项）：侧栏子视图、收尾扫描卡、收工卡 */
  carryovers: "hourglass",
  /** 记忆库：右栏入口、「用到 N 条记忆」chip、审查面板的记忆页签与空态 */
  memory: "notebook-text",
  /** 自动化：面板标题与空态、聊天里建自动化的卡与唤醒行、周看板的排定运行 */
  automation: "alarm-clock",
  /** 插件：右栏入口、设置页签、插件页头、安装行 */
  plugins: "blocks",
  /** 看板（全局周看板） */
  board: "layout-dashboard",
  /** 技能与 MCP（插件页把它们当插件显示，入口图标与「插件」不同） */
  abilities: "book-open",
  /** 审查改动 */
  review: "file-diff",
  /** 文件面板（注意 folder 同时是「目录」的通用图标，通用处不走表） */
  files: "folder",
  /** 终端 */
  terminal: "square-terminal",
  /** 内置浏览器（globe 同时是「网页/全局」的通用图标，通用处不走表） */
  browser: "globe",
  /** 子会话：面板头与空态、会话行的子会话角标、行状态、迁移视图 */
  subsessions: "git-fork",
  /** 意图：面板头与空态、输入框旁的意图开关、召回卡 */
  intent: "waypoints",
  /** 已归档（archive 同时是「归档状态」的通用图标） */
  archived: "archive",
  /** 设置 */
  settings: "settings",
  /** 通知（右栏铃铛与通知卡空态） */
  bell: "bell",
} as const satisfies Record<string, IconName>;
