/**
 * 收尾扫描（遗留事项仪式）的机器提问全文。
 *
 * 真源在这里（shared），renderer 的 carryover-parse.ts 转发导出，main 进程的意图
 * 存档跟踪器（intent-ingest.ts）与历史切 QA（intent-lab.ts）都用它认「这一轮是
 * 机器提问」——机器提问不是用户的意图，不进意图系统的库（2026-10-08 用户定）。
 * intent-lab 侧同步了一份（src/server-contract.ts 的 CLOSING_SCAN_PROMPT）做兜底，
 * 改措辞时两边一起改。
 *
 * 措辞就是契约：解析器认的输出形状（一个 fenced json 块）在这里约定，两处一起改。
 */
export const CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- 每一项恰好有 title 和 detail 两个键，不重复、不缺、不多；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;

/** 这一轮文本是不是收尾扫描的机器提问（回退后重发的同一条也是它）。 */
export function isClosingScanText(text: string): boolean {
  return text.trim() === CLOSING_SCAN_PROMPT.trim();
}
