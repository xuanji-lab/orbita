import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";

/**
 * 编排形态右栏「编排」面板的树（纯函数，可被 node --test 直接加载）。
 *
 * 导航模型（2026-11-24 用户定）：「在主智能体新建 session 的时候会出现星系，session 开始了就没了；
 * 下次想进 session，就得先进主智能体，然后再在右侧面板那个树状图里找到 session。」
 * 所以这棵树要列出这个工作区的**全部** session，子会话挂在父会话下面：
 * - 根 = 主智能体（工作区本身）；下一层 = 这个工作区的每一条会话；子会话再往下一层。
 * - 次序只按创建时间（新的在前）——状态变化不让行换位置，只有内容增减才动。
 * - 自己退场：分成「最近」（在跑 / 等你 / 有结果没看 / 子会话在动 / 3 天内动过）与「更早」两段；
 *   「更早」默认收成一行，点开就是全部，不藏、不删。
 */

/** 没动静的会话多久不碰就进「更早」（与星系的 IDLE_CHILD_MS 同档：3 天） */
export const TREE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

export interface TreeNode {
  meta: SessionMeta;
  /** 这一行的状态（含子会话汇总，与侧栏状态饼同口径） */
  state: SessionRunState;
  /** 子会话（新的在前），全部 */
  children: TreeNode[];
  /** 有子会话在等你 / 在跑：默认展开 */
  activeBelow: boolean;
}

export interface OrchestraTree {
  /** 在跑 / 等你 / 有结果没看 / 子会话在动 / 3 天内动过的会话 */
  recent: TreeNode[];
  /** 其余（默认收起成一行，点开即全部） */
  older: TreeNode[];
  /** 全部会话数（不含子会话） */
  total: number;
}

function live(state: SessionRunState): boolean {
  return state === "waiting" || state === "running";
}

/** 一条会话算不算在这座星系里：归档的、自动化开出来还没转正的不算（侧栏也不列它们） */
function listed(meta: SessionMeta): boolean {
  return !meta.archived && (meta.automationId === undefined || meta.promoted === true);
}

export function orchestraTree(input: {
  sessions: readonly SessionMeta[];
  workspaceId: string | null;
  stateOf: (meta: SessionMeta) => SessionRunState;
  now: number;
}): OrchestraTree {
  const childrenOf = new Map<string, SessionMeta[]>();
  for (const meta of input.sessions) {
    if (meta.parentId === undefined) continue;
    const list = childrenOf.get(meta.parentId);
    if (list === undefined) childrenOf.set(meta.parentId, [meta]);
    else list.push(meta);
  }
  const byNewest = (a: SessionMeta, b: SessionMeta): number => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const node = (meta: SessionMeta): TreeNode => {
    const kids = [...(childrenOf.get(meta.id) ?? [])].sort(byNewest).map(node);
    return { meta, state: input.stateOf(meta), children: kids, activeBelow: kids.some((kid) => live(kid.state) || kid.activeBelow) };
  };
  const roots = input.sessions
    .filter((meta) => meta.parentId === undefined && meta.workspaceId === input.workspaceId && listed(meta))
    .sort(byNewest);
  const recent: TreeNode[] = [];
  const older: TreeNode[] = [];
  for (const meta of roots) {
    const each = node(meta);
    const stays = each.state !== null || each.activeBelow || input.now - meta.updatedAt <= TREE_IDLE_MS;
    (stays ? recent : older).push(each);
  }
  return { recent, older, total: roots.length };
}

/** 页头次级标题：会话标题；空标题给「新任务」（不露会话 id） */
export function sessionHeadTitle(meta: Pick<SessionMeta, "title"> | null | undefined, fallback: string): string {
  const title = meta?.title.trim() ?? "";
  return title === "" ? fallback : title;
}
