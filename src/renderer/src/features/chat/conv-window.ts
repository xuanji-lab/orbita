/**
 * 确认卡「当时那段对话」的窗口逻辑——纯函数核（node --test 可直接加载）。
 *
 * qa.q / qa.a 是围绕摘句的窗口（契约 2026-10-14 增补，qWindow/aWindow 元数据）：
 * 窗口截断可能把代码块从中间劈开（渲染前要补闭合）、窗口外还有多少字（提示行的 N）、
 * 摘句高亮在滚动区里怎么摆（居中，或太长时开头顶上）都在这里算，组件只搬 DOM。
 */
import type { ExcerptWindow } from "../../../../shared/intent-edges.ts";

/**
 * 窗口截断可能把代码 fence 劈成奇数个 ``` ——markdown 会把后半截全当代码吃掉。
 * 奇数时在末尾补一个闭合 fence（只是显示，不写回数据）。~~~ fence 同理。
 */
export function closeOpenFence(text: string): string {
  let out = text;
  if (countFences(out, "```") % 2 === 1) out += "\n```";
  if (countFences(out, "~~~") % 2 === 1) out += "\n~~~";
  return out;
}

/**  fence 行数：只数行首的（行内的 ```` 是内联代码，不是 fence） */
function countFences(text: string, fence: "```" | "~~~"): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith(fence)) count += 1;
  }
  return count;
}

/** 窗口外前 / 后各还有多少字（提示行的 N）；没有窗口元数据（旧服务端）为 null。 */
export function windowCounts(
  win: ExcerptWindow | undefined,
  textLength: number,
): { before: number; after: number } | null {
  if (win === undefined) return null;
  return {
    before: win.cutBefore ? Math.max(0, win.start) : 0,
    after: win.cutAfter ? Math.max(0, win.total - win.start - textLength) : 0,
  };
}

/**
 * 摘句在滚动区里的目标 scrollTop：放得下就垂直居中，比可视区高就把开头顶到上沿
 * （居中会把开头藏到看不见的地方）。参数都是内容坐标系里的像素（mark 顶 / 底、可视高）。
 */
export function markScrollTop(markTop: number, markBottom: number, clientHeight: number): number {
  const markHeight = markBottom - markTop;
  if (markHeight > clientHeight) return Math.max(0, markTop - 4);
  return Math.max(0, markTop - (clientHeight - markHeight) / 2);
}
