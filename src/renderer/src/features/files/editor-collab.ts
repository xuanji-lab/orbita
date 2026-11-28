/**
 * 人和 agent 同时改同一个文件的**纯逻辑**：本轮 agent 写了哪些文件、盘上改成了哪几块、
 * 每一块还能不能撤。
 *
 * 独立成模块的理由同 editor-state.ts：TexEditorPane 连着 CodeMirror 与 IPC，
 * `node --test` 加载不了；这里全是输入 → 输出，直接可测。
 *
 * 词义（与 editor-state.ts 的「基线 / 脏 / 冲突」不重叠）：
 * - **本轮**：最后一条 user 消息之后到现在。agent 的工具调用只在这一段里找——上一轮
 *   中断留下的、没有结果的调用不会让一个文件永远只读。
 * - **写入集**：本轮 `write` / `edit` 碰过的路径。有结果 = 写完（done），没结果 =
 *   正在写（writing）。两个状态都让编辑器只读：agent 一轮里第二次写同一个文件时，
 *   用户手里的那一版已经不是它读到的那一版。
 * - **改动块 hunk**：盘上前后两份文本的行级差异，每块带上下文行。撤销 = 把「现在的
 *   那一块」换回「改动前的那一块」；现在的文字里找不到它，说明用户自己改过这一块，
 *   **不可撤**（这是唯一可靠的区分方式：比行号稳，行号会因别处的编辑整体平移）。
 *
 * 路径解析与 pi 的 resolveToCwd 同义（相对路径按会话 cwd 拼、绝对路径原样），但不认识
 * `~`——renderer 不知道家目录，宁可不认这个文件，也不要拿一个猜出来的路径比对。
 */
import { structuredPatch } from "diff";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { parseQualifiedToolName } from "../../../../shared/mcp.ts";
import { samePath } from "../../../../shared/path.ts";

/** 会写盘的内建工具（pi 0.84.3 的 createAllToolDefinitions：只有这两个直接改文件） */
const FILE_WRITE_TOOLS: readonly string[] = ["write", "edit"];

/**
 * **可能**写文件的工具：它们不告诉我们写了哪个文件（shell 里一行重定向、终端里一条
 * 命令、MCP 服务自己决定改什么），但一轮里出现任何一个，就得把本轮打开的项目文件当成
 * 「可能被写」——按 P0 的代价权衡：宁可多锁一轮，不能丢字。
 *
 * 名单只放真能落盘的：bash / powershell（pi 内建）、terminal_execute（终端工具里唯一
 * 会敲命令的）、以及所有 MCP 工具（服务端行为不可知）。
 */
const RISKY_TOOLS: readonly string[] = ["bash", "powershell", "terminal_execute"];

/** 这个工具名是否「可能写文件」：shell / 终端执行 / 任一 MCP 工具 */
export function isPossibleWriteTool(toolName: string): boolean {
  if (RISKY_TOOLS.includes(toolName)) return true;
  return parseQualifiedToolName(toolName) !== null;
}

/** agent 对某个文件的写入状态：正在写 / 本轮写过（已落定） */
export type AgentWritePhase = "writing" | "done";

export interface AgentWrite {
  /** 解析后的绝对路径（分隔符已归一成 `/`，Windows 盘符保留原样） */
  path: string;
  phase: AgentWritePhase;
}

/** 把路径的分隔符、`.` / `..` 归一；保留盘符与根（UNC 的 `//` 也保留） */
function normalizePath(value: string): string {
  const drive = /^[a-zA-Z]:/.exec(value)?.[0] ?? "";
  const rest = value.slice(drive.length);
  const unc = drive === "" && /^[\\/]{2}/.test(rest);
  const rooted = drive === "" && /^[\\/]/.test(rest);
  const parts: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const body = parts.join("/");
  if (drive !== "") return `${drive}/${body}`;
  if (unc) return `//${body}`;
  return rooted ? `/${body}` : body;
}

