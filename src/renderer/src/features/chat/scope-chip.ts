/**
 * 输入框底栏工作区芯片的语义（2026-10-31 用户认可）：
 *   - 首页（还没有「这条」）：选一项 = 新任务放在那里
 *   - 对话里：选一项 = 把这条会话移过去（工作目录一起换）；正在跑的不能移，
 *     除了当前所在那一项之外全部灰掉（当前项点了也只是无操作）
 * 纯函数，ChatView 只负责把结果接到菜单项上。
 */
export type ScopeChipAction = "new-task" | "move" | "blocked" | "stay";

export function scopeChipAction(input: {
  inConversation: boolean;
  running: boolean;
  /** 这一项是不是会话眼下所在的工作区（null = 无工作区） */
  isCurrent: boolean;
}): ScopeChipAction {
  if (!input.inConversation) return "new-task";
  if (input.isCurrent) return "stay";
  return input.running ? "blocked" : "move";
}
