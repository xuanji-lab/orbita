import type { RightPanelKind } from "./RightRail.tsx";
// 只要类型：RightPanelKind 是纯类型别名，`node --test` 的原生剥离会把整条 import
// 连同这一行一起删掉，不会真的去加载 RightRail.tsx（那份文件带 JSX，Node 的类型
// 剥离不认）——同 tree-view.ts 引 IconName 的先例。

/**
 * 右栏面板的**按会话记忆**（用户 2026-10-18：「每个 session，应该记住自己离开的
 * 时候，右侧面板是啥」）。每条主槽会话离开时右栏开着哪个面板（种类，或「关着」），
 * 切回来时恢复；没记过的会话恢复成「关着」。
 *
 * 边界（用户同轮确认的默认做法）：
 * - 只记**面板种类**，不记文件面板里的标签——「切会话清标签」的既有设计不变；
 * - 只记在 renderer 内存（App 里的 ref），不持久化、不进会话 meta / IPC 契约，
 *   重启后都从「关着」起步；
 * - 右栏宽度仍全局共用一个，不按会话分；
 * - 首页 / 还没有会话（session 为 null）不是会话：不记也不恢复。
 *
 * 纯函数住独立模块（同 cite-focus.ts 的做法）：记忆的取舍规则在这里可直测，
 * App 只留「切走时记、切回时取」两行编排。
 */

/** 会话 id → 它离开时的面板（null = 关着）。没记过的会话查不到（恢复成关着） */
export type PanelMemory = ReadonlyMap<string, RightPanelKind | null>;

/**
 * 记下一条会话离开时的面板。session 为 null（首页 / 还没有会话）时原样返回——
 * 首页不是会话，面板开着也不算任何会话的离开状态（回到首页沿用当前面板，与
 * 改前的行为一致；从首页再切到会话时，由目标会话自己的记忆说话）。
 */
export function rememberPanel(
  memory: PanelMemory,
  session: string | null,
  panel: RightPanelKind | null,
): PanelMemory {
  if (session === null) return memory;
  const next = new Map(memory);
  next.set(session, panel);
  return next;
}

/** 一条会话该恢复成哪个面板：没记过（从没开过右栏 / 新会话）与 session 为 null 都恢复成关着 */
export function recallPanel(memory: PanelMemory, session: string | null): RightPanelKind | null {
  if (session === null) return null;
  return memory.get(session) ?? null;
}
