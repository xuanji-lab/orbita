import type { RightPanelKind } from "./RightRail.tsx";
import type { TerminalDock } from "@shared/settings";
// 两条都是纯类型 import：node --test 的原生剥离会把它们连同整行删掉，
// 不会真的去加载 RightRail.tsx（带 JSX）或解析 @shared 别名（node 没有
// 这个 alias，只有 vite 有）——同 right-panel-memory.ts 的先例。

/**
 * 底部终端的**按会话记忆**（与 right-panel-memory.ts 同一套思路：用户 2026-10-18
 * 「每个 session，应该记住自己离开的时候，右侧面板是啥」，底部终端的开 / 关
 * 按同一条裁决记）。停靠位置与高度是全局设置（settings.terminalDock /
 * terminalBottomHeight），**这里只记「这条会话离开时底部终端开没开」**，
 * 只记在 renderer 内存、不持久化，重启后从「关着」起步。
 *
 * 三条纯逻辑住在这里（可直测，App 只留编排）：
 * - rememberTerminalOpen / recallTerminalOpen：同 rememberPanel / recallPanel
 *   的形状与边界（首页不是会话：不记也不恢复）；
 * - restoreTerminalState：切会话那一拍，把两条记忆（右栏面板 + 底部终端）
 *   按当前停靠位归位——记忆是跨停靠位生效的：停靠位在右栏时记下的
 *   \"terminal\"，停靠位换到底部后切回这条会话，恢复成「底部终端开着」，
 *   不是把终端塞回右栏；
 * - moveDockTo：用户扳动终端头部的停靠开关那一拍，终端跟着开关搬过去
 *   （右栏位让给别的面板 / 底部终端收起，面板位换成终端）。
 */

/** 会话 id → 它离开时底部终端开没开。没记过的会话查不到（恢复成关着） */
export type TerminalOpenMemory = ReadonlyMap<string, boolean>;

/** 同 rememberPanel：session 为 null（首页 / 还没有会话）时原样返回 */
export function rememberTerminalOpen(
  memory: TerminalOpenMemory,
  session: string | null,
  open: boolean,
): TerminalOpenMemory {
  if (session === null) return memory;
  const next = new Map(memory);
  next.set(session, open);
  return next;
}

/** 同 recallPanel：没记过与 session 为 null 都恢复成关着 */
export function recallTerminalOpen(memory: TerminalOpenMemory, session: string | null): boolean {
  if (session === null) return false;
  return memory.get(session) === true;
}

/**
 * 切会话那一拍的归位：两条记忆（离开会话时的右栏面板 + 底部终端开合）按
 * **当前**停靠位合成下一拍的状态。
 *
 * - 停靠在右栏：底部终端不存在，bottomOpen 恒 false；面板照记忆恢复
 *   （记忆里就有 \"terminal\" 这种——面板位就是终端的家）。
 * - 停靠在底部：面板照记忆恢复，但 \"terminal\" 不再是右栏的面板——那是
 *   停靠位还在右栏的年代记下的，翻译成「底部终端开着」；底部终端另按
 *   自己的记忆恢复（\"terminal\" 记忆优先于 bottomOpen 记忆：同一条会话
 *   不会两样都记到，前者只出现在停靠位后来换过的场景）。
 */
export function restoreTerminalState(
  panel: RightPanelKind | null,
  bottomOpen: boolean,
  dock: TerminalDock,
): { panel: RightPanelKind | null; bottomOpen: boolean } {
  if (dock === "right") return { panel, bottomOpen: false };
  if (panel === "terminal") return { panel: null, bottomOpen: true };
  return { panel, bottomOpen };
}

/**
 * 扳动停靠开关那一拍：终端跟着开关**搬家**。开关住在终端自己的标题行里，
 * 扳动时终端必然开着——搬到的一头一定要开。
 *
 * - 搬到底部：终端在底部展开；右栏若正显示终端就让位（终端挪走了），
 *   其它面板（文件 / 审查…）不动——底部终端与右栏本来就可同开。
 * - 搬回右栏：右栏面板位换成终端（原先开着的面板被换下），底部收起。
 */
export function moveDockTo(
  dock: TerminalDock,
  panel: RightPanelKind | null,
): { panel: RightPanelKind | null; bottomOpen: boolean } {
  if (dock === "bottom") {
    return { panel: panel === "terminal" ? null : panel, bottomOpen: true };
  }
  return { panel: "terminal", bottomOpen: false };
}

/**
 * 拖高热区的几何（2026-10-18 用户验收：「拖高那根线难瞄准」）：热区 12px，
 * **骑在分界线上下各一半**——槽自己 overflow:hidden（开合动画要裁内容），
 * 线上方那半在槽里注定裁掉，所以热区整个挂在 pane-col 里（定位基准是分界线，
 * bottom 偏移 = 槽高 − 半个热区）。静止不显示，悬停 / 拖动才显示一条细线。
 */
export const TERMINAL_DOCK_RESIZER_SIZE = 12;

/** 热区在 pane-col 里的 bottom 偏移（px）：热区底边 = 分界线 + 半个热区 */
export function dockResizerBottomOffset(dockHeight: number): number {
  return dockHeight - TERMINAL_DOCK_RESIZER_SIZE / 2;
}
