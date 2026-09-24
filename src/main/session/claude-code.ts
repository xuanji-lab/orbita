/**
 * Claude Code 会话文件的清洗 —— 纯模块：不 import electron、不碰文件系统，`node --test` 直接测。
 *
 * 源：`~/.claude/projects/<cwd 转义>/<sessionId>.jsonl`，命令行与 Claude 桌面应用共用。消息行
 * （type user / assistant）与 Proma Claude 时代的界面日志同一套形状——Anthropic Messages、
 * assistant 按 message.id 每块一行——所以这里只做清洗，产出 claude-legacy 的 `ClaudeMainRow`，
 * 转成 pi 消息走同一个 `claudeRowsToMessages`（配对审计、usage 换算都现成）。
 *
 * ## 源格式里要处理的东西（2026-09-25 本机 46 个会话文件调研）
 *
 * - **非消息行**占一半以上：attachment 6724、last-prompt、custom-title / ai-title、mode、
 *   system（turn_duration、stop_hook_summary、api_error……）、file-history-*。除了标题与排队消息，
 *   一律不进对话。
 * - **isSidechain**：会话开头的 Warmup 探针，不是对话。
 * - **isMeta 的用户行**（153）：粘贴图片的尺寸说明、skill 正文、本地命令的 Caveat、
 *   「Output token limit hit」续写提示。模型读到了，用户没写。
 * - **task-notification**（origin.kind，67 行）：后台任务结束时 Claude Code 以用户身份发给模型的通知。
 * - **排队消息**：agent 忙时用户打的字不写成用户行，写成 attachment（queued_command，
 *   commandMode = prompt，本机 29 条），在下一次工具结果时送给模型。它们是用户写的话，要收；
 *   commandMode = task-notification 的同样是通知。
 * - **isApiErrorMessage**：Claude Code 合成的「API Error: …」回复（model `<synthetic>`），不是模型说的。
 * - **parentUuid 树不是单链**：并行工具调用时，一条 assistant 行有两个孩子（下一个 tool_use 块与
 *   上一个的 tool_result，本机 102 处），所以不能「从最后一行沿 parentUuid 走回根」——会丢工具结果。
 *   这里按文件顺序收，只在「用户写的行的 parentUuid 跳回更早的行」时截断（回退重写 / 出错后重发，
 *   本机 11 处）。
 *
 * ## 两份产物
 *
 * 与 Proma 导入同一个裁决（2026-09-24）：**pi 里是模型当时读到的**（isMeta 注入、通知、打断标记、
 * 排队消息都在），**transcript 只显示用户写的**。`displays` 与 `rows` 对齐，给出每条用户行在
 * transcript 里的原文；null = 不显示。
 */
import type { ClaudeMainRow } from "./claude-legacy.ts";

export interface ClaudeCodeRowStats {
  badLines: number;
  /** 截断发生的次数（真的丢掉了已收的行才算） */
  rewinds: number;
  /** 收进来的排队消息（用户写的 + 通知） */
  queued: number;
  /** 丢掉的合成错误回复 */
  apiErrors: number;
}

export interface ClaudeCodeSession {
  /** 主对话当前分支上的行，顺序即对话顺序（排队消息已插到位） */
  rows: ClaudeMainRow[];
  /** 与 rows 对齐：user 行在 transcript 里的原文，null = 不显示；assistant 行恒为 null */
  displays: (string | null)[];
  /** 会话的工作目录：第一条消息行上的 cwd */
  cwd: string | null;
  /** 行里记的标题：最后一条 custom-title（用户改的），其次最后一条 ai-title */
  title: string | null;
  /** 第一条显示出来的用户原文（没有标题时的兜底） */
  firstPrompt: string | null;
  /** 第一条消息行的 uuid。桌面应用续接或分叉出的新文件会整段复制历史，与原文件共用它 */
  rootUuid: string | null;
  stats: ClaudeCodeRowStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rowTimestamp(obj: Record<string, unknown>): number {
  const iso = optionalString(obj["timestamp"]);
  if (iso === null) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 用户行的 content：字符串形态（Claude Code 的大多数用户行）包成一个 text 块。 */
function toBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block["type"] === "text" && typeof block["text"] === "string")
    .map((block) => block.text)
    .join("\n");
}

function hasBlock(blocks: readonly unknown[], type: string): boolean {
  return blocks.some((block) => isRecord(block) && block["type"] === type);
}

function originKind(obj: Record<string, unknown>): string | null {
  const origin = obj["origin"];
  return isRecord(origin) ? optionalString(origin["kind"]) : null;
}

/** 用户自己写的行：不是注入（isMeta）、不是工具结果、不是后台通知。回退截断只看这种行。 */
function isHumanRow(obj: Record<string, unknown>, blocks: readonly unknown[]): boolean {
  if (obj["isMeta"] === true || obj["toolUseResult"] !== undefined) return false;
  if (hasBlock(blocks, "tool_result")) return false;
  const kind = originKind(obj);
  return kind === null || kind === "human";
}

