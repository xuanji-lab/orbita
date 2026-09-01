/**
 * 工具结果的归位 + 信息区渲染单元的派生：摊平、分组、diff 解析、思考预览。
 *
 * **为什么要归位。** 协议里工具调用与工具结果是两条独立的记录：
 * 调用是 assistant 消息里的一个 `toolCall` 块，结果是一条 `role: "tool"` 的 item。
 * 照原样渲染就会得到两行——「调用了 ls」和「ls 的结果」——而设计系统要的是
 * 「工具调用折叠成一行、**点击才展开**」（readme *Chat*）。所以结果不单独占一行，
 * 它是那次调用展开后的内容。
 *
 * **为什么要摊平与分组。** 块数组才是真源，扁平列表态从它派生（guideline）；
 * agent 连续查阅 N 个文件时，pi 常把它切成多条消息（read→结果→read…），
 * 只有先摊平再对「相邻同类 toolCall」做 run-length 合并，「连续做同类事」
 * 才能收成一行——顺序即语义，隔着正文/思考的不合并。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */
import { diffWords } from "diff";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { CompactedRecord, SessionRecord } from "@shared/session";

/** toolCallId → 那次调用的结果。同一个 id 出现多次时以最后一条为准（终态帧在增量帧之后）。 */
export type ToolResultIndex = ReadonlyMap<string, ToolTranscriptItem>;

export function indexToolResults(transcript: readonly TranscriptItem[]): ToolResultIndex {
  const index = new Map<string, ToolTranscriptItem>();
  for (const item of transcript) {
    if (item.role === "tool") index.set(item.toolCallId, item);
  }
  return index;
}

/**
 * 渲染单元：records 摊平后的最小渲染单位。user 整条一个单元，assistant 按块拆，
 * 界碑自成单元。key 跨渲染稳定（`${item.id}:${blockIndex}`），折叠展开状态靠它保住。
 */
export type RenderUnit =
  | { kind: "user"; key: string; item: Extract<TranscriptItem, { role: "user" }> }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "toolCall"; key: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: "compacted"; key: string; record: CompactedRecord };

/** toolCall 单元的别名：分组函数的输入输出都说它。 */
export type ToolCallUnit = Extract<RenderUnit, { kind: "toolCall" }>;

/** 相邻同类 toolCall 的 run（≥2）。展开后组内每条仍是完整的 ToolLine——两层折叠契约。 */
export interface ToolGroupUnit {
  kind: "toolGroup";
  /** `group:${首成员 toolCallId}`：成员集合不变时 key 不变，组的展开状态得以保住 */
  key: string;
  toolName: string;
  calls: readonly ToolCallUnit[];
}

export type RenderEntry = RenderUnit | ToolGroupUnit;

/**
 * records → 渲染单元流。tool item 不产生单元——它的结果由 `indexToolResults`
 * 挂到调用行上（归位）。**代价写明白**：万一某条 tool 结果找不到对应的调用
 * （协议上不该发生，因为结果必然由一次调用产生），它就不会被显示。
 * 宁可如此，也不要为了兜这个不存在的情形，让正常路径多出一行冗余。
 */
export function flattenRenderUnits(records: readonly SessionRecord[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  for (const record of records) {
    if (record.role === "compacted") {
      units.push({ kind: "compacted", key: record.id, record });
      continue;
    }
    if (record.role === "tool") continue;
    if (record.role === "user") {
      units.push({ kind: "user", key: record.id, item: record });
      continue;
    }
    record.content.forEach((block, index) => {
      const key = `${record.id}:${index}`;
      if (block.type === "text") {
        units.push({ kind: "text", key, text: block.text });
      } else if (block.type === "thinking") {
        units.push({ kind: "thinking", key, text: block.thinking });
      } else if (block.type === "toolCall") {
        units.push({
          kind: "toolCall",
          key,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          input: block.input,
        });
      }
    });
  }
  return units;
}

/**
 * 相邻同类 toolCall 合并成组。**只合相邻**：任何非同类单元（正文、思考、用户、
 * 界碑、别的工具）都断开 run——隔着东西合并等于撒谎（顺序即语义）。
 * 单数不成组，原样放行，走普通 ToolLine。
 */
export function groupToolUnits(units: readonly RenderUnit[]): RenderEntry[] {
  const entries: RenderEntry[] = [];
  let run: ToolCallUnit[] = [];
  const flush = () => {
    const head = run[0];
    if (head === undefined) return;
    if (run.length === 1) {
      entries.push(head);
    } else {
      entries.push({
        kind: "toolGroup",
        key: `group:${head.toolCallId}`,
        toolName: head.toolName,
        calls: run,
      });
    }
    run = [];
  };
  for (const unit of units) {
    const head = run[0];
    if (unit.kind === "toolCall" && (head === undefined || head.toolName === unit.toolName)) {
      run.push(unit);
      continue;
    }
    flush();
    if (unit.kind === "toolCall") {
      run = [unit];
    } else {
      entries.push(unit);
    }
  }
  flush();
  return entries;
}

/** 组行的状态汇总：结果索引上数一遍，失败/进行中/完成各多少。 */
export interface ToolGroupStatus {
  total: number;
  failed: number;
  running: number;
  done: number;
}

export function toolGroupStatus(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
): ToolGroupStatus {
  let failed = 0;
  let running = 0;
  let done = 0;
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status === "running") running++;
    else if (result.status === "error") failed++;
    else done++;
  }
  return { total: calls.length, failed, running, done };
}

