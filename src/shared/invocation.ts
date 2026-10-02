/**
 * `/skill:` 与 `/mcp:` 的指令式调用契约 —— IPC 四层的第 1 层（纯函数，主进程组装、
 * 显示端剥离共用）。
 *
 * skills 是渐进式披露的：索引（name + description）常驻 pi 的 system prompt，
 * 正文靠模型用 read 工具按需加载、以 tool result 的身份进上下文。用户显式点名时
 * **也不内联全文**（2026-10-02 用户裁决，参照 zcode 的 buildManualSkillPrompt）——
 * 内联等于替模型做了一次它自己会做的加载，还把上下文角色从 tool result 挪进
 * user message（压缩、前缀缓存、气泡显示全都跟着变形）。这里只做一件事：在用户
 * 原文**前面**加一段硬措辞的指令块，写明点名的 skill 与 SKILL.md 绝对路径、要求
 * 先 read 再干活；查不到 / 读不出的如实写明「不要假装加载」，不再拦下整条消息。
 *
 * MCP 同一机制：server 也是模型按 `mcp__<server>__<tool>` 名字调用的能力，
 * `/mcp:<server>` 点名后指令块里写明用这家的工具。
 *
 * **持久化存实际发给模型的文本**（指令块 + 原文）：pi 是无状态循环，每轮把历史喂
 * 回去，若只存原文、下一轮回放时再组装，这条消息的内容会变，打断 provider 的
 * 前缀缓存。显示端（气泡 / 标题 / 复制 / 回退放回输入框）用 stripInvocationBlock
 * 剥掉指令块，只给用户看他自己写的话。
 */

/** 两类点名 token：skill 读文件，mcp 用工具。 */
export type InvocationKind = "skill" | "mcp";

/**
 * 一次 `/skill:<target>` 或 `/mcp:<server>` 调用在原文里的位置。start 指向 `/`，
 * end 在 target 之后（下一个空白或文末）。**边界规则与输入框面板的触发判定
 * （slash-trigger.ts 的 slashTokenAt）是同一份语法**：`/` 的前一个字符必须是行首
 * 或空白（含全角空格）——两处各写一遍就会出现「面板认、发送不认」的裂缝。
 */
export interface InvocationToken {
  kind: InvocationKind;
  start: number;
  end: number;
  target: string;
}

const isBoundaryChar = (ch: string): boolean => /\s/.test(ch);

const TOKEN_PREFIXES: ReadonlyArray<{ kind: InvocationKind; prefix: string }> = [
  { kind: "skill", prefix: "/skill:" },
  { kind: "mcp", prefix: "/mcp:" },
];

/**
 * 扫出原文里全部 `/skill:<target>` 与 `/mcp:<server>`（任意位置、任意多条，按出现
 * 顺序）。target 是冒号后连续的非空白段，空 target 不算；不是这两个前缀的 `/xxx`
 * （如 `/compact`、路径）不在这里管。token 在原文里**原样保留**——指令块只追加在
 * 前面，不改动用户写的任何字符。
 */
export function findInvocationTokens(text: string): InvocationToken[] {
  const tokens: InvocationToken[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    if (i > 0 && !isBoundaryChar(text[i - 1] ?? "")) continue;
    for (const { kind, prefix } of TOKEN_PREFIXES) {
      if (!text.startsWith(prefix, i)) continue;
      let end = i + prefix.length;
      while (end < text.length && !isBoundaryChar(text[end] ?? "")) end++;
      if (end === i + prefix.length) break; // 空 target 不算 token
      tokens.push({ kind, start: i, end, target: text.slice(i + prefix.length, end) });
      break;
    }
  }
  return tokens;
}

/**
 * 指令块的包裹标签。显示端按它整体剥离（stripInvocationBlock），转录里它是
 * 「这段不是用户自己写的」的标记。名字取 mentioned：块里列的是用户在消息里
 * **点名**的 skill / server，存在的与不存在的都列。
 */