/**
 * Claude Code 自己生成、以用户身份出现的文字：打断标记、本地命令的输出与说明、后台通知、
 * 别的会话发来的消息（排队送达时没有 origin 可看，只能认开头）。
 */
const GENERATED_TEXT =
  /^\s*(?:\[Request interrupted by user|<local-command-(?:stdout|stderr|caveat)>|<task-notification>|<cross-session-message[\s>])/;

/**
 * 用户写的一段文字 → transcript 里显示的原文。null = 这不是用户写的，不显示。
 *
 * - `<command-name>/x</command-name>…<command-args>y</command-args>` → `/x y`（用户打的就是这个）
 * - 去掉 `<system-reminder>…</system-reminder>`（Claude Code 顺路塞进用户消息的提醒）
 * - `@"/a b/c.md"` → `@/a b/c.md`（Claude Code 给带空格的路径加引号；与 Proma 的 `@file:` 解码同一个
 *   落点：纯文本显示时可读，检索按路径命中）
 */
export function claudeCodeUserText(text: string): string | null {
  if (GENERATED_TEXT.test(text)) return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command !== null) {
    const name = (command[1] ?? "").trim();
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim();
    const invocation = name.startsWith("/") ? name : `/${name}`;
    return args === "" ? invocation : `${invocation} ${args}`;
  }
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/@"([^"\n]+)"/g, "@$1")
    .trim();
}

/** 一条用户行在 transcript 里的原文；null = 不显示。只有图片没有字的行显示为空串（图照留）。 */
function displayOf(obj: Record<string, unknown>, blocks: readonly unknown[]): string | null {
  if (!isHumanRow(obj, blocks)) return null;
  const text = claudeCodeUserText(textOfBlocks(blocks));
  if (text === null) return null;
  if (text === "" && !hasBlock(blocks, "image")) return null;
  return text;
}

function userRow(index: number, blocks: unknown[], timestamp: number): ClaudeMainRow {
  return {
    type: "user",
    groupId: `#line-${index}`,
    blocks,
    stopReason: undefined,
    usage: undefined,
    hasError: false,
    model: null,
    timestamp,
  };
}

interface Kept {
  /** 源文件里的行号（非空行计数）：回退截断按它比较 */
  line: number;
  row: ClaudeMainRow;
  display: string | null;
}

