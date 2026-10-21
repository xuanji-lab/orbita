/**
 * 摘抄正文的展开 / 收起（纯逻辑 + 本次运行内的展开记忆，node:test 直接测）。
 *
 * - {@link isClipped}：line-clamp 元素是否真的被截断。scrollHeight 不受封顶影响
 *   （Menu.tsx 量自然高度同款），超过 clientHeight 即有被藏起来的内容；留 1px
 *   容差吸收亚像素取整。
 * - {@link showToggle}：截断了才显示展开键；展开后正文不再溢出（isClipped 变
 *   false），但键必须留着否则收不回去，由 expanded 兜底。从未被截断的短摘抄
 *   全程不出键。
 * - {@link toggleExpanded}：展开 id 集合的不可变切换。
 * - {@link readExpandedExcerpts} / {@link writeExpandedExcerpts}：展开状态存在
 *   模块级单例里——切页签、切面板、切会话回来都还在，app 重启即失，不落盘。
 */

/** 亚像素容差：scrollHeight 比 clientHeight 高出不超过 1px 视为没截断 */
export const EXCERPT_CLIP_TOLERANCE_PX = 1;

export function isClipped(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > EXCERPT_CLIP_TOLERANCE_PX;
}

export function showToggle(clipped: boolean, expanded: boolean): boolean {
  return clipped || expanded;
}

export function toggleExpanded(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** 本次运行内展开着的摘抄 id（模块级单例，renderer 各处共享，不落盘） */
const expandedIds = new Set<string>();

export function readExpandedExcerpts(): ReadonlySet<string> {
  return expandedIds;
}

export function writeExpandedExcerpts(ids: ReadonlySet<string>): void {
  expandedIds.clear();
  for (const id of ids) expandedIds.add(id);
}
