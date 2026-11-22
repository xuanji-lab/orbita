/**
 * 旧版「收尾扫描」留在历史会话里的机器提问的识别。
 *
 * 「完成 / 收尾」功能已删，不再发出这类提问；但旧会话的记录里还躺着它们（一条首行带
 * 【Orbita 收尾扫描】标记的 user 消息，加上模型的回答）。意图系统、记忆、会话标题与首句摘要都要
 * 认出它们并跳过——它们不是用户说的话、也不算一轮。所以只留这一个识别函数。
 * intent-lab 仓库（src/server-contract.ts）有一份同样的认法，与它同步。
 */
/** v1 的扫描 prompt 全文（2026-10 之前的会话里存着它）。只用来**认**，不再发出 */
export const LEGACY_CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- 每一项恰好有 title 和 detail 两个键，不重复、不缺、不多；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;

/** v2 扫描 prompt 的首行：认机器提问就认它 */
export const CLOSING_SCAN_HEAD = "【Orbita 收尾扫描】";

/** 这一轮文本是不是收尾扫描的机器提问（v2 看首行标记；v1 认全文） */
export function isClosingScanText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(CLOSING_SCAN_HEAD) || trimmed === LEGACY_CLOSING_SCAN_PROMPT.trim();
}