/** 这一行会不会成为一条 pi 用户消息（有字或有图）——排队消息要插在它前面。 */
function carriesUserContent(blocks: readonly unknown[]): boolean {
  return blocks.some(
    (block) =>
      isRecord(block) &&
      ((block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") || block["type"] === "image"),
  );
}

export function parseClaudeCodeSession(raw: string): ClaudeCodeSession {
  const stats: ClaudeCodeRowStats = { badLines: 0, rewinds: 0, queued: 0, apiErrors: 0 };
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let cwd: string | null = null;
  let rootUuid: string | null = null;
  let kept: Kept[] = [];
  /** 排队消息：等到下一条 assistant 或下一条用户消息之前再插，免得夹进并行工具结果中间 */
  let pending: Kept[] = [];
  /** 消息树的行（所有带 uuid 的非 sidechain 行）：uuid → 行号，以及最后一行的 uuid */
  const chain = { lineByUuid: new Map<string, number>(), lastUuid: null as string | null };

  const flush = (): void => {
    kept.push(...pending);
    pending = [];
  };

  let line = -1;
  for (const text of raw.split("\n")) {
    if (text.trim() === "") continue;
    line += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      stats.badLines += 1;
      continue;
    }
    if (!isRecord(obj)) {
      stats.badLines += 1;
      continue;
    }
    const type = obj["type"];
    if (type === "custom-title") {
      customTitle = optionalString(obj["customTitle"]) ?? customTitle;
      continue;
    }
    if (type === "ai-title") {
      aiTitle = optionalString(obj["aiTitle"]) ?? aiTitle;
      continue;
    }
    if (obj["isSidechain"] === true) continue;

    const uuid = optionalString(obj["uuid"]);
    const remember = (): void => {
      if (uuid === null) return;
      chain.lineByUuid.set(uuid, line);
      chain.lastUuid = uuid;
    };

    if (type === "attachment") {
      const attachment = isRecord(obj["attachment"]) ? obj["attachment"] : null;
      const prompt = attachment === null ? null : optionalString(attachment["prompt"]);
      if (attachment?.["type"] === "queued_command" && prompt !== null && prompt.trim() !== "") {
        const blocks = toBlocks(prompt);
        const human = attachment["commandMode"] === "prompt";
        const timestamp = rowTimestamp(obj) || rowTimestamp(attachment);
        pending.push({
          line,
          row: userRow(line, blocks, timestamp),
          display: human ? claudeCodeUserText(prompt) : null,
        });
        stats.queued += 1;
      }
      remember();
      continue;
    }
    if (type !== "user" && type !== "assistant") {
      remember();
      continue;
    }
    // 压缩摘要（历史全量保留，摘要重复）、只给界面看的行、合成的错误回复：都不是对话
    if (obj["isCompactSummary"] === true || obj["isVisibleInTranscriptOnly"] === true) {
      remember();
      continue;
    }
    if (obj["isApiErrorMessage"] === true) {
      stats.apiErrors += 1;
      remember();
      continue;
    }
    cwd ??= optionalString(obj["cwd"]);
    const message = isRecord(obj["message"]) ? obj["message"] : null;
    const timestamp = rowTimestamp(obj);

    if (type === "user") {
      const blocks = toBlocks(message?.["content"]);
      // 回退：用户写的行接在更早的一行后面 → 那一行之后收的全部作废（旧枝）
      const parent = obj["parentUuid"];
      if (isHumanRow(obj, blocks) && typeof parent === "string" && parent !== chain.lastUuid) {
        const at = chain.lineByUuid.get(parent);
        if (at !== undefined) {
          const before = kept.length + pending.length;
          kept = kept.filter((item) => item.line <= at);
          pending = pending.filter((item) => item.line <= at);
          if (kept.length + pending.length < before) stats.rewinds += 1;
        }
      }
      if (carriesUserContent(blocks)) flush();
      kept.push({ line, row: userRow(line, blocks, timestamp), display: displayOf(obj, blocks) });
    } else {
      flush();
      const model = optionalString(message?.["model"]);
      kept.push({
        line,
        row: {
          type: "assistant",
          groupId: optionalString(message?.["id"]) ?? `#line-${line}`,
          blocks: message?.["content"],
          stopReason: message?.["stop_reason"],
          usage: message?.["usage"],
          hasError: isRecord(obj["error"]),
          model: model === "<synthetic>" ? null : model,
          timestamp,
        },
        display: null,
      });
    }
    rootUuid ??= uuid;
    remember();
  }
  flush();

  const displays = kept.map((item) => item.display);
  return {
    rows: kept.map((item) => item.row),
    displays,
    cwd,
    title: customTitle ?? aiTitle,
    firstPrompt: displays.find((display): display is string => display !== null && display.trim() !== "") ?? null,
    rootUuid,
    stats,
  };
}

/**
 * 文件开头一段里第一条消息行的 uuid（判断「是不是某个文件的续接 / 分叉」用，不必整份解析）。
 * 最后一行可能被截断，解析失败的行跳过；这一段里没有消息行返回 null，调用方再读整份。
 */
export function claudeCodeRootUuid(head: string): string | null {
  for (const text of head.split("\n")) {
    if (text.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(obj) || obj["isSidechain"] === true) continue;
    if (obj["type"] !== "user" && obj["type"] !== "assistant") continue;
    if (obj["isApiErrorMessage"] === true || obj["isCompactSummary"] === true || obj["isVisibleInTranscriptOnly"] === true) continue;
    const uuid = optionalString(obj["uuid"]);
    if (uuid !== null) return uuid;
  }
  return null;
}

/**
 * Claude 桌面应用的会话清单里的一条（`claude-code-sessions/<账户>/<组织>/local_*.json`）。
 * 桌面应用每次续接旧会话都另起一个 Claude Code 文件、把历史整段复制过去；清单只指向最新的那个，
 * 旧文件列在 priorCliSessionIds 里——界面上始终是一条会话。
 */
export interface ClaudeDesktopSession {
  /** 当前的 Claude Code 会话 id（= projects 下的文件名） */
  cliSessionId: string;
  /** 被续接取代的旧文件 */
  priorCliSessionIds: string[];
  /** 桌面应用里显示的标题 */
  title: string | null;
  createdAt: number | null;
  /** 会话的项目目录：originCwd（在 worktree 里跑的会话是仓库根）优先，其次 cwd */
  folder: string | null;
}

/** 解析一条清单；缺 cliSessionId 或坏文件返回 null（调用方跳过，文件照常按命令行会话处理）。 */
export function parseClaudeDesktopSession(raw: string): ClaudeDesktopSession | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  const cliSessionId = optionalString(obj["cliSessionId"]);
  if (cliSessionId === null) return null;
  const prior = obj["priorCliSessionIds"];
  const createdAt = obj["createdAt"];
  return {
    cliSessionId,
    priorCliSessionIds: Array.isArray(prior) ? prior.filter((id): id is string => typeof id === "string" && id !== "") : [],
    title: optionalString(obj["title"])?.trim() || null,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : null,
    folder: optionalString(obj["originCwd"]) ?? optionalString(obj["cwd"]),
  };
}
