/**
 * 面板打开次数 —— IPC 四层契约的第 1 层（2026-10-30 起；右栏现在只有一种布局，统计留着看哪些入口值得常驻）。
 *
 * 用户 2026-10-30：审查、上下文、文件、归档、遗留、记忆面板、通知「在 agent / 多 agent
 * 时代都很少用，是保底功能，但又极繁」——先把它们收进「更多」，同时在本机记下每个面板
 * 实际被打开了几次，一周后看数据决定删什么。所以这里只记**用户自己打开**的次数：
 * 切会话时右栏恢复成那条会话记着的面板不算。
 *
 * 数据只在本机：`<userData>/panel-usage.json`，原子写，不上传、不进遥测。文件坏了 / 不在
 * 就从现在重新数（since 记着从哪天开始数，设置页把它写在统计前面）。
 *
 *   panel-usage:get   renderer 拉当前计数（设置 › 实验功能的只读统计）
 *   panel-usage:bump  某个面板被打开一次（renderer 在打开的那一拍发）
 */

/** 计数的面板。顺序 = 设置页同票数时的展示顺序（常驻的在前） */
export const PANEL_USAGE_KEYS = [
  /** 这条任务（进度页签） */
  "task",
  /** 这条任务 › 上下文页签 */
  "context",
  "terminal",
  /** 内置浏览器（独立窗口，不占右栏） */
  "browser",
  /** 文件面板（文件树 / 预览） */
  "files",
  "review",
  /** 能力：Skills 与 MCP */
  "abilities",
  /** 记忆库（设置里的页签） */
  "memory",
  "intent",
  /** 遗留事项（侧栏子视图） */
  "carryovers",
  /** 已归档（侧栏子视图） */
  "archived",
  /** 通知清单（右栏「更多」里的通知） */
  "bell",
  /** 插件（右栏单列版） */
  "plugins",
  "automation",
  /** 全局周看板（整页盖层） */
  "board",
  "settings",
  "subsessions",
  /** 辅助对话（右栏里的另一条会话） */
  "sidechat",
] as const;

export type PanelUsageKey = (typeof PANEL_USAGE_KEYS)[number];

export interface PanelUsageSnapshot {
  /** 从什么时候开始数（epoch ms）：第一次记账、或文件坏了重新开始的那一刻 */
  since: number;
  /** 每个面板被打开的次数；没打开过的键缺席（= 0） */
  counts: Partial<Record<PanelUsageKey, number>>;
}

export const panelUsageChannels = {
  get: "panel-usage:get",
  bump: "panel-usage:bump",
} as const;

const KEY_SET: ReadonlySet<string> = new Set(PANEL_USAGE_KEYS);

export function isPanelUsageKey(value: unknown): value is PanelUsageKey {
  return typeof value === "string" && KEY_SET.has(value);
}

/**
 * 读盘解析（文件内容当不可信数据）：since 不是正数、counts 不是对象就从 now 重新数；
 * 认不出的键丢掉、不是非负整数的计数丢掉。
 */
export function parsePanelUsage(raw: unknown, now: number): PanelUsageSnapshot {
  if (typeof raw !== "object" || raw === null) return { since: now, counts: {} };
  const record = raw as { since?: unknown; counts?: unknown };
  if (typeof record.since !== "number" || !Number.isFinite(record.since) || record.since <= 0) {
    return { since: now, counts: {} };
  }
  const counts: Partial<Record<PanelUsageKey, number>> = {};
  if (typeof record.counts === "object" && record.counts !== null) {
    for (const [key, value] of Object.entries(record.counts)) {
      if (isPanelUsageKey(key) && typeof value === "number" && Number.isInteger(value) && value > 0) {
        counts[key] = value;
      }
    }
  }
  return { since: record.since, counts };
}

/** 记一次打开（不改入参） */
export function bumpPanelUsage(snapshot: PanelUsageSnapshot, key: PanelUsageKey): PanelUsageSnapshot {
  return { since: snapshot.since, counts: { ...snapshot.counts, [key]: (snapshot.counts[key] ?? 0) + 1 } };
}

/**
 * 设置页的一行统计：全部面板都列（**0 次也列**——想删的正是它们），次数多的在前，
 * 同票按 PANEL_USAGE_KEYS 的顺序。
 */
export function panelUsageRows(snapshot: PanelUsageSnapshot): { key: PanelUsageKey; count: number }[] {
  return PANEL_USAGE_KEYS.map((key, order) => ({ key, count: snapshot.counts[key] ?? 0, order }))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ key, count }) => ({ key, count }));
}
