/**
 * 导入 Proma 会话时还原「用户写了什么」—— 纯模块：不 import electron，`node --test` 直接测。
 *
 * ## 为什么要还原
 *
 * Proma 每条会话存两份（2026-09-24 调研，本机 687 条 pi 会话全都有）：
 *
 * | 文件 | 用户消息里是什么 |
 * |---|---|
 * | `agent-sessions/<id>.jsonl`（界面日志） | 用户原文，带 Proma 自己的标记（`@file:` 链接、`<quoted_context>`、`<attached_files>`、`/skill:xx`） |
 * | `sdk-config/sessions/*.jsonl`（pi 文件） | Proma 的 prompt builder 拼好的整段：`**当前时间…**`、`<workspace_state>`、`<working_directory>`、跨会话召回、展开成整份 SKILL.md 的 skill 调用…… 最后才是原文 |
 *
 * orbita 的 transcript 从 pi 文件派生，直接用就把拼进去的东西当成了用户的话——气泡、首页卡的
 * 最近提问、以后意图 / 记忆系统检索的 QA 全都带着噪声。**pi 副本不动**（那是模型当时真实
 * 读到的），只改显示用的 transcript。
 *
 * ## 两条路
 *
 * 1. **主路：界面日志。** 用户行按顺序与 pi 文件里的用户消息一一配对，**条数一致才用**。
 *    本机 2993 对里，条数一致的会话覆盖了绝大多数；配对后的原文就是 Proma 界面上显示的那句。
 * 2. **兜底：按 Proma 的拼接格式剥。** 条数对不上（本机 20 个会话）或没有界面日志时，剥掉开头
 *    的 skill 展开块（折回 `/skill:名字`）与动态上下文各段。单按格式剥能还原约 80% 的消息，
 *    所以它只做兜底。
 *
 * 两条路之后都把 `@file:<百分号编码的路径>` 解码成 `@<路径>`（wafo 2026-09-24：纯文本显示
 * 时可读，检索也能按路径命中）。`<quoted_context>` / `<attached_files>` 是用户自己组的内容，
 * 原样当纯文本（同日裁决）。
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "../../shared/session.ts";
import { parseClaudeRows } from "./claude-legacy.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 一条消息内容里的全部文本（字符串形态原样；块数组取 text 块，按换行拼）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block["type"] === "text" && typeof block["text"] === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 界面日志里的用户原文，按出现顺序。只收主对话里**有文本**的用户行——工具结果也是
 * `type: "user"`，但它没有 text 块，自然落空；子代理行 parseClaudeRows 已经剔掉。
 * 与 claude legacy 转换共用同一个行解析（同一份格式只解析一遍，不各写一个会漂的 parser）。
 */
export function promaUserTexts(renderLog: string): string[] {
  return parseClaudeRows(renderLog)
    .rows.filter((row) => row.type === "user")
    .map((row) => textOf(row.blocks))
    .filter((text) => text.trim() !== "");
}

/** Proma 的 buildDynamicContext 各段（agent-prompt-builder.ts）与跨会话召回块；段与段、段与原文之间都是一个空行。 */
const CONTEXT_SECTION =
  /^(?:\*\*当前时间: [^\n]*\*\*|<workspace_state>[\s\S]*?<\/workspace_state>|<working_directory>[\s\S]*?<\/working_directory>|<user_browser_context>[\s\S]*?<\/user_browser_context>|<user_vault_context>[\s\S]*?<\/user_vault_context>|<跨会话历史召回[^>]*>[\s\S]*?<\/跨会话历史召回>)\n\n/;

/** skill 调用在 pi 文件里展开成的块：`<skill name="x" location="…">…</skill>` 后接一个空行。 */
const SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\n\n/;

/**
 * 兜底：按 Proma 的拼接格式剥开头。skill 块折回 `/skill:名字`（用户当初打的就是这个），
 * 动态上下文各段直接丢。只剥**开头**连续出现的段——原文中间出现同名标签是用户自己写的。
 */
export function stripPromaEnvelope(text: string): string {
  const skills: string[] = [];
  let rest = text;
  for (;;) {
    const skill = SKILL_BLOCK.exec(rest);
    if (skill !== null) {
      skills.push(skill[1] ?? "");
      rest = rest.slice(skill[0].length);
      continue;
    }
    const section = CONTEXT_SECTION.exec(rest);
    if (section !== null) {
      rest = rest.slice(section[0].length);
      continue;
    }
    break;
  }
  if (skills.length === 0) return rest;
  const invocation = skills.map((name) => `/skill:${name}`).join(" ");
  return rest === "" ? invocation : `${invocation} ${rest}`;
}

/** `@file:%2FUsers%2F…` → `@/Users/…`。解码失败（坏编码）原样保留。 */
export function decodePromaMentions(text: string): string {
  return text.replace(/@file:(\S+)/g, (whole, encoded: string) => {
    try {
      return `@${decodeURIComponent(encoded)}`;
    } catch {
      return whole;
    }
  });
}

/**
 * pi 文件里每条用户消息（按文件顺序，含压缩前的）对应的原文，按 entry id 索引。
 * renderTexts = 界面日志的用户原文；null（没有界面日志）或条数对不上 → 全部走兜底。
 */
export function promaUserTextMap(
  entries: readonly SessionEntry[],
  renderTexts: readonly string[] | null,
): Map<string, string> {
  const users = entries.filter(
    (entry) => entry.type === "message" && isRecord(entry.message) && entry.message["role"] === "user",
  );
  const aligned = renderTexts !== null && renderTexts.length === users.length;
  const map = new Map<string, string>();
  users.forEach((entry, index) => {
    if (entry.type !== "message" || !isRecord(entry.message)) return;
    const original = aligned
      ? (renderTexts[index] ?? "")
      : stripPromaEnvelope(textOf((entry.message as Record<string, unknown>)["content"]));
    map.set(entry.id, decodePromaMentions(original));
  });
  return map;
}

/**
 * 把原文换进 transcript 的用户记录：第一个 text 块换成原文，其余 text 块去掉（原文已包含
 * 用户写的全部文字），图片块原样保留在原位。map 里没有的记录不动。
 */
export function withUserTexts(records: readonly SessionRecord[], texts: ReadonlyMap<string, string>): SessionRecord[] {
  return records.map((record) => {
    if (record.role !== "user") return record;
    const text = texts.get(record.id);
    if (text === undefined) return record;
    let placed = false;
    const content: UserBlock[] = [];
    for (const block of record.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      if (placed) continue;
      placed = true;
      if (text !== "") content.push({ type: "text", text });
    }
    if (!placed && text !== "") content.unshift({ type: "text", text });
    return { ...record, content };
  });
}

type UserBlock = Extract<SessionRecord, { role: "user" }>["content"][number];
