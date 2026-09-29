/**
 * 听写的文字怎么落进输入框（纯函数，node --test 直接加载）。
 *
 * 开始听写时把输入框按光标（或选区）切成前后两段，识别出的文字始终插在中间：
 * 服务端每次给的是这条连接的**全量**文字，直接替换中间那段，不用自己拼增量。
 * 一次听写跨了几条连接（停顿久了服务端收尾、自动重连）时，前面连接的文字先固定下来，
 * 新连接的接在后面。
 */

/** 两段文字接起来：两边挨着的都是英文字母或数字时补一个空格，中文直接相连 */
export function joinSpoken(left: string, right: string): string {
  if (left === "") return right;
  if (right === "") return left;
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : `${left}${right}`;
}

/** 输入框里的样子：前段 + 听写文字 + 后段，接缝处按 joinSpoken 的规则补空格 */
export function composeDictation(before: string, spoken: string, after: string): string {
  if (spoken === "") return `${before}${after}`;
  return joinSpoken(joinSpoken(before, spoken), after);
}

/** 开始听写那一刻的输入框：光标前、光标后（有选区时选中的那段被听写替换） */
export function splitAtSelection(value: string, start: number | null, end: number | null): { before: string; after: string } {
  const from = start === null ? value.length : Math.max(0, Math.min(start, value.length));
  const to = end === null ? from : Math.max(from, Math.min(end, value.length));
  return { before: value.slice(0, from), after: value.slice(to) };
}
