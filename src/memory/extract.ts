/**
 * 事件段 → 三类原子记忆的提取调用（事实 / 偏好 / 经验，QUMem 每段恰好三次调用
 * 的那次）——提示词与解析都在这。**纯模块**，可被 `node --test` 直接加载；
 * 模型调用由 service-core 注入（这里的输出只是 prompt 与解析结果）。
 *
 * 写法规则 = AtomMem 的原子化 + Mandol 的自包含改写（两家实测共同指向的最大杠杆），
 * 全部嵌进提示词：滤寒暄、消指代、相对时间转绝对日期、第三人称、带日期说话人话题
 * 的完整句。三类各自的纪律：
 * - 事实：只录发生过的事，不推断、不总结方法论；
 * - 偏好：必须带理由（reason），不默认永远成立；与旧偏好矛盾报 conflictsWith（落盘时
 *   旧条直接标过时）、跨工作区通用报 crossWorkspace（直接记到所有工作区）——2026-10-29
 *   用户裁决由 agent 判断、不要待确认，所以提示词把「拿不准就不加」讲在前头；
 * - 经验：必须挂具体交互证据（reason 引用段内交互），凭空泛化的道理不提。
 *
 * 三类是同一段对话的三个**抽象层次**（QUMem 原文的游泳例：加入游泳俱乐部 / 偏好氛围
 * 友好的游泳课 / 倾向选低压力的运动环境），三次调用各问一遍。2026-10-29 实例实测：
 * 不讲层次时同一句话常被三次调用各复述一遍（55 条里成对复述 50 余对），召回名额被
 * 同一件事占掉。所以 LAYER_RULES 把层次与「不要换个说法写成别类」写明；召回端另有
 * 同源复述去重（retrieve.ts isRestatement）兜底。
 *
 * 解析容错同 #228 的蒸馏：剥围栏 → 首个 `[` 到末个 `]` → JSON.parse → 逐条校验，
 * 任何一步失败返回空数组——坏输出提取不出东西，静默跳过，下段自然有新内容。
 */
import type { MemoryEpisodeTurn } from "../shared/memory.ts";
import type { MemoryDraft } from "./entries.ts";
/** 一次查询的预处理（coverageScore 的入参，这里不重复 tokenize 的定义）。 */
import { coverageScore, isRecallable, tokenize, type MemoryQuery } from "./retrieve.ts";
import type { MemoryEntry } from "../shared/memory.ts";

/** 每类最多提取的条数。提取是摘录不是转写——超过这个数说明这段该拆会话。 */
const ENTRY_LIMIT = 5;

/** 写法规则的公共段（AtomMem + Mandol），三类提示词共用。 */
const WRITING_RULES = `每条记忆必须：
- 自包含：不读原对话也能看懂；消解所有指代（它 / 那个 / 上面说的 → 具体名字）；
- 第三人称：称「用户」与「agent」，不用「我 / 你」；
- 时间绝对：「今天 / 明天 / 上周」按给出的当前日期换算成 YYYY-MM-DD 写进句子；
- 完整句：带日期、说话人、话题的陈述句，不是碎片短语；
- 只记将来对别的会话有用的；寒暄、客套、过程性闲聊不记；
- 不记关于本次对话机制本身的元讨论（对记忆系统、工具行为的议论）。`;

/** 三类的抽象层次（QUMem §3.3 的定义与原文例子），三类提示词共用。 */
const LAYER_RULES = `同一段对话会分三次各提取一类：事实、偏好、经验。三类是三个抽象层次，不是同一句话的三种说法：
- 事实：发生了什么（事件、行动、状态、已经落地的决定）；
- 偏好：用户在具体对象或场景上的选择、要求、约束，带理由；
- 经验：从具体的选择、反馈和理由里抽象出的决策原则，能用到别的对象或场景。
例：「用户加入了游泳俱乐部」是事实；「用户偏好氛围友好的游泳课」是偏好；「用户倾向选择低压力的运动环境」是经验。
这一次只写本类、本层次的内容。某个意思已经属于别的类，就不要换个说法写进本类；本类没有可写的就输出 []。`;

/**
 * agent 在这段对话里已经当场写下的条目（memory_revise 按用户纠正写的新说法）。不讲的话
 * 段收尾提取会把同一件事再写一遍——用户刚说「不对，汇报要求是……」，agent 改了一条，
 * 偏好提取又从同一句原话蒸出一条近义的，库里就两条。归一化文本去重拦不住换了措辞的。
 */
