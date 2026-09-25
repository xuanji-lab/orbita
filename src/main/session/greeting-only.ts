/**
 * 迁移的可选检查「只随手发了一句 hi / test 的会话」（wafo 2026-09-25）——主进程这一侧，纯函数：
 *
 * 1. 挑候选：用户**只写过一条消息**的会话才可能是这种随手一句；接着聊过的不送去判，也不花额度。
 *    「用户写的」按各来源 transcript 的原文算：注入、通知、技能正文这类模型读到但用户没写的不算。
 * 2. 明摆着的先认：整条就是 hi / test / 你好 / 测试这类（词表），直接判中，不问模型——这几条
 *    结果不该随模型的发挥变（实测同一批问两次，一次漏掉了单独的「hi」），也省额度。
 * 3. 其余分批交给模型（agent 进程的 classifyGreetings）：词表认不出「hi claude can you hear me」
 *    「测试一下能不能用」这类。判中的下标映射回 sourceFile。给模型的指令与回复的解析在 agent 一侧
 *    （src/agent/greeting-check.ts），模型调用在那个进程里。
 */

/** 明摆着的招呼与测试语（去掉空白、标点、符号、大小写之后整条相等）。刻意保守：ok / go 这类不收 */
const OBVIOUS: ReadonlySet<string> = new Set([
  "hi", "hii", "hiii", "hello", "helo", "hallo", "hey", "heyy", "yo",
  "hithere", "hellothere", "heythere", "hiclaude", "helloclaude", "heyclaude", "helloworld",
  "test", "tests", "testing", "testtest", "ping",
  "你好", "您好", "你好啊", "哈喽", "哈啰", "嗨", "在吗", "在不在", "测试", "测试一下", "测一下", "试试", "试一下",
]);

/** 整条消息是不是明摆着的招呼 / 测试语：词表里的、只剩数字的（「1」）、只有标点的（「?」）、带数字尾巴的（「test1」）。 */
export function isObviousGreeting(text: string): boolean {
  const core = text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
  if (core === "" || /^\d+$/.test(core) || OBVIOUS.has(core)) return true;
  const stem = core.replace(/\d+$/, "");
  return stem !== core && OBVIOUS.has(stem);
}

/** 送去判的一条最多这么长：够看出是不是招呼，也不把长问题整段发出去 */
export const GREETING_MESSAGE_MAX = 300;
/** 一次请求判这么多条：几百条候选也只要几次调用 */
export const GREETING_BATCH_SIZE = 40;

/**
 * 用户唯一写过的那条消息；写过零条或不止一条返回 null。userTexts 是按顺序的用户消息原文，
 * null（模型读到、用户没写的）与空白串不算一条。
 */
export function onlyWrittenMessage(userTexts: readonly (string | null)[]): string | null {
  let only: string | null = null;
  for (const text of userTexts) {
    if (text === null || text.trim() === "") continue;
    if (only !== null) return null;
    only = text.trim();
  }
  return only;
}

/**
 * 汇总判中的 sourceFile：明摆着的直接判中，其余按批问模型。classify 收一批消息、回判中的下标
 * （越界与重复的忽略）；任何一批失败整次失败——半截结果会让页面把一部分随手一句留在列表里，
 * 还看不出来。asked 是实际问了模型的条数（全被词表认完就是 0，不调模型）。
 */
export async function findGreetingOnly(
  candidates: ReadonlyMap<string, string>,
  classify: (messages: string[]) => Promise<number[]>,
): Promise<{ greetingOnly: string[]; asked: number }> {
  const found: string[] = [];
  const unsure: [string, string][] = [];
  for (const [file, text] of candidates) {
    if (isObviousGreeting(text)) found.push(file);
    else unsure.push([file, text]);
  }
  for (let start = 0; start < unsure.length; start += GREETING_BATCH_SIZE) {
    const batch = unsure.slice(start, start + GREETING_BATCH_SIZE);
    const hits = new Set(await classify(batch.map(([, text]) => text.slice(0, GREETING_MESSAGE_MAX))));
    for (const index of hits) {
      const entry = batch[index];
      if (entry !== undefined) found.push(entry[0]);
    }
  }
  return { greetingOnly: found, asked: unsure.length };
}
