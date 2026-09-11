/**
 * 用户输入的数学公式切段器（docs/plans/2026-09-05-用户输入公式渲染.md）。
 *
 * 把纯文本切成 text / inlineMath / blockMath 三种段，**与模型输出渲染同一套语义**：
 * - 金额防误判（math-guard.ts 同规则）：行内公式的值贴空白（`$5 and $10`）不是公式，
 *   还原成原文当文本——真公式从不写作 `$ x $`。块级 `$$` 自成一行，不适用这条。
 * - 流式补全（pending-math.ts 同规则）：结尾悬着的未闭合定界符按已闭合渲染，
 *   打一半的公式也能成形。
 *
 * 纯字符串运算、零依赖——node --test 直接加载，不经 vite、不碰 DOM。
 */

export type MathSegment =
  | { kind: "text"; value: string }
  | { kind: "inlineMath"; value: string }
  | { kind: "blockMath"; value: string };

/** 行内定界符包住的东西能当公式吗：空串或贴空白（开头/结尾是空白）是钱和词边界 */
function isBoundaryNoise(value: string): boolean {
  return value === "" || /^\s/.test(value) || /\s$/.test(value);
}

export function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let i = 0;
  const pushText = (end: number) => {
    if (end > i) segments.push({ kind: "text", value: text.slice(i, end) });
  };
  while (i < text.length) {
    const block = text.indexOf("$$", i);
    const inline = text.indexOf("$", i);
    if (block === -1 && inline === -1) {
      pushText(text.length);
      break;
    }
    // `$$` 优先：inline 的 indexOf 会命中 `$$` 的第一个 `$`，所以 block <= inline 时都按块级走
    if (block !== -1 && (inline === -1 || block <= inline)) {
      pushText(block);
      const close = text.indexOf("$$", block + 2);
      if (close === -1) {
        // 未闭合的块级整段收进来（流式补全：打一半也成形）
        segments.push({ kind: "blockMath", value: text.slice(block + 2) });
        return segments;
      }
      segments.push({ kind: "blockMath", value: text.slice(block + 2, close) });
      i = close + 2;
    } else {
      const close = text.indexOf("$", inline + 1);
      if (close === -1) {
        const value = text.slice(inline + 1);
        pushText(inline);
        if (isBoundaryNoise(value)) {
          // 未闭合但贴空白：还原成原文（含那个悬着的 $），与闭合侧的降级同规则
          segments.push({ kind: "text", value: `$${value}` });
        } else {
          segments.push({ kind: "inlineMath", value });
        }
        return segments;
      }
      pushText(inline);
      const value = text.slice(inline + 1, close);
      if (isBoundaryNoise(value)) {
        segments.push({ kind: "text", value: `$${value}$` });
      } else {
        segments.push({ kind: "inlineMath", value });
      }
      i = close + 1;
    }
  }
  return segments;
}
