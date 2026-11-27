/**
 * 顶部工具栏的几何（2026-10-19 方案 B v2：Safari 式整条工具栏 + 全胶囊）。
 *
 * 窗口最顶一整条 52 的工具栏（`.toolbar`，整条 `.titlebar` 拖拽区）横跨整宽、在卡片外；
 * 里面只有胶囊（`.toolbar-capsule`，共 32 高），**所有胶囊的中心 y 钉在 darwin 红绿灯
 * 中心那条线上**（trafficLightPosition y=19 + 6px 键径 = 25；红绿灯位置不动，2026-10-18
 * 用户裁决「移不了红绿灯，把我们的顶栏对齐它」）。侧栏、对话卡、右栏、右图标条都从
 * 52 下面开始。
 *
 * 这里的纯函数只管**水平**几何（左胶囊 x、会话胶囊的居中与收缩、对话列左右缘）；
 * 垂直只留一条推导（胶囊上沿 = 中心线 − 胶囊高/2 = 9），与 tokens/spacing.css 的
 * `--titlebar-capsule-top` 互为对账。**侧栏开关在展开 / 收起两态坐标不变**由结构保证：
 * 它始终住在工具栏左胶囊的第一个格，开合不换容器（旧版「两条链对账」随之删除）。
 */

import { PAPER_CHAT_WIDTH } from "../features/files/paper-layout.ts";

export type ToolbarPlatform = "darwin" | "other";

/** 主进程 `trafficLightPosition`（红绿灯不动；测试与这里对账） */
export const TRAFFIC_LIGHT_X = 18;
export const TRAFFIC_LIGHT_Y = 19;
/** macOS 红绿灯键径（Big Sur 起标准尺寸） */
export const TRAFFIC_LIGHT_DOT = 12;
/** 三键并排总宽（close · min · zoom 各 12，间距 8）：x 18 → 70 */
export const TRAFFIC_LIGHT_GROUP_W = 52;

/** 红绿灯中心线：所有胶囊的中心 y */
export const CENTER_Y = TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_DOT / 2;

/** `.layer` 的 padding（`--space-3`）：卡片与窗口边的留白 */
export const LAYER_PAD = 12;
/** 右图标条宽（2026-11-22 由 32 + 两侧各 12 的空隙收窄）：图标 28 + 左右各 --space-2 = 44，与 --rail-w 对账 */
export const RAIL_W = 44;
/** 图标条右缘到窗口边（--rail-end = --space-1） */
export const RAIL_END = 4;
/** 工具栏右端「辅助对话」开关胶囊：28 的圆格 + 左右各 2 的胶囊内边距，居中在图标条里 */
export const TOGGLE_CAP_W = 32;
/** 窗口窄于这条线自动收起侧栏（960 以下 288px 侧栏会把内容面挤得太瘦） */
export const COLLAPSE_BREAKPOINT = 960;

/** 左胶囊与红绿灯右缘的间距（2026-10-19 验收：隔 10 太贴，改 18——红绿灯右缘 x=70，左胶囊 x=88） */
export const LIGHTS_GAP = 18;

/** 左胶囊左缘 x：darwin = 红绿灯右缘 + 18（88）；其它平台（无红绿灯）从窗口内边距起（12） */
export function leftCapsuleX(platform: ToolbarPlatform): number {
  return platform === "darwin" ? TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_GROUP_W + LIGHTS_GAP : LAYER_PAD;
}

/** 左胶囊宽度：2px 内边距 + 侧栏开关 36 + 新任务 36 + 专注 36（计时态由专注功能自己加宽） */
export const LEFT_CAPSULE_W = 2 + 36 + 36 + 36 + 2;

/** 会话胶囊：宽度上限 / 与右栏胶囊（右限）的最小间距 */
export const SESSION_W = 480;
export const SESSION_GAP = 12;

/** 右栏胶囊：筛选框收成搜索格的断点 / 右栏最小宽（默认值，可推翻） */
export const PANEL_FILTER_BREAK = 300;
export const PANEL_MIN_W = 260;

/**
 * 右栏胶囊相对右栏的分隔线 / 右缘各内缩多少（2026-10-19 验收：胶囊贴着分隔线
 * 「顶到了」）：取右栏卡片内容的行内边距那一档（.panel-list 的 --space-2 = 8），
 * 胶囊左缘与右栏**内容**左缘（文件树文字起点）对齐，宽度仍随右栏拖动。
 */