const RECORDED_RULE = `输入里可能带一节 <recorded>：agent 在这段对话里已经按用户的话当场记下的条目。它们已经在库里了——不要重复，也不要换个说法再写一条；同一件事没有别的新内容就跳过。`;

const OUTPUT_RULES = `只输出 JSON 数组，除此之外不要有任何输出：
[{"text": "……", "reason": "……", "keywords": ["……"], "turns": [2], "crossWorkspace": false}]
没有值得记的内容时输出 []。最多 ${ENTRY_LIMIT} 条。turns 是支撑这条记忆的轮号（输入里 <turn> 的 n，可多条）。keywords ≤8 个，术语优先，中英文都可。`;

export const FACT_SYSTEM_PROMPT = `你是记忆提取器。从一段用户与 agent 的对话事件里提取「事实」：发生过的事、做成的决定、确立的项目与环境情况。
只录对话里发生过 / 明确成立的，不推断、不猜动机、不总结方法论。
用户提出的要求、喜好、约束（「以后都要……」「我不喜欢……」）属于偏好，这里不记；只记它们以外发生了什么。
${RECORDED_RULE}
${LAYER_RULES}
${WRITING_RULES}
${OUTPUT_RULES}`;

export const PREFERENCE_SYSTEM_PROMPT = `你是记忆提取器。从一段用户与 agent 的对话事件里提取「偏好」：用户的选择、倾向、约束——喜欢怎么做、要求什么、排斥什么。
每条必须带 reason（为什么：用户的哪句话、什么情境表明了这一点），并把成立的场景写进 text（不默认永远成立）。
输入里可能带一节 <preferences>：这个工作区已有的旧偏好（各带 id）。若新条目与其中某条矛盾（用户改了主意、推翻了旧约束），给新条目加 "conflictsWith": "那条的id"——那条旧偏好会被直接标为过时、不再召回，所以只在用户确实改了主意时才加；只是相关、补充、重述都不算矛盾，拿不准就不加。没有 <preferences> 节时永远不加。
"crossWorkspace": true 表示这条偏好与当前项目无关、对用户所有工作区都成立（回复语言、沟通方式、汇报格式这类关于用户本人的习惯）；它会被直接记到所有工作区。和这个项目的代码、流程、工具相关的写 false；拿不准写 false。
只写具体对象或场景上的偏好；跨场景的一般原则属于经验，这里不写。
${RECORDED_RULE}
${LAYER_RULES}
${WRITING_RULES}
${OUTPUT_RULES}`;

export const INSIGHT_SYSTEM_PROMPT = `你是记忆提取器。从一段用户与 agent 的对话事件里提取「经验」：可迁移的做事原则——下次遇到类似情况该怎么做的结论（什么做法有效、什么坑别再踩）。
每条必须挂 reason（具体交互证据：这段对话里哪一轮的什么交互得出了它），凭空泛化的大道理不提。
经验必须比原话高一层：把用户的具体选择、反馈和理由抽象成能用到别的对象或场景的原则。只是把用户说的要求换个说法重复一遍不算经验——那是偏好；这一段抽不出更高一层的原则，就输出 []。
${RECORDED_RULE}
${LAYER_RULES}
${WRITING_RULES}
${OUTPUT_RULES}`;