/**
 * 工具入参里的路径 → 绝对路径。三种写法都认（与 pi 的 resolveToCwd 同义）：
 * 绝对（`C:\a\b`、`//server/share`、`/a/b`）、相对（按 cwd 拼）、带盘符相对（`C:b`）。
 * `~` 开头的返回 null：renderer 拿不到家目录，不猜。
 */
export function resolveToolPath(raw: string, cwd: string | null): string | null {
  const value = raw.trim();
  if (value === "" || value.startsWith("~")) return null;
  const absolute =
    /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value) || /^[\\/]/.test(value);
  if (absolute) return normalizePath(value);
  if (cwd === null || cwd.trim() === "") return null;
  return normalizePath(`${cwd}/${value}`);
}

/** 工具入参里的 path 字段（不是字符串 / 没有这个字段 → null） */
function inputPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)["path"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 本轮从哪一条开始（最后一条 user 消息的下标）；没有 user 消息返回 -1 */
function turnStart(transcript: readonly TranscriptItem[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") return index;
  }
  return -1;
}

/**
 * 本轮 agent 对文件的写入集（按出现顺序）。同一个文件本轮写了两次只留一条：
 * 第二次调用开始后它又回到 writing——上一份 after 已经不是它手里的底本。
 *
 * `from` 是**回合起点**（开轮那一刻 transcript 的长度）。必须用它而不是「最后一条
 * user 消息」：真回显比 phase 事件晚到几十毫秒，按最后一条 user 消息取会把上一轮的
 * 工具调用算进这一轮，开轮一瞬间整片误只读。`from` 缺席（面板在回合中途才挂上）
 * 才退回最后一条 user 消息。
 */
export function agentWritesInTurn(
  transcript: readonly TranscriptItem[],
  cwd: string | null,
  from?: number,
): AgentWrite[] {
  const start = from !== undefined && from >= 0 && from <= transcript.length ? from : turnStart(transcript);
  if (start < 0) return [];
  /** toolCallId → 这份调用的绝对路径（结果按 id 对回来） */
  const callPaths = new Map<string, string>();
  const order: string[] = [];
  const phase = new Map<string, AgentWritePhase>();
  for (let index = start; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item === undefined) continue;
    if (item.role === "assistant") {
      for (const block of item.content) {
        if (block.type !== "toolCall") continue;
        if (!FILE_WRITE_TOOLS.includes(block.toolName)) continue;
        const raw = inputPath(block.input);
        if (raw === null) continue;
        const path = resolveToolPath(raw, cwd);
        if (path === null) continue;
        callPaths.set(block.toolCallId, path);
        if (!phase.has(path)) order.push(path);
        phase.set(path, "writing");
      }
      continue;
    }
    if (item.role !== "tool") continue;
    const path = callPaths.get(item.toolCallId);
    // 工具报错也算落定：它没写成，但也不会再写了——继续只读是假的保护
    if (path !== undefined) phase.set(path, "done");
  }
  return order.map((path) => ({ path, phase: phase.get(path) ?? "done" }));
}

/** 写入集里查一个文件的阶段（路径比较走 samePath：树里拼的是 `/`，主进程给的是 `\`） */
export function writePhaseOf(
  writes: readonly AgentWrite[],
  path: string,
): AgentWritePhase | null {
  for (const write of writes) {
    if (samePath(write.path, path)) return write.phase;
  }
  return null;
}

/**
 * 盘上的一处改动。`before` / `after` 都**带上下文行**（默认上下各 3 行）：
 * 撤销时用 `after` 在现在的文档里定位，换成 `before`——上下文是定位的锚，
 * 也是「用户有没有手改过这一块」的判据。
 */
