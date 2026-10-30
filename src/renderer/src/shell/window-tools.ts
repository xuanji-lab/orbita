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
/** 右图标条宽 */
export const RAIL_W = 32;
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

/** 会话胶囊（排法甲 · 地址栏式）：首选宽 / 对称收缩的最小宽 / 两侧最小间距 */
export const SESSION_W = 480;
export const SESSION_MIN = 280;
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
 * 对话列（会话胶囊的居中基准 = 这一列）：左缘 = 侧栏右侧（收起 = 卡片内边距），
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
  const paneRight = input.windowWidth - LAYER_PAD - RAIL_W - LAYER_PAD;
  return { left, right: paneRight - (input.panelOpen ? input.panelWidth : 0) };
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
  platform: ToolbarPlatform;
  panelOpen: boolean;
  panelWidth: number;
}): number {
  const paneRight = input.windowWidth - LAYER_PAD - RAIL_W - LAYER_PAD;
  if (input.panelOpen) return paneRight - input.panelWidth;
  return input.windowWidth - LAYER_PAD - RAIL_W;
}

/**
 * 会话胶囊几何（排法甲，2026-10-19 验收修正）：**优先居中于对话列**——以对话列
 * 中心为中心、两侧都不越界（各留 `SESSION_GAP`）的前提下取最大宽度（首选 480，
 * 对称收缩）；对称可用宽低于 `SESSION_MIN` 才退而贴左（左缘钉下限、宽度取可用宽，
 * 再窄标题省略号兜底，不换行不溢出）。
 */
export function sessionCapsule(input: {
  windowWidth: number;
  colLeft: number;
  colRight: number;
  leftCapRight: number;
  rightLimit: number;
}): { x: number; width: number } {
  const lo = input.leftCapRight + SESSION_GAP;
  const hi = input.rightLimit - SESSION_GAP;
  const center = (input.colLeft + input.colRight) / 2;
  // 对称可用：中心到两侧上限里较短那段 × 2
  const symmetric = 2 * Math.min(center - lo, hi - center);
  if (symmetric >= SESSION_MIN) {
    const width = Math.min(SESSION_W, symmetric);
    return { x: Math.round(center - width / 2), width: Math.round(width) };
  }
  // 对称凑不到最小宽：贴左，能拿多少拿多少
  const width = Math.max(0, Math.min(SESSION_MIN, hi - lo));
  return { x: lo, width };
}