/** 本地时区的 YYYY-MM-DD（相对时间换算的锚）。 */
export function formatDate(now: number): string {
  const date = new Date(now);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDateTime(at: number): string {
  const date = new Date(at);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${formatDate(at)} ${hours}:${minutes}`;
}

export interface ExtractPromptInput {
  turns: readonly MemoryEpisodeTurn[];
  now: number;
  /** 偏好的冲突候选（同作用域最相近的旧偏好）；仅偏好调用带 */
  candidates?: readonly MemoryEntry[];
  /** agent 在这段对话里已经当场写下的条目（agentRecordedIn 挑出来的）；三类都带 */
  recorded?: readonly MemoryEntry[];
}

/** 组提取调用的用户消息：日期锚 + agent 已记下的 + （偏好的）旧偏好候选 + 段内各轮快照。 */
export function buildExtractPrompt(input: ExtractPromptInput): string {
  const recorded =
    input.recorded !== undefined && input.recorded.length > 0
      ? `<recorded>\n${input.recorded.map((entry) => `- ${entry.text}`).join("\n")}\n</recorded>\n`
      : "";
  const preferences =
    input.candidates !== undefined && input.candidates.length > 0
      ? `<preferences>\n${input.candidates.map((entry) => `[${entry.id}] ${entry.text}`).join("\n")}\n</preferences>\n`
      : "";
  const turns = input.turns
    .map((turn) =>
      [
        `<turn n="${turn.turn}" at="${formatDateTime(turn.at)}">`,
        `<user>\n${turn.userText}\n</user>`,
        `<assistant>\n${turn.assistantText}\n</assistant>`,
        `</turn>`,
      ].join("\n"),
    )
    .join("\n");
  return `<date>${formatDate(input.now)}</date>\n${recorded}${preferences}${turns}`;
}

/**
 * 这段对话里 agent 当场写下的条目：source = agent、同会话、出处轮落在段内。被撤销
 * （muted）的也算——用户撤了说明那条不对，更不该被提取再写回来。
 */
export function agentRecordedIn(
  entries: readonly MemoryEntry[],
  episode: { sessionId: string; fromTurn: number; toTurn: number },
): MemoryEntry[] {
  return entries.filter(
    (entry) =>
      entry.source === "agent" &&
      entry.sessionId === episode.sessionId &&
      entry.turns.some((turn) => turn >= episode.fromTurn && turn <= episode.toTurn),
  );
}

/**
 * 模型回复 → 提取草稿。type 决定 reason 的硬性（偏好 / 经验没理由的条丢弃——
 * 契约的承诺）与 conflictsWith 的收留（只认候选表里的 id，模型幻觉一个 id 就会
 * 指空）。任何解析失败返回空数组。
 */
export function parseExtractReply(
  raw: string,
  type: "fact" | "preference" | "insight",
  candidateIds?: ReadonlySet<string>,
): MemoryDraft[] {
  const fenced = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const drafts: MemoryDraft[] = [];
  for (const item of parsed) {
    if (drafts.length >= ENTRY_LIMIT) break;
    if (typeof item !== "object" || item === null) continue;
    const suspect = item as {
      text?: unknown;
      reason?: unknown;
      keywords?: unknown;
      turns?: unknown;
      crossWorkspace?: unknown;
      conflictsWith?: unknown;
    };
    if (typeof suspect.text !== "string" || suspect.text.trim() === "") continue;
    const reason = typeof suspect.reason === "string" ? suspect.reason.trim() : "";
    // 偏好要理由、经验要依据（契约），缺席就不落这条
    if (type !== "fact" && reason === "") continue;
    const keywords = Array.isArray(suspect.keywords)
      ? suspect.keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "").slice(0, 8)
      : [];
    const turns = Array.isArray(suspect.turns)
      ? suspect.turns.filter((t): t is number => typeof t === "number" && Number.isInteger(t) && t >= 1)
      : [];
    if (turns.length === 0) continue; // 出处是承诺，没有支撑轮号的条不落
    // conflictsWith 只认候选表里的 id（#228 的纪律：幻觉 id 指向空气比没有建议更误导）
    const conflictWith =
      type === "preference" &&
      typeof suspect.conflictsWith === "string" &&
      (candidateIds?.has(suspect.conflictsWith) ?? false)
        ? suspect.conflictsWith
        : undefined;
    drafts.push({
      type,
      text: suspect.text.trim(),
      ...(reason !== "" ? { reason } : null),
      keywords,
      turns,
      // 跨工作区通用只对偏好生效（落盘时直接进 user 层，条目卡可撤）
      ...(type === "preference" && suspect.crossWorkspace === true ? { crossWorkspace: true } : null),
      ...(conflictWith !== undefined ? { conflictWith } : null),
    });
  }
  return drafts;
}

/**
 * 偏好的冲突候选：段全文对同作用域（+ user 层）的活偏好做覆盖度打分，取最像的
 * 几条给模型判「是否矛盾」。预算与 #228 的 memoryContext 同款：无字符预算（候选
 * 全文要进 prompt）、条数收紧（判矛盾是细活，堆多了稀释注意力）、阈值略降
 * （相撞的偏好必然同题，但表述可能换了主语）。
 */
export function preferenceCandidates(
  entries: readonly MemoryEntry[],
  episodeText: string,
): MemoryEntry[] {
  const query: MemoryQuery = { text: episodeText, tokens: new Set(tokenize(episodeText)) };
  return entries
    .filter((entry) => entry.type === "preference" && isRecallable(entry))
    .map((entry) => ({ entry, score: coverageScore(query, entry) }))
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .slice(0, 6)
    .map((candidate) => candidate.entry);
}
