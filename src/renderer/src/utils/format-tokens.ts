/**
 * token 数的紧凑写法 —— 纯函数，node --test 可直接加载。
 *
 * 从 chat 的 stats-text.ts 提升出来：设置面要显示模型参数（窗口 / 单价），
 * 第二个消费者出现才建这一层。阶梯沿用 pi TUI footer 的惯例（footer.ts formatTokens）。
 */

/**
 * token 数的紧凑写法：18.2k / 142k / 1.2M。999 以内原样（session 里零星小数字不值得缩写）。
 * 阶梯学 pi 的 footer，但一位小数放宽到 100k——它在 10k 就取整是为了终端宽度，
 * 桌面底栏不用省这一两个字符（`18.2k / 200k` 是批次文档定的演示格式）。
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
