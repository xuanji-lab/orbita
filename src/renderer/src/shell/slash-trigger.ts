/**
 * 指令面板（/）的触发判定与选中后的文本改写。
 *
 * 触发规则对齐 Gemini CLI / Codex CLI（2026 竞品调研，结论见当次 PR 描述）：
 * - **只看第一行**：后面的行不影响指令模式（Codex 查 `text.lines().next()`，
 *   Gemini 查 `cursorRow === 0`）——旧实现「含 \n 就整个不弹」是独有的严格；
 * - **允许前导空白**：第一行 trimStart 后以 / 开头即可（Gemini 的 trim 判定；
 *   Codex 拒绝前导空白，二选一取宽）；
 * - **光标必须在第一行**：否则编辑后续行时 ↑↓ / Enter 会被面板劫走
 *   （Gemini 同样用光标行号把面板收掉）；
 * - **`//` 开头不算指令**：那是代码注释（Gemini 的 isSlashCommand 同样排除）。
 *
 * 中途触发（一行中间的 /）**不做**：这个输入框里常出现 /tmp/... 这类绝对路径，
 * Claude Code 的中途触发靠「前缀必须命中指令」约束才没撞路径，Cursor 做了同样
 * 的事却被官方认定为 UX 问题——分歧不值得现在站队，要做是另一个 PR 的事。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */

/** 光标处于第一行的 / 指令 token 上时返回过滤词（小写、去首尾空白），否则返回 null。 */
export function slashQuery(value: string, cursor: number): string | null {
  const newline = value.indexOf("\n");
  const firstLine = newline === -1 ? value : value.slice(0, newline);
  // 光标在后面的行上：面板收起，方向键还给文本编辑
  if (cursor > firstLine.length) return null;
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed.slice(1).trim().toLowerCase();
}

/**
 * 输入是否处于指令模式（第一行是 / 前缀）。与光标无关——
 * 面板关闭态（esc / insert）的重置跟内容走，不跟光标走。
 */
export function slashMode(value: string): boolean {
  const newline = value.indexOf("\n");
  const firstLine = newline === -1 ? value : value.slice(0, newline);
  const trimmed = firstLine.trimStart();
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}

/** 选中 skill 后改写：只替换第一行（连同前导空白），其余行原样保留。 */
export function replaceFirstLine(value: string, replacement: string): string {
  const newline = value.indexOf("\n");
  return newline === -1 ? replacement : replacement + value.slice(newline);
}
