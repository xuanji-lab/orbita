/**
 * 应用设置契约 —— IPC 四层的第 1 层。
 *
 * 范围刻意只有主题一项。设置面从极少的 tab 起步、但 UI 第一天就落（guideline §六）；
 * 字段等有真实消费者再加，不提前占位。
 */

/**
 * 主题偏好。**四态**——"system" 是真正的默认，不是「light 的别名」：
 * 用户没表态时应用要跟着系统深浅走。system 的深色落点是 **"black"**（Ink，
 * 2026-09-03 用户指定）；"dark"（Warm）与 "black" 从此都是手动档。
 */
export const THEME_PREFERENCES = ["system", "light", "dark", "black"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * 右抽屉的记忆（2026-09-11 裁决：记住上次，而不是每次启动都收回）。
 * - `open`：抽屉开关。首次启动无记录时默认收起（设计系统 closed by default 按「初次默认」解释）。
 * - `width`：抽屉宽度，px。钳制与重置在渲染层（drawer-prefs.ts），这里只存干净值。
 * - `docked`：抽屉标签条里开着的 task id，按标签顺序。启动时逐条恢复，
 *   已删除的会话静默丢弃——不弹错、不占位。
 */
export interface DrawerSettings {
  open: boolean;
  width: number;
  docked: string[];
}

export interface AppSettings {
  theme: ThemePreference;
  /**
   * 右侧分屏面板的宽度（4-0 拖宽）。缺席 = 默认 320；合法区间 280–560，
   * 越界或非数丢掉——这个文件用户手改得到，一个坏值不该把面板拖成一条线。
   * 拖动中不落盘，松手才写（避免写风暴）。
   */
  rightPanelWidth?: number;
  drawer: DrawerSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  drawer: { open: false, width: 320, docked: [] },
};

/** 抽屉宽度的合法区间（与渲染层拖拽钳制同一对数字）。 */
export const DRAWER_WIDTH = { min: 280, max: 560, default: 320 } as const;

/** 右侧面板宽度的合法区间与默认值（与拖拽热区的夹取同源）。 */
export const RIGHT_PANEL_WIDTH_MIN = 280;
export const RIGHT_PANEL_WIDTH_MAX = 560;
export const RIGHT_PANEL_WIDTH_DEFAULT = 320;

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
}

/** 只在区间内才认；钳制交给渲染层，这里不「猜」用户想要的宽度 */
function parseWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DRAWER_WIDTH.default;
  if (value < DRAWER_WIDTH.min || value > DRAWER_WIDTH.max) return DRAWER_WIDTH.default;
  return Math.round(value);
}

/**
 * 从磁盘上的任意 JSON 解出设置。
 *
 * **只认识的字段留下，别的一律丢掉**，坏值退回默认。理由是这个文件在用户目录里、
 * 手改得到：一个打错的主题名不该让应用起不来，也不该把 `theme` 变成一段任意字符串
 * 流进渲染层的 `data-theme`。
 */
export function parseSettings(raw: unknown): AppSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const record = raw as { theme?: unknown; drawer?: unknown; rightPanelWidth?: unknown };
  const theme = isThemePreference(record.theme) ? record.theme : DEFAULT_SETTINGS.theme;
  const width = record.rightPanelWidth;
  return {
    theme,
    ...(typeof width === "number" &&
    Number.isFinite(width) &&
    width >= RIGHT_PANEL_WIDTH_MIN &&
    width <= RIGHT_PANEL_WIDTH_MAX
      ? { rightPanelWidth: Math.round(width) }
      : {}),
    drawer: parseDrawer(record.drawer),
  };
}

function parseDrawer(raw: unknown): DrawerSettings {
  const fallback = DEFAULT_SETTINGS.drawer;
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as { open?: unknown; width?: unknown; docked?: unknown };
  return {
    open: typeof record.open === "boolean" ? record.open : fallback.open,
    width: parseWidth(record.width),
    docked: Array.isArray(record.docked)
      ? record.docked.filter((id): id is string => typeof id === "string")
      : fallback.docked,
  };
}
