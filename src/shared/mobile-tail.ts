/**
 * 会话转录的尾部 → 手机上的条目（`TailEntry`）与「agent 最近一句」。
 *
 * 手机一屏只放得下「谁说了什么、中间干了多少活」：一条用户消息一条、一段 agent 说的话一条、
 * 一串连着的工具调用折成一条「过程」（做了几步、几步没成）。压缩界碑、轮尾文件账、回退与撤销、
 * 通道标记、意图召回卡都不给——它们是桌面上的结构件，离开桌面没有可点的地方。
 *
 * 为什么不复用 `src/agent/transcript-adapter.ts`：那是 agent 进程里把内核事件流翻成转录协议的
 * 适配器，依赖内核的类型，主进程引不进；这里是从**已经落盘的转录**往手机形状折，另写一个小映射。
 *
 * 纯模块：不 import electron / node，可被 `node --test` 直接加载。
 */
import {
  MOBILE_LAST_LINE_MAX,
  MOBILE_TAIL_PAGE,
  MOBILE_TAIL_PAGE_MAX_BYTES,
  type TailEntry,
} from "./mobile.ts";
import { stripInvocationBlock } from "./invocation.ts";
import { splitUserTextBlocks } from "./prompt-attachments.ts";
import { withoutQuotes } from "./quote.ts";
import { parseSkillSegments } from "./skill.ts";
import type { SessionRecord } from "./session.ts";

/**
 * 读不了的消息记录：user / assistant 却没有数组 `content`。
 *
 * 转录文件是外部输入：`parseLogLine` 只拒非对象行，长着消息的脸、却没有 `content` 的行照样放行
 * （2026-11-25 审查 S3 实测；手改、旧版本、导入都可能留下），`SessionRecord` 的类型在这里说了谎。
 * 以前一碰 `.content` 就是 TypeError，一条坏记录能让手机的整张清单一直回 internal。折条目与取最近一句
 * 都当没有这条；`malformedMessageCount` 把它们数出来，调用方记一次日志。
 */
function isMalformedMessage(record: SessionRecord): boolean {
  return (record.role === "user" || record.role === "assistant") && !Array.isArray(record.content);
}

/** 这段尾部里有几条读不了的消息记录 */
export function malformedMessageCount(records: readonly SessionRecord[]): number {
  let count = 0;
  for (const record of records) {
    if (isMalformedMessage(record)) count += 1;
  }
  return count;
}

/** content 里的一块，只认它自己说是什么（`type` / `text` 用之前都再判一次），混了非对象的那块不要 */
interface LooseBlock {
  type?: unknown;
  text?: unknown;
}

function blocksOf(content: unknown): LooseBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is LooseBlock => typeof block === "object" && block !== null);
}

/** 单条文字的上限（UTF-8 字节）。超过就截断——一条回答再长也不该占满整页 */
export const MOBILE_TAIL_TEXT_MAX_BYTES = 32 * 1024;

/** 截断时接在后面的说明：手机上翻不到被截掉的那一截，得说一声去哪看 */
const TRUNCATED_NOTE = "\n\n…（这条太长，手机上只显示开头；完整内容在电脑上看）";

export function tailEntriesOf(records: readonly SessionRecord[]): TailEntry[] {
  const entries: TailEntry[] = [];
  let process: { steps: number; failed: number; id: string; at: number } | null = null;
  const closeProcess = (): void => {
    if (process === null) return;
    entries.push({ id: process.id, at: process.at, kind: "process", steps: process.steps, failed: process.failed });
    process = null;
  };
  for (const record of records) {
    // 坏记录当没有这条：不打断正在进行的过程，也不产出一条没有 id 的条目
    if (isMalformedMessage(record)) continue;
    if (record.role === "tool") {
      if (process === null) process = { steps: 0, failed: 0, id: record.id, at: record.timestamp };
      process.steps += 1;
      if (record.isError) process.failed += 1;
      // id 与时刻取这一串的最后一条：以它做翻页锚点时，它之前的条目正好是这一串之前的
      process.id = record.id;
      process.at = record.timestamp;
      continue;
    }
    if (record.role === "assistant") {
      const text = spokenText(blocksOf(record.content));
      // 只有思考或只有工具调用、没说话的回答不打断过程（否则一段思考把一次干活切成两截）
      if (text === null) continue;
      closeProcess();
      entries.push({ id: record.id, at: record.timestamp, kind: "assistant", text: clipText(text) });
      continue;
    }
    // 其余记录（用户消息与各种界碑）都是结构边界：先收掉正在进行的过程
    closeProcess();
    if (record.role !== "user") continue;
    const blocks = blocksOf(record.content);
    const text = userVisibleText(blocks);
    const images = blocks.filter((block) => block.type === "image").length;
    entries.push({
      id: record.id,
      at: record.timestamp,
      kind: "user",
      ...(text === null ? {} : { text: clipText(text) }),
      ...(images > 0 ? { images } : {}),
    });
  }
  closeProcess();
  return entries;
}

