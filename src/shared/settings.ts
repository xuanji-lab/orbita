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
 * 自动压缩偏好（A-1）。**剩余百分制**：pi 在「上下文用量 > 窗口 − reserveTokens」
 * 时触发折叠，reserveTokens = contextWindow × reservePercent / 100——不同模型的
 * 窗口差 10 倍，百分比换个模型不失义。pi 出厂的绝对阈值（window − 16384）对
 * ≤16k 窗口的模型是非正数（第一轮聊完就压、保留量又大于整个窗口），百分制顺手
 * 修掉这个退化。换算与钳制在 src/agent（runtime 开轮时按本轮模型的窗口算）。
 *
 * - `enabled: false` = 关闭自动压缩，只认手动 `/compact`（手动压缩不走阈值，不受影响）。
 * - 保留量（pi 的 keepRecentTokens）**不暴露**：它与 reservePercent 耦合（两个旋钮
 *   互相牵制），内部按窗口钳制——min(2 万, 窗口的 25%)。
 */
export interface CompactionSetting {
  /** 触发阈值 = 剩余窗口的百分比；合法区间 [5, 50] 的数，坏值回 20 */
  reservePercent: number;
  /** 自动压缩开关；关闭后只认手动 `/compact` */
  enabled: boolean;
}

export const COMPACTION_DEFAULT: CompactionSetting = { reservePercent: 20, enabled: true };

/** reservePercent 的合法区间（解析钳制与设置面选项共用同一对数字）。 */
export const COMPACTION_PERCENT = { min: 5, max: 50 } as const;

export interface AppSettings {
  theme: ThemePreference;
  /**
   * 右侧分屏面板的宽度（4-0 拖宽）。缺席 = 默认 320；合法区间 280–560，
   * 越界或非数丢掉——这个文件用户手改得到，一个坏值不该把面板拖成一条线。
   * 拖动中不落盘，松手才写（避免写风暴）。
   */
  rightPanelWidth?: number;
  /**
   * 自动压缩偏好（A-1）。缺席 = COMPACTION_DEFAULT（主进程装配开轮命令时兜底）。
   * 改动**下一轮对话即生效**：pi 的压缩判定每次现读设置，runtime 每轮重新覆盖。
   */
  compaction?: CompactionSetting;
}

export const DEFAULT_SETTINGS: AppSettings = { theme: "system" };

/** 右侧面板宽度的合法区间与默认值（与拖拽热区的夹取同源）。 */
export const RIGHT_PANEL_WIDTH_MIN = 280;
export const RIGHT_PANEL_WIDTH_MAX = 560;
export const RIGHT_PANEL_WIDTH_DEFAULT = 320;

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
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
  const theme = (raw as { theme?: unknown }).theme;
  const width = (raw as { rightPanelWidth?: unknown }).rightPanelWidth;
  const compaction = parseCompaction((raw as { compaction?: unknown }).compaction);
  return {
    theme: isThemePreference(theme) ? theme : DEFAULT_SETTINGS.theme,
    ...(typeof width === "number" &&
    Number.isFinite(width) &&
    width >= RIGHT_PANEL_WIDTH_MIN &&
    width <= RIGHT_PANEL_WIDTH_MAX
      ? { rightPanelWidth: Math.round(width) }
      : {}),
    ...(compaction === undefined ? {} : { compaction }),
  };
}

/**
 * 压缩偏好逐字段校验：百分比只在区间内才认，enabled 非布尔回 true——
 * 手改出一个 `reservePercent: 200` 等于「上限的 2 倍才开始留余量」，比坏主题更危险。
 * 整段缺席 = 用户从没动过它（返回 undefined，消费侧兜 COMPACTION_DEFAULT）。
 */
function parseCompaction(raw: unknown): CompactionSetting | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const percent = (raw as { reservePercent?: unknown }).reservePercent;
  const enabled = (raw as { enabled?: unknown }).enabled;
  return {
    reservePercent:
      typeof percent === "number" && Number.isFinite(percent) && percent >= COMPACTION_PERCENT.min && percent <= COMPACTION_PERCENT.max
        ? percent
        : COMPACTION_DEFAULT.reservePercent,
    enabled: enabled === false ? false : true,
  };
}
