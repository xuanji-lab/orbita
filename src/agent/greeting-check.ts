/**
 * 迁移的可选检查「只随手发了一句 hi / test 的会话」——agent 进程这一侧：给模型的指令、一批消息
 * 写成的正文、回复的解析。纯函数。候选的挑选与分批在主进程（src/main/session/greeting-only.ts）。
 */

/**
 * 给模型的指令。只要一个 JSON 数组，读不懂就算失败（parseGreetingReply）。
 * 判定口径写死在这里：只有招呼 / 测试 / 试探能不能用，没有任何实际请求，才算。
 */
export const GREETING_SYSTEM_PROMPT = `You review the opening messages of chat sessions with an AI assistant. In each session below, the user sent exactly one message and never continued.

Many people send a throwaway first message just to start a usage window or to check that the tool works: a greeting ("hi", "hello", "你好"), a test ("test", "测试", "ping"), or a check like "are you there" / "can you hear me" / "测试一下能不能用". Those sessions carry no real request.

Mark a message as throwaway only if the whole message is a greeting, a test word, or a check that the assistant is working. It is not throwaway if it contains any question, task, instruction, command (slash commands like /review or /code-review included), setup prompt, pasted content, or other substance — even a brief one. When in doubt, do not mark it.

The messages are numbered from 0. Reply with only a JSON array of the numbers that are throwaway, e.g. [0, 3]. Reply [] if none are.`;

/** 一批消息写成给模型看的正文：编号 + 原文，原文用 JSON 字符串转义（换行、引号不串行）。 */
export function greetingPrompt(messages: readonly string[]): string {
  return messages.map((message, index) => `${index}: ${JSON.stringify(message)}`).join("\n");
}

/**
 * 模型的回复 → 判中的下标。容忍回复前后的说明文字与代码块围栏，取第一个 JSON 数组；
 * 读不出整数数组返回 null（调用方按失败处理）。
 */
export function parseGreetingReply(reply: string, count: number): number[] | null {
  const match = /\[[\s\d,]*\]/.exec(reply);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const indexes = parsed.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < count);
  return [...new Set(indexes)].sort((a, b) => a - b);
}