export const PANEL_CAPSULE_INSET = 8;

/**
 * 对话列（会话胶囊靠它的左缘排，右栏胶囊靠它的右缘排）：左缘 = 侧栏右侧（收起 = 卡片内边距），
 * 右缘 = 右栏分隔线（右栏没开 = 卡片右缘）。
 */
export function conversationColumn(input: {
  windowWidth: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
}): { left: number; right: number } {
  const left = input.sidebarCollapsed ? LAYER_PAD : LAYER_PAD + input.sidebarWidth + LAYER_PAD;
  const paneRight = input.windowWidth - RAIL_W - RAIL_END;
  return { left, right: paneRight - (input.panelOpen ? input.panelWidth : 0) };
}

/** 「辅助对话」开关胶囊的左缘：居中在图标条里（条左缘 = 井右缘） */
export function toggleCapsuleLeft(windowWidth: number): number {
  return windowWidth - RAIL_W - RAIL_END + (RAIL_W - TOGGLE_CAP_W) / 2;
}

/**
 * 右端边界：会话胶囊右缘能探到的最右处 = 右栏胶囊左缘（右栏开着 = 分隔线）或
 * 右栏开关胶囊左缘（没开）。
 *
 * Windows / Linux 的窗口三键住在品牌行（最上面那一行），不在胶囊行——胶囊行
 * 不再为它们左让（2026-10-23 实测：旧算法减 126px，1000 宽时胶囊被截到 372）。
 */
export function rightEdge(input: {
  windowWidth: number;
  panelOpen: boolean;
  panelWidth: number;
}): number {
  const paneRight = input.windowWidth - RAIL_W - RAIL_END;
  if (input.panelOpen) return paneRight - input.panelWidth;
  return toggleCapsuleLeft(input.windowWidth);
}

/**
 * 布局 B（稿件为主）的横向分区：稿件工作台占左、对话栏占右。
 *
 * 布局 B 里 `.pane` 是 row-reverse（CSS 里把对话卡摆到右边），这里算的是**视觉**位置，
 * 给工具栏的三颗胶囊用：会话胶囊按左对齐排在工作台上，右侧 340 一栏顶上是「对话」胶囊。
 * 侧栏在 B 里自动收起，但用户手动展开放宽也照常算——工作台从侧栏右缘起。
 */
export function paperColumns(input: {
  windowWidth: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}): { workbench: { left: number; right: number }; chat: { left: number; right: number } } {
  // 对话栏贴 pane 右缘（不按面板宽算：B 里没有「右栏」这回事）
  const column = conversationColumn({
    windowWidth: input.windowWidth,
    sidebarCollapsed: input.sidebarCollapsed,
    sidebarWidth: input.sidebarWidth,
    panelOpen: false,
    panelWidth: 0,
  });
  const chatLeft = Math.max(column.left, column.right - PAPER_CHAT_WIDTH);
  return { workbench: { left: column.left, right: chatLeft }, chat: { left: chatLeft, right: column.right } };
}

/**
 * 会话胶囊几何（2026-11-22 改左对齐，用户：「右侧面板……顶部名字都是居左的，我们的名字也可以居左」）：
 * 标题与右栏面板标题同一条规矩——左缘 = 对话列左缘 + `PANEL_CAPSULE_INSET`（右栏胶囊 = 分隔线 + 同一个
 * 内缩）。左侧栏收起时对话列贴着窗口边，左缘退到左胶囊（侧栏开关 · 新任务 · 专注）的右缘：
 * 标题就紧跟在专注键右侧。宽度到右限（让开右栏胶囊 / 右栏开关，各留 `SESSION_GAP`）为止，封顶
 * `SESSION_W`；放不下就能拿多少拿多少，再窄由标题省略号兜底（不换行不溢出）。
 */
export function sessionCapsule(input: {
  colLeft: number;
  leftCapRight: number;
  rightLimit: number;
}): { x: number; width: number } {
  const x = Math.max(input.colLeft + PANEL_CAPSULE_INSET, input.leftCapRight);
  const width = Math.max(0, Math.min(SESSION_W, input.rightLimit - SESSION_GAP - x));
  return { x, width };
}
