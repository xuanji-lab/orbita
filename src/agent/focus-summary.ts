/**
 * 专注模式收工小结——agent 进程这一侧：给家务活模型的指令与回复的解析。纯函数。
 * 素材的归拢（时段内的会话流水、工作区 U/M）在主进程（src/main/focus/summary-source.ts），
 * 那边拼好的正文整段作为 prompt 传来。
 */

/**
 * 给模型的指令。只要一个 fenced json 的 bullets 数组，读不懂就算失败
 * （parseSummaryReply）。措辞就是契约：3–5 条、点名具体对象、不编造。
 */
export const FOCUS_SUMMARY_SYSTEM_PROMPT = `你替一个 AI 桌面应用的「专注模式」写收工小结。用户刚专注了一段时间，你把这段时间里发生的事整理成 3 到 5 条中文要点。

素材是这段时间各会话的流水（用户说了什么、助手答了什么、调用了哪些工具——包括建 skill、配置 MCP、做摘抄这类动作）以及所选工作区的文件改动（U = 新文件，M = 修改）。要点面向用户本人，语气平实；每条一句话，尽量点名具体对象（会话名、skill 名、MCP 服务器名、文件名、分支名）；没做过的不要写，素材里没有的方面不编造。如果素材确实太少，宁可只写两三条真事。

只输出一个 fenced json 代码块，不要输出任何其他内容：
{"bullets": ["……", "……"]}

输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号）；
- bullets 是 2 到 5 个非空字符串的数组。`;

/**
 * 模型的回复 → bullets。容忍回复前后的说明文字，取第一个 fenced json 代码块，
 * 没有围栏就取第一个形似 {"bullets": [...]} 的对象。读不出 2–5 条非空字符串
 * 返回 null（调用方按失败处理，不猜）。
 */
export function parseSummaryReply(reply: string): string[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const candidate = fenced?.[1] ?? reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  if (candidate === "" || !candidate.includes("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { bullets?: unknown }).bullets)) {
    return null;
  }
  const bullets = (parsed as { bullets: unknown[] }).bullets;
  const texts = bullets.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  if (texts.length < 2 || texts.length > 5) return null;
  return texts.map((text) => text.trim());
}