export const INVOCATION_OPEN = "<mentioned_tools>";
export const INVOCATION_CLOSE = "</mentioned_tools>";

/**
 * 一个被点名的 skill。命中且可读 → 给模型 read 的绝对路径；查不到（名字与链接
 * 都不中）或读不出（存储损坏）→ problem，指令里如实写明、不许模型假装加载。
 */
export type InvokedSkill =
  | { target: string; location: string }
  | { target: string; problem: "not-found" | "unreadable" };

/** 一个被点名的 MCP server。available = 主进程配置里存在且未禁用。 */
export interface InvokedMcp {
  target: string;
  available: boolean;
}

/** target 里可能带引号（用户手打的），显示时转义掉，别撑破引号包裹。 */
function quoted(target: string): string {
  return `"${target.replace(/"/g, '\\"')}"`;
}

function skillLine(skill: InvokedSkill): string {
  if ("location" in skill) {
    return (
      `- ${quoted(skill.target)} — read ${quoted(skill.location)} with the read tool BEFORE any other ` +
      "output or tool call in this turn, then follow the skill's instructions to fulfill the user's " +
      "request. Never claim to follow a skill you have not actually read."
    );
  }
  const reason =
    skill.problem === "not-found"
      ? "does not exist or is not linked to this session"
      : "was found but its SKILL.md could not be read (its storage may be corrupted)";
  return `- ${quoted(skill.target)} — ${reason}. Do not pretend to have loaded it; handle the request as written.`;
}

function mcpLine(server: InvokedMcp): string {
  if (server.available) {
    return (
      `- ${quoted(server.target)} — its tools are enabled for this session and appear in your tool list ` +
      `under the name mcp__${server.target}__<tool>. Use them where they fit the request; if they are ` +
      "missing from the list the server failed to start — say so instead of pretending to use it."
    );
  }
  return `- ${quoted(server.target)} — is not configured or is disabled. Do not pretend to use its tools; proceed without it.`;
}

/**
 * 原文 → 发给模型的整段：指令块在前，用户原文一字不动跟在后面。
 * skills 与 mcps 都为空时原文原样返回（调用方可以不预判有没有 token）。
 * 块内条目按调用方给的顺序排（主进程按首次出现去重后传入）。
 */
export function composeInvocationPrompt(
  text: string,
  skills: readonly InvokedSkill[],
  mcps: readonly InvokedMcp[],
): string {
  if (skills.length === 0 && mcps.length === 0) return text;
  const lines: string[] = [
    INVOCATION_OPEN,
    "The user explicitly invoked the items below in their message; each also appears inline as a " +
      "/skill:<name> or /mcp:<server> token in the text that follows.",
  ];
  if (skills.length > 0) {
    lines.push("", "Skills:");
    for (const skill of skills) lines.push(skillLine(skill));
  }
  if (mcps.length > 0) {
    lines.push("", "MCP servers:");
    for (const server of mcps) lines.push(mcpLine(server));
  }
  lines.push(INVOCATION_CLOSE);
  return `${lines.join("\n")}\n\n${text}`;
}

/**
 * 剥掉消息开头的指令块，还原用户自己写的话（显示 / 标题 / 复制 / 回退放回输入框
 * 都走这里）。没有块、或块不完整（用户自己手打了一个残缺的开标签）时原样返回——
 * 宁可不剥，也不吞内容。
 */
export function stripInvocationBlock(text: string): string {
  if (!text.startsWith(INVOCATION_OPEN)) return text;
  const close = text.indexOf(INVOCATION_CLOSE, INVOCATION_OPEN.length);
  if (close === -1) return text;
  const after = close + INVOCATION_CLOSE.length;
  // 组装时块与原文之间补的是 \n\n；对齐剥掉。旧数据或手打文本后接的不是空行时，
  // 吃掉紧随的换行即可（残余空白交给各消费方的 trim）。
  if (text.startsWith("\n\n", after)) return text.slice(after + 2);
  return text.slice(after).replace(/^\n/, "");
}
