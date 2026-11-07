/**
 * 右栏入口的分组与排布（RightRail 的纯逻辑部分，拆出来为了能不起 React 就测）。
 *
 * 分法按「这类入口回答什么问题」，不按「它是面板还是视图」：
 * - session   这条会话在做什么、做了什么：这条任务、审查、子会话
 * - workbench 东西在哪、在哪动手：文件、终端、内置浏览器
 * - agent     智能体会什么、记得什么：能力、记忆、意图
 * - shelf     收起来以后再看的：以后再做、归档
 * - app       跟哪条会话都无关的应用级入口：设置、通知（右下角，只有这一组在下面）
 *
 * 常规态：前四组堆在右上、组间一条细线，`app` 钉右下。精简态（实验功能 lean-rail）：
 * 条上只留 `pinned` 的入口，其余进「更多」菜单——菜单按同一套组序排、组间一条分隔线，
 * 所以同一个入口在两种态下排位一致，只是在条上还是在菜单里。
 */

export const RAIL_GROUP_IDS = ["session", "workbench", "agent", "shelf", "app"] as const;
export type RailGroupId = (typeof RAIL_GROUP_IDS)[number];

/** 排布只关心入口属于哪组、精简态放哪；图标、文案、点法由 RightRail 附在同一个对象上 */
export interface RailPlacement {
  group: RailGroupId;
  /** 精简态常驻在条上；否则收进「更多」 */
  pinned: boolean;
  /** 只在精简态的「更多」里有（如「上下文」直达页签）；常规态条上没有这一项 */
  moreOnly?: boolean;
}

export interface RailGroupItems<T> {
  group: RailGroupId;
  items: T[];
}

export interface RailLayout<T> {
  /** 右上：前四组，空组不出现；组与组之间画一条细线 */
  stack: RailGroupItems<T>[];
  /** 右下：`app` 组 */
  dock: T[];
  /** 「更多」菜单的内容（只有精简态非空），按组序、空组不出现 */
  more: RailGroupItems<T>[];
}

/**
 * 把入口清单（组内顺序即数组顺序）排成右栏。
 * `lean` = false：除 moreOnly 外全部上条；`lean` = true：只有 pinned 的上条，其余进 more。
 */
export function layoutRail<T extends RailPlacement>(items: readonly T[], lean: boolean): RailLayout<T> {
  const onRail = (item: T): boolean => item.moreOnly !== true && (!lean || item.pinned);
  const inMore = (item: T): boolean => lean && !item.pinned;
  const collect = (keep: (item: T) => boolean, groups: readonly RailGroupId[]): RailGroupItems<T>[] =>
    groups
      .map((group) => ({ group, items: items.filter((item) => item.group === group && keep(item)) }))
      .filter((entry) => entry.items.length > 0);
  const upper = RAIL_GROUP_IDS.filter((group) => group !== "app");
  return {
    stack: collect(onRail, upper),
    dock: items.filter((item) => item.group === "app" && onRail(item)),
    more: collect(inMore, RAIL_GROUP_IDS),
  };
}

/** 把分好组的清单拍平成一列，组与组之间插一个由 `rule` 造出的分隔项（给 Menu 的 `rule` 项用） */
export function withGroupRules<T, R>(groups: readonly RailGroupItems<T>[], rule: (before: RailGroupId) => R): (T | R)[] {
  return groups.flatMap((entry, index) => (index === 0 ? entry.items : [rule(entry.group), ...entry.items]));
}
