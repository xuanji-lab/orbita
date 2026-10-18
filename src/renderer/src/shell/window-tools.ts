/**
 * 「窗口工具」组（红绿灯净空 · 侧栏开关 · 新任务）的水平几何，与侧栏收起断点。
 *
 * 这一组在两种状态下住两个不同的容器：
 *  - **展开态**：侧栏顶行（aside 的 `.titlebar`）——组左缘距窗口左缘 =
 *      `.layer` 的 padding-inline（`--space-3`）
 *    + 侧栏 aside 自己的 padding-inline-start（`--space-3`）
 *    + `.titlebar` 的红绿灯净空（darwin 66px，其它平台 0）
 *  - **收起态**：对话卡页头（ChatView 的 Pane 页头 / SettingsView 的页头；收起后
 *    没有左侧图标条，pane 铺到最左）——组左缘 =
 *      `.layer` 的 `--space-3` + 页头的 padding-inline-start（`--window-tools-inset`）
 *
 * 两条链必须得出**同一个数**——侧栏开关的屏幕 x 不随开合跳动，这是 2026-10-18
 * 用户裁决的核心原则（「开关不再跳来跳去」）。收起态的 `--window-tools-inset`
 * 因此在 styles.css 里定义为 `var(--space-3) + 红绿灯净空`，与这里的 px 常量
 * 互为对账：`window-tools.test.ts` 同时读 CSS 与 Sidebar 源码，验证链上每一环
 * 没有各自漂移。
 */

/** 窗口窄于这条线自动收起侧栏：288px 的侧栏在 960 以下会把内容面挤得太瘦 */
export const COLLAPSE_BREAKPOINT = 960;

/** `.layer` 的 padding（tokens/spacing.css 的 `--space-3`）。展开 / 收起两态共用这一层 */
export const LAYER_PAD = 12;

/** 侧栏 aside 的 padding-inline-start（Sidebar 的 `var(--space-3)`） */
export const SIDEBAR_PAD = 12;

/**
 * darwin 红绿灯净空（styles.css 的 `--traffic-clearance`）：红绿灯由主进程
 * `trafficLightPosition: { x: 18 }` 定位、三键约 52px 宽，`.titlebar` 由此让出 66px。
 */
export const DARWIN_CLEARANCE = 66;

/**
 * 红绿灯垂直几何（主进程 src/main/index.ts 的 `trafficLightPosition.y`）。
 * 位置**不动**（2026-10-18 用户裁决：移不了红绿灯，把我们的顶栏收窄去对齐它——
 * 「顶部栏有点太宽了，可以窄一些，和红绿灯横线居中对齐」）。
 */
export const TRAFFIC_LIGHT_Y = 19;
/** macOS 红绿灯键径（Big Sur 起的标准尺寸） */
export const TRAFFIC_LIGHT_DOT = 12;

/**
 * 顶部行行高（styles.css 的 `--titlebar-row`，侧栏字标行 / 对话卡页头 / 设置页头 /
 * 右栏页头 / 右图标条顶行共用）：**行的垂直中心钉在红绿灯中心那条线上**。
 * 行顶 = 卡顶（.layer 的 --space-3 = LAYER_PAD），红绿灯中心 = TRAFFIC_LIGHT_Y +
 * 键径/2 = 25px，所以行高 = 2 × (25 − 12) = 26。Windows 没有红绿灯，用同一条
 * 中心线保持跨平台一致的较窄顶栏。按钮不缩到点不准：行里的方块用 24px
 * （IconButton/RailButton 现有档位），上下各留 1px。
 */
export const TITLEBAR_ROW_HEIGHT = 2 * (TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_DOT / 2 - LAYER_PAD);

/** 平台只分「有红绿灯」与「没有」——工具组的几何只受这一件事影响 */
export type WindowToolsPlatform = "darwin" | "other";

export function clearanceOf(platform: WindowToolsPlatform): number {
  return platform === "darwin" ? DARWIN_CLEARANCE : 0;
}

/** 展开态：组（侧栏开关）左缘距窗口左缘多少 px */
export function expandedToolsX(platform: WindowToolsPlatform): number {
  return LAYER_PAD + SIDEBAR_PAD + clearanceOf(platform);
}

/**
 * 收起态页头的 padding-inline-start（px）。pane 的左缘已经带着 `.layer` 的那层
 * `--space-3`，这里只补侧栏自己那层与红绿灯净空——两条链由此落在同一个 x 上。
 */
export function collapsedHeaderInset(platform: WindowToolsPlatform): number {
  return expandedToolsX(platform) - LAYER_PAD;
}
