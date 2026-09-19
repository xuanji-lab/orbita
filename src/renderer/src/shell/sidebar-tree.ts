import type { SessionMeta } from "@shared/session";

/**
 * 侧栏「挂父下两层树」（B-2）的分组规则——纯函数，`node --test` 直测。
 *
 * 输入是**一个组内**的 live 会话列表（TASKS 或某个工作区，已按 sortSessions 排好）。
 * 子会话挂到父行下；**父不在这份列表里就升为顶层**——父被删（不级联）、被归档
 * （主列表不见）、或被挪去别的组时，子不能跟着消失。
 *
 * 树只有两层可画，所以「父自己也是子」的会话（B-2 造不出来的数据，只可能来自
 * 旧数据或坏账本）**摊平到顶层**——不可见的行比错位的行更糟，照搬 store.remove
 * 的同一条纪律。环引用按顶层处理，不递归到底。
 */
export interface SidebarTree {
  /** 顶层会话，保持既有排序 */
  top: SessionMeta[];
  /** 挂在 id 下的子会话（保持既有排序；没有就是空数组） */
  childrenOf: (id: string) => SessionMeta[];
}

export function splitByParent(metas: readonly SessionMeta[]): SidebarTree {
  const byId = new Map(metas.map((meta) => [meta.id, meta] as const));
  const topCache = new Map<string, boolean>();

  const isTop = (meta: SessionMeta, seen: ReadonlySet<string>): boolean => {
    const cached = topCache.get(meta.id);
    if (cached !== undefined) return cached;
    const parentId = meta.parentSessionId;
    if (parentId === null || seen.has(meta.id)) return true;
    const parentMeta = byId.get(parentId);
    if (parentMeta === undefined) return true;
    const result = !isTop(parentMeta, new Set(seen).add(meta.id));
    topCache.set(meta.id, result);
    return result;
  };

  const children = new Map<string, SessionMeta[]>();
  const top: SessionMeta[] = [];
  for (const meta of metas) {
    const parentId = meta.parentSessionId;
    if (parentId === null || isTop(meta, new Set())) {
      top.push(meta);
      continue;
    }
    const bucket = children.get(parentId);
    if (bucket === undefined) children.set(parentId, [meta]);
    else bucket.push(meta);
  }
  return { top, childrenOf: (id: string) => children.get(id) ?? [] };
}