export interface EditorHunk {
  /** 同一份快照里的稳定标识（oldStart:newStart:±） */
  id: string;
  /** 这块在改动后文本里的起始行（1 起，含上下文）；并列候选按它取最近 */
  anchorLine: number;
  added: number;
  removed: number;
  /** 改动前的行（上下文 + 被删的行） */
  before: readonly string[];
  /** 改动后的行（上下文 + 新增的行） */
  after: readonly string[];
  /**
   * 新增行在 `after` 里的位置（`line` 是 `after` 的下标，0 起；连续的多行合成一段）。
   * 编辑器只用它给「agent 新加的字」铺底色——上下文行不该被涂成改动。
   */
  addedSpans: readonly { line: number; count: number }[];
  /** 一行预览：优先第一行新增内容，没有新增就取第一行被删的 */
  preview: string;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** 行级差异 → 改动块。两份文本都按 LF 口径切（编辑器内部恒为 `\n`）。 */
export function diffHunks(beforeText: string, afterText: string, context = 3): EditorHunk[] {
  const beforeDoc = splitLines(beforeText);
  const afterDoc = splitLines(afterText);
  if (beforeText === afterText) return [];
  const patch = structuredPatch(
    "before",
    "after",
    beforeDoc.join("\n"),
    afterDoc.join("\n"),
    undefined,
    undefined,
    { context },
  );
  const hunks: EditorHunk[] = [];
  patch.hunks.forEach((hunk, index) => {
    const before: string[] = [];
    const after: string[] = [];
    const addedSpans: { line: number; count: number }[] = [];
    let added = 0;
    let removed = 0;
    let firstAdded = "";
    let firstRemoved = "";
    for (const line of hunk.lines) {
      // `\ No newline at end of file`：差异标记不是内容。只剩这个标记的块是
      // 「末尾换行有无」的差异，before / after 内容相同，下面会整块丢掉
      if (line.startsWith("\\")) continue;
      const marker = line.slice(0, 1);
      const text = line.slice(1);
      if (marker === "+") {
        after.push(text);
        added += 1;
        if (firstAdded === "") firstAdded = text;
        const last = addedSpans[addedSpans.length - 1];
        if (last !== undefined && last.line + last.count === after.length - 1) last.count += 1;
        else addedSpans.push({ line: after.length - 1, count: 1 });
      } else if (marker === "-") {
        before.push(text);
        removed += 1;
        if (firstRemoved === "") firstRemoved = text;
      } else {
        before.push(text);
        after.push(text);
      }
    }
    // 只差末尾换行（"No newline at end of file" 那对 -/+）内容其实一样：
    // 这种块撤了等于没撤，整块丢掉
    if (added === 0 && removed === 0) return;
    if (before.join("\n") === after.join("\n")) return;
    const preview = (firstAdded !== "" ? firstAdded : firstRemoved).trim();
    hunks.push({
      id: `${hunk.oldStart}:${hunk.newStart}:${index}`,
      anchorLine: hunk.newStart,
      added,
      removed,
      before,
      after,
      addedSpans,
      preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
    });
  });
  return hunks;
}

/**
 * 在现在的文档里找一块。返回 0 起的行区间 `[start, end)`；找不到 = 用户改过这块
 * （或整块被删），调用方要如实标成「不可撤销」。
 *
 * 多处命中时取离 `anchorLine` 最近的一处——用户在上面插了几行不该让这块失效；
 * 最近的两处一样近（真的分不清）就返回 null：宁可不可撤，也不撤错地方。
 */
export function locateBlock(
  lines: readonly string[],
  block: readonly string[],
  anchorLine: number | null = null,
): { start: number; end: number } | null {
  if (block.length === 0) return null;
  const hits: number[] = [];
  for (let start = 0; start + block.length <= lines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[start + offset] !== block[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(start);
  }
  const first = hits[0];
  if (first === undefined) return null;
  if (hits.length === 1) return { start: first, end: first + block.length };
  const target = anchorLine === null ? 0 : Math.max(0, anchorLine - 1);
  const sorted = [...hits].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  const best = sorted[0];
  const second = sorted[1];
  if (best === undefined || second === undefined) return null;
  if (Math.abs(best - target) === Math.abs(second - target)) return null;
  return { start: best, end: best + block.length };
}

/** 从磁盘静默重载后光标落在哪一行：原来那一行（越过末尾就贴到末行） */
export function clampCursorLine(line: number, lineCount: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(1, Math.trunc(line)), Math.max(1, lineCount));
}

/**
 * 回合落定时怎么处理盘上的新内容。四种结局的取舍都写在这里，编辑器只执行：
 * - nothing：没有交错要处理（盘上还是基线，也没有「agent 写过 + 用户手里有字」）
 * - wait：用户还没裁决上一处冲突——不替他改状态，冲突条留着
 * - keep：只挂冲突条，**一个字都不写**（用户的字优先，由用户选写回还是丢弃）
 * - reload：编辑器干净且用户本轮没动过 → 静默重载到盘上那一份
 *
 * 为什么 keep 不能只看「盘上变没变」：agent 用 `write` 把它读到的原样写回去时，盘上内容
 * 与基线**一模一样**（用户的字只在内存里）。只看 diskChanged 会走 nothing，随后被暂停
 * 的自动保存补存用户的版本——agent 的那一次写就被无声取代了。所以「本轮 agent 碰过这个
 * 文件 + 用户手里有字」本身就是一种冲突：**给用户看，让他选**。
 */
export type SyncDecision = "nothing" | "wait" | "keep" | "reload";

export function syncDecision(input: {
  diskChanged: boolean;
  conflicted: boolean;
  dirty: boolean;
  /**
   * 本轮里用户动过这个编辑器（用户事务，不是「落定那一刻脏不脏」）。P0 那道口子就在这里：
   * 自动保存可能在回合中把用户的字写下去、随后被 agent 的写覆盖，落定那一刻文档是「干净」
   * 的——只看 dirty 会静默重载，把用户的字冲掉。动过就按「不覆盖」处理。
   */
  editedThisTurn: boolean;
  /**
   * 本轮 agent 的 `write` / `edit` 碰过这个文件（正在写或写完了）。它让「盘上没变」也
   * 构不成「没发生什么事」：agent 写的那一版可能恰好与基线相同。
   */
  agentTouched: boolean;
}): SyncDecision {
  const userHoldsText = input.dirty || input.editedThisTurn;
  if (!input.diskChanged && !(input.agentTouched && userHoldsText)) return "nothing";
  if (input.conflicted) return "wait";
  if (userHoldsText) return "keep";
  return "reload";
}

/**
 * 冲突条上那句话说的是哪种冲突：
 * - disk：盘上内容与编辑器基线不同（外部改过 / agent 写了别的版本）
 * - agent：agent 本轮写过这个文件，用户手里还有没落盘的字——盘上可能一字未变
 */
export type ConflictKind = "disk" | "agent";

/**
 * 一次撤销要 dispatch 的多处改动：**按位置排序并丢掉重叠的那些**。
 *
 * CodeMirror 对同一批 changes 要求互不重叠，否则整次 dispatch 抛
 * `Overlapping ranges`——而定位是**按内容**做的，用户手动编辑过之后两块可能落到
 * 同一段文字上。重叠的后一块这一轮不撤（调用方把它的 id 标成不可撤），
 * 好过整个「全部撤销」失败。
 */
export function nonOverlappingChanges<T extends { from: number; to: number }>(
  items: readonly T[],
): { keep: T[]; dropped: T[] } {
  const sorted = [...items].sort((a, b) => a.from - b.from || a.to - b.to);
  const keep: T[] = [];
  const dropped: T[] = [];
  let lastTo = -1;
  for (const item of sorted) {
    if (item.from < lastTo) {
      dropped.push(item);
      continue;
    }
    keep.push(item);
    lastTo = item.to;
  }
  return { keep, dropped };
}

/**
 * 撤掉几块之后，旧的「现场找不到」标记只保留**还在清单里**的那些。
 * 以前一律清空：撤掉别的块会把不可撤的块重新伪装成可点（P3）。
 */
export function pruneStaleIds(
  stale: ReadonlySet<string>,
  hunks: readonly { id: string }[],
): ReadonlySet<string> {
  if (stale.size === 0) return stale;
  const alive = new Set(hunks.map((hunk) => hunk.id));
  const next = new Set([...stale].filter((id) => alive.has(id)));
  return next.size === stale.size ? stale : next;
}
