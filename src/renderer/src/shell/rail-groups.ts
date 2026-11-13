/**
 * 右栏入口的分组与排布（RightRail 的纯逻辑部分，拆出来为了能不起 React 就测）。
 *
 * 分法按「这类入口回答什么问题」，不按「它是面板还是视图」：
 * - session   这条会话在做什么、做了什么、东西在哪：这条任务、审查、文件、子会话
 * - agent     智能体的能力：终端、内置浏览器、技能与 MCP / 插件、意图、自动化
 * - shelf     收起来以后再看的：以后再做、归档、通知（只有一种布局：这组全在「更多」菜单里）
 * - app       应用级入口：看板、设置（右下角，只有这一组在下面）
 *
 * 只有一种布局：前两组常驻右上、组间一条细线；其后一条细线 + 「更多」⋮，`inMore` 的入口
 * 收在菜单里；`app` 钉右下。
 */

export const RAIL_GROUP_IDS = ["session", "agent", "shelf", "app"] as const;
export type RailGroupId = (typeof RAIL_GROUP_IDS)[number];

/** 排布只关心入口属于哪组、在条上还是在「更多」里；图标、文案、点法由 RightRail 附在同一个对象上 */
export interface RailPlacement {
  group: RailGroupId;
  /** 收进「更多」菜单；缺席 = 常驻在条上 */
  inMore?: boolean;
}

export interface RailGroupItems<T> {
  group: RailGroupId;
  items: T[];
}

export interface RailLayout<T> {
  /** 右上：条上的 session / agent / shelf 入口，空组不出现；组与组之间画一条细线 */
  stack: RailGroupItems<T>[];
  /** 右下：`app` 组 */
  dock: T[];
  /** 「更多」菜单的内容，按组序、空组不出现 */
  more: RailGroupItems<T>[];
}

/** 把入口清单（组内顺序即数组顺序）排成右栏 */
export function layoutRail<T extends RailPlacement>(items: readonly T[]): RailLayout<T> {
  const onRail = (item: T): boolean => item.inMore !== true;
  const collect = (keep: (item: T) => boolean, groups: readonly RailGroupId[]): RailGroupItems<T>[] =>
    groups
      .map((group) => ({ group, items: items.filter((item) => item.group === group && keep(item)) }))
      .filter((entry) => entry.items.length > 0);
  const upper = RAIL_GROUP_IDS.filter((group) => group !== "app");
  return {
    stack: collect(onRail, upper),
    dock: items.filter((item) => item.group === "app" && onRail(item)),
    more: collect((item) => !onRail(item), RAIL_GROUP_IDS),
  };
}

/** 把分好组的清单拍平成一列，组与组之间插一个由 `rule` 造出的分隔项（给 Menu 的 `rule` 项用） */
export function withGroupRules<T, R>(groups: readonly RailGroupItems<T>[], rule: (before: RailGroupId) => R): (T | R)[] {
  return groups.flatMap((entry, index) => (index === 0 ? entry.items : [rule(entry.group), ...entry.items]));
}
