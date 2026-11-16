/**
 * 认出历史会话里的「收尾扫描」机器提问。**纯模块**，renderer、主进程与 node --test 共用。
 *
 * 收尾扫描（点「完成」后让模型回看会话、列出做完的事与遗留事项）2026-11-16 随遗留事项整套删了
 * （用户：「做不到 proactive 的话……就是熵增……有消费者了再做」）。旧会话里还存着那条机器提问：它不是一轮、
 * 不进意图系统、不算最近提问、不进记忆的轮次——这几处过滤仍要认得它，所以只留这一个认法。
 * intent-lab 仓库（src/server-contract.ts）有一份同样的认法副本。
 */

/**
 * v1 的扫描 prompt 全文（2026-10 之前的会话里存着它）。只用来**认**历史里的机器提问——
 * 它不是一轮、不进意图系统；不再发出。
 */
export const LEGACY_CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- 每一项恰好有 title 和 detail 两个键，不重复、不缺、不多；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;

/** v2 扫描 prompt 的首行：认机器提问就认它（prompt 其余部分随轮次表变化） */
export const CLOSING_SCAN_HEAD = "【Orbita 收尾扫描】";

/** 这一轮文本是不是收尾扫描的机器提问（v2 看首行标记；v1 认全文） */
export function isClosingScanText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(CLOSING_SCAN_HEAD) || trimmed === LEGACY_CLOSING_SCAN_PROMPT.trim();
}