/** assistant 说了的话：文字块拼起来。一个字都没有（只有思考 / 工具调用 / 空 error / 坏记录）返回 null */
function spokenText(content: readonly LooseBlock[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join("\n\n").trim();
  return text === "" ? null : text;
}

/**
 * 用户自己打的那部分：与标题的取法同一套剥离（`/skill:` 指令块、旧 `<skill>` 块、引用块、
 * 粘贴与文件附件块）。引用的原文与附件全文是给模型看的，手机上没有可点的入口。
 */
function userVisibleText(content: readonly LooseBlock[]): string | null {
  const joined = content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n\n");
  if (joined === "") return null;
  const invocationStripped = stripInvocationBlock(joined);
  const segments = parseSkillSegments(invocationStripped);
  const skillStripped =
    segments === null
      ? invocationStripped
      : segments
          .filter((segment) => segment.kind === "text")
          .map((segment) => (segment.kind === "text" ? segment.text : ""))
          .join("\n\n");
  const body = splitUserTextBlocks([withoutQuotes(skillStripped)]).body.trim();
  return body === "" ? null : body;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 超过单条上限的文字按字符边界截断，并接一句说明 */
function clipText(text: string): string {
  const budget = MOBILE_TAIL_TEXT_MAX_BYTES - byteLength(TRUNCATED_NOTE);
  if (byteLength(text) <= MOBILE_TAIL_TEXT_MAX_BYTES) return text;
  const chars = [...text];
  let length = 0;
  let end = 0;
  while (end < chars.length) {
    const size = byteLength(chars[end] ?? "");
    if (length + size > budget) break;
    length += size;
    end += 1;
  }
  return `${chars.slice(0, end).join("")}${TRUNCATED_NOTE}`;
}

/**
 * agent 最近一句的首行，最多 120 个字符。从尾往前找第一条说了话的回答。
 * 正在流式输出的那一条还没落盘，所以这里会比桌面晚到那条回答结束；手机上看流式，以后再说。
 */
export function lastAssistantLineOf(records: readonly SessionRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record === undefined || isMalformedMessage(record) || record.role !== "assistant") continue;
    const text = spokenText(blocksOf(record.content));
    if (text === null) continue;
    return firstLine(text, MOBILE_LAST_LINE_MAX);
  }
  return null;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}

/**
 * 尾部的一页：从尾往前取，至多 `MOBILE_TAIL_PAGE` 条、`MOBILE_TAIL_PAGE_MAX_BYTES` 字节。
 *
 * - 不给 `before`：整段的最后一页；`hasMore` = 这页之前还有条目。
 * - 给了 `before`（上一页第一条的 id）：它之前的那一页；锚点不在这一段里返回 null，调用方接着往更早的
 *   记录里找（或回 not_found）。
 */
export function tailPageOf(
  entries: readonly TailEntry[],
  before: string | undefined,
): { entries: TailEntry[]; hasMore: boolean } | null {
  let end = entries.length;
  if (before !== undefined) {
    end = entries.findIndex((entry) => entry.id === before);
    if (end < 0) return null;
  }
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < MOBILE_TAIL_PAGE) {
    const size = byteLength(JSON.stringify(entries[start - 1]));
    // 最尾那一条无论如何都要给（它自己已被单条上限夹住）；再往前加一条就超页时停
    if (start < end && bytes + size > MOBILE_TAIL_PAGE_MAX_BYTES) break;
    bytes += size;
    start -= 1;
  }
  return { entries: entries.slice(start, end), hasMore: start > 0 };
}
