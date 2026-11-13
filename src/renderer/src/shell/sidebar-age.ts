/**
 * 左栏「时间范围」筛选的纯函数（Sidebar 唯一消费者）。
 *
 * 口径：只看最后活动（updatedAt）落在最近 N×24 小时内的会话——滚动窗口，不按日历日。
 * 与行尾标签（`sessionAgeLabel`，昨天 = 隔一个日历日）不完全同界：昨晚的会话早上看
 * 写「昨天」且在「最近 1 天」里，30 小时前的也写「昨天」却已出了「最近 1 天」。
 * 窗口按「过去 24 小时」理解更符合「最近一天」的直觉，标签按日历日理解更符合
 * 「昨天」的直觉，两边各取自然口径，不为对齐而牺牲任何一边。
 */
import { SIDEBAR_AGE_CHOICES, type SidebarAgeDays } from "../../../shared/settings.ts";
import { DAY_MS } from "./relative-time.ts";

/** 这条会话是否在最近 days 天内活动过。days = null：不限，恒真 */
export function withinAge(updatedAt: number, now: number, days: SidebarAgeDays | null): boolean {
  if (days === null) return true;
  return now - updatedAt <= days * DAY_MS;
}

/**
 * 过滤时间范围：窗口内的留下；**正在看的那条即使出了窗口也留着**（同 visibleWithOpen 的思路——
 * 不然用户一选范围，眼前这条会话的高亮行就消失了，看不出自己在哪）。
 * days = null 原样返回（不复制）。顺序不变。
 */
export function filterByAge<T extends { id: string; updatedAt: number }>(
  sessions: readonly T[],
  now: number,
  days: SidebarAgeDays | null,
  openId: string | null,
): readonly T[] {
  if (days === null) return sessions;
  return sessions.filter((m) => m.id === openId || withinAge(m.updatedAt, now, days));
}

export type AgeCounts = Record<SidebarAgeDays, number> & { any: number };

/**
 * 下拉里每一档后面写的命中条数。传进来的应是**已过其它筛选（已完成 / 星标 / 灯泡）**的会话：
 * 数字回答的是「选这一档我会看到几条」。「不限」= 全部。
 * 这里不给「正在看的那条」特赦：它是列表层的留行，不是这一档的命中。
 */
export function ageCounts(sessions: readonly { updatedAt: number }[], now: number): AgeCounts {
  const counts: AgeCounts = { 1: 0, 3: 0, 5: 0, 7: 0, any: sessions.length };
  for (const m of sessions) {
    for (const days of SIDEBAR_AGE_CHOICES) {
      if (withinAge(m.updatedAt, now, days)) counts[days] += 1;
    }
  }
  return counts;
}