/**
 * 思考折叠行的预览：取**最后一个非空行**。流式时每来一行新思考就顶替上一行
 * （一行顶替一行的活尾刷新，增量由 pi 归约器直接送达，这里只管取行）；
 * 结束后同一规则——无跳变，展开看全文是另一条路。
 */
export function thinkingPreview(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== "") return line;
  }
  return "";
}

/**
 * 流式中的思考块 key（行首呼吸的判定）：本轮未结束、转录末条是 assistant、
 * 且它的**最后一块**是 thinking——流式中思考永远是最尾块，模型转去出正文或调
 * 工具时它就不再是最后一块，呼吸即停（状态变了就结束，不等整轮）。
 * 其余情况（idle、压缩中、末条是 user/tool/界碑、末块不是 thinking）都返回 null。
 */
export function streamingThinkingKey(
  records: readonly SessionRecord[],
  turnActive: boolean,
): string | null {
  if (!turnActive) return null;
  const last = records[records.length - 1];
  if (last === undefined || last.role !== "assistant") return null;
  const index = last.content.length - 1;
  const block = last.content[index];
  return block !== undefined && block.type === "thinking" ? `${last.id}:${index}` : null;
}

/** 思考时长格式：不足 1 秒按 1 秒；满一分钟说「N 分 M 秒」（中文界面，中文措辞）。 */
export function formatThinkingDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `持续了 ${seconds} 秒`;
  return `持续了 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 思考块的**现场计时**：块第一次被看到（active）时起表，落定那一刻冻结。
 * 落盘记录里没有块级时间戳，重开的旧会话量不到——返回 null，副标不显示。
 * 进行中返回 null（此时活尾预览在说话，秒数不抢戏）。
 */
const thinkingTimers = new Map<string, { start: number; end: number | null }>();

export function thinkingDurationText(
  key: string,
  active: boolean,
  now: number = Date.now(),
): string | null {
  let entry = thinkingTimers.get(key);
  if (active) {
    if (entry === undefined) {
      entry = { start: now, end: null };
      thinkingTimers.set(key, entry);
    }
    return null;
  }
  if (entry === undefined) return null;
  if (entry.end === null) entry.end = now;
  return formatThinkingDuration(entry.end - entry.start);
}

/** 折叠态那一行右侧的摘要：让人不展开也能大致知道发生了什么。 */
export function summarizeToolResult(result: ToolTranscriptItem | undefined): string | null {
  if (result === undefined) return null;
  if (result.status === "running") return "running";
  if (result.status === "error") return "failed";
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n")
    .trim();
  if (text === "") return "no output";
  const lines = text.split("\n").length;
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

/** 展开后要显示的正文。图片暂不渲染，只标记它存在——真正的图片渲染是后面的事。 */
export function toolResultText(result: ToolTranscriptItem): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
    .join("\n");
}

/**
 * 折叠行上工具名右边的参数摘要：`bash · git status`、`edit · src/app.ts`。
 * 字段名按 pi 工具 schema 的真名（bash→command，路径类→path，搜索类→pattern）；
 * 不认识的工具、input 不是对象、字段缺失或不是字符串，一律返回 null——
 * 摘要缺了不碍事，编造才碍事。
 */
export function toolCallSummary(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  switch (toolName) {
    case "bash":
      return str("command");
    case "read":
    case "write":
    case "edit":
      return str("path");
    case "grep":
    case "find":
    case "glob": {
      const pattern = str("pattern");
      if (pattern === null) return null;
      const path = str("path");
      return path === null || path === "." ? pattern : `${pattern} in ${path}`;
    }
    case "ls":
      return str("path") ?? ".";
    default:
      return null;
  }
}

/** diff 行的四种角色：增 / 删 / 头与块标记 / 上下文 */
export type DiffLineKind = "add" | "del" | "meta" | "ctx";

/** diff 渲染需要的一行：角色 + 新旧行号（add 只有新行号、del 只有旧行号）+ 剥掉前缀的正文。 */
export interface DiffRow {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** parseDiffLines 的产物：文件路径与增删统计从头行来，行体从 hunk 来。 */
export interface ParsedDiff {
  path: string | null;
  added: number;
  removed: number;
  rows: readonly DiffRow[];
}

/** `@@ -12,3 +13,4 @@`；count 缺省按 1（git 对单行 hunk 省略 `,1`）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `b/src/app.ts` → `src/app.ts`；不带 a//b// 前缀的（pi 自产 diff）原样返回。 */
function stripPathPrefix(header: string): string {
  const value = header.trim();
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/**
 * unified diff → 可渲染的行数组。文件头（`diff --git` / `---` / `+++`）只在
 * **第一个 hunk 之前**当头解析——进了 hunk 再出现 `--- x` 是「删掉一行 `-- x`」，
 * 提前按角色处理会吃掉它。行号从 `@@` 头起算：ctx 双进、del 旧进、add 新进；
 * `\ No newline` 是标记不是行，不推进计数。
 */
export function parseDiffLines(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let path: string | null = null;
  let oldPath: string | null = null;
  let sawHunk = false;
  let oldCtr = 0;
  let newCtr = 0;
  let added = 0;
  let removed = 0;
  const rows: DiffRow[] = [];
  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      sawHunk = true;
      oldCtr = Number(hunk[1]);
      newCtr = Number(hunk[3]);
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }
    if (!sawHunk) {
      if (line.startsWith("diff --git")) continue;
      if (line.startsWith("--- ")) {
        oldPath = stripPathPrefix(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        path = stripPathPrefix(line.slice(4));
        continue;
      }
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }
    // 进了 hunk 就是纯前缀分类：`--- x` 是「删掉一行 `-- x`」，
    // 不能再当文件头（文件头只在第一个 hunk 之前，上面已经消费掉了）
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine: newCtr++, text: line.slice(1) });
      added++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldCtr++, newLine: null, text: line.slice(1) });
      removed++;
    } else {
      rows.push({ kind: "ctx", oldLine: oldCtr++, newLine: newCtr++, text: line.slice(1) });
    }
  }
  // 新文件被删光时 `+++` 是 /dev/null，路径退回 `---` 那边
  if (path === null || path === "/dev/null") {
    path = oldPath !== null && oldPath !== "/dev/null" ? oldPath : path;
  }
  return { path, added, removed, rows };
}

/**
 * edit 落在 details 里的两份 diff 各司其职：
 * - `diff` 是 pi **专为展示生成**的格式（±标记 + 行号 + 正文，增/上下文带新文档行号），
 *   无文件头、无 @@ 头、无 `\ No newline` 标记——展开显示用它（`editDiffText` + `parseEditDiff`）。
 * - `patch` 是标准 unified diff（createTwoFilesPatch 产物）——折叠行的 +N/-M 统计用它数数。
 */
function editDetailField(result: ToolTranscriptItem, key: string): string | null {
  if (result.toolName !== "edit") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** edit 展开显示用的 pi 显示格式 diff；缺失返回 null——调用方退回原文展示 */
export function editDiffText(result: ToolTranscriptItem): string | null {
  return editDetailField(result, "diff");
}

/** edit 折叠行的增删统计（来自 details.patch）；没有 patch 返回 null */
export interface EditDiffStats {
  added: number;
  removed: number;
}

export function editDiffStats(result: ToolTranscriptItem): EditDiffStats | null {
  const patch = editDetailField(result, "patch");
  if (patch === null) return null;
  const { added, removed } = parseDiffLines(patch);
  return { added, removed };
}

/** pi 显示格式的一行：角色 + 行号（增/上下文带新文档行号、删带旧文档行号）+ 正文 */
export interface EditDiffRow {
  kind: "add" | "del" | "ctx";
  lineNum: string;
  text: string;
}

/** pi 的 diff.ts 同款行格式：「+123 内容」/「-123 内容」/「 123 内容」/ 跳段「   ...」 */
const EDIT_DIFF_LINE = /^([+\- ])(\s*\d*)\s(.*)$/;

/**
 * pi 显示格式 → 行数组。解析不了的行按 ctx 原样保留（跳段「...」就是这么进来的，
 * pi 对解析失败同样按上下文色渲染）；行号两侧空白剥掉。
 */
export function parseEditDiff(diff: string): EditDiffRow[] {
  const rows: EditDiffRow[] = [];
  for (const line of diff.split("\n")) {
    if (line === "") continue;
    const match = EDIT_DIFF_LINE.exec(line);
    if (match === null) {
      rows.push({ kind: "ctx", lineNum: "", text: line });
      continue;
    }
    const marker = match[1] ?? " ";
    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "ctx";
    rows.push({ kind, lineNum: (match[2] ?? "").trim(), text: match[3] ?? "" });
  }
  return rows;
}

/** 词级对比 token：changed 的片段是这行里真正变动的部分（pi 的 inverse 在 DOM 里的等价物） */
export interface IntraToken {
  text: string;
  changed: boolean;
}

export interface IntraLineTokens {
  removed: readonly IntraToken[];
  added: readonly IntraToken[];
}

/** 首个 changed token 的行首空白不算改动（pi 同款规则——缩进不该被高亮） */
function stripLeadingWhitespace(tokens: IntraToken[]): void {
  const first = tokens[0];
  if (first === undefined || !first.changed) return;
  const ws = /^\s*/.exec(first.text)?.[0] ?? "";
  if (ws === "") return;
  first.text = first.text.slice(ws.length);
  tokens.unshift({ text: ws, changed: false });
  if (first.text === "") tokens.splice(1, 1);
}

/** 单行修改的词级对比：diffWords 分词，删行与增行各得一组 token */
export function intraLineTokens(oldText: string, newText: string): IntraLineTokens {
  const removed: IntraToken[] = [];
  const added: IntraToken[] = [];
  for (const part of diffWords(oldText, newText)) {
    if (part.removed) removed.push({ text: part.value, changed: true });
    else if (part.added) added.push({ text: part.value, changed: true });
    else {
      removed.push({ text: part.value, changed: false });
      added.push({ text: part.value, changed: false });
    }
  }
  stripLeadingWhitespace(removed);
  stripLeadingWhitespace(added);
  return { removed, added };
}

/** DiffView 的渲染单元：普通行，或「单行修改」对（相邻的 1 删 + 1 增，pi 对它做词级对比） */
export type EditDiffEntry =
  | { kind: "row"; row: EditDiffRow }
  | { kind: "pair"; removed: EditDiffRow; added: EditDiffRow; tokens: IntraLineTokens };

/**
 * 行数组 → 渲染单元。只有「恰好 1 删 + 1 增」相邻才算单行修改做词级对比；
 * 多删多增按普通行逐行渲染（pi 的 diff.ts 同款判定）。
 */
export function editDiffEntries(rows: readonly EditDiffRow[]): EditDiffEntry[] {
  const entries: EditDiffEntry[] = [];
  let i = 0;
  while (i < rows.length) {
    const current = rows[i];
    if (current !== undefined && current.kind === "del") {
      let dels = 1;
      while (rows[i + dels]?.kind === "del") dels++;
      let adds = 0;
      while (rows[i + dels + adds]?.kind === "add") adds++;
      const added = rows[i + 1];
      if (dels === 1 && adds === 1 && added !== undefined) {
        entries.push({
          kind: "pair",
          removed: current,
          added,
          tokens: intraLineTokens(current.text, added.text),
        });
        i += 2;
        continue;
      }
    }
    if (current !== undefined) entries.push({ kind: "row", row: current });
    i++;
  }
  return entries;
}

/**
 * edit 组折叠头的文件数：按成员 input.path **字符串去重**（「./a.ts」与「a.ts」算两个，
 * 归一化不值得——同轮调用几乎总是一种写法），只数落定且非失败的（改成才算改）。
 * 复用 toolCallSummary 抽 path（edit 的摘要就是 path）。
 */
export function editGroupFileCount(
  calls: readonly ToolCallUnit[],
  results: ToolResultIndex,
): number | null {
  const paths = new Set<string>();
  for (const call of calls) {
    const result = results.get(call.toolCallId);
    if (result === undefined || result.status === "running" || result.status === "error") continue;
    const path = toolCallSummary("edit", call.input);
    if (path !== null) paths.add(path);
  }
  return paths.size > 0 ? paths.size : null;
}

/**
 * write 要写入的正文。**不在结果里**——pi 的 write 成功只回一行
 * `Successfully wrote N bytes to <path>`（details 也是 undefined），内容在调用入参里；
 * pi 自己的 TUI 也在调用阶段渲染正文。空串与缺字段返回 null（退回原文展示）。
 */
export function writeContent(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)["content"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 去掉尾部空行（pi 的 trimTrailingEmptyLines：写入正文末尾的换行不数成行） */
function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

/** write 折叠行的量词：写入了多少行。入参没正文时返回 null（摘要让位给状态词）。 */
export function writeLineCount(input: unknown): number | null {
  const content = writeContent(input);
  if (content === null) return null;
  return trimTrailingEmptyLines(content.split("\n")).length;
}

/** 工具行展开的「文件内容视图」参数。write 用入参正文；其余工具返回 null（原文展示）。 */
export interface FileViewInput {
  text: string;
  startLine: number;
}

export function fileViewFor(
  toolName: string,
  input: unknown,
  result: ToolTranscriptItem,
): FileViewInput | null {
  if (toolName === "write" && result.status !== "error") {
    const text = writeContent(input);
    return text === null ? null : { text, startLine: 1 };
  }
  return null;
}
