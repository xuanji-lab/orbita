/**
 * 收尾仪式的 fenced json 解析 —— 纯函数：模型终态回答 → 遗留事项草稿。
 *
 * 容错口径：**半残的输出不进 UI**。解析器只认「完整、结构正确的一个 json 块」，
 * 差一点（坏 JSON / 缺字段 / 类型错 / 没有围栏）都返回 null，由调用方走降级
 * （直接 setCompletion("done") 并提示）——混进一张半残清单，用户会去办一条
 * 标题都没说清的事，比降级更糟。空数组是合法答案（「没有遗留」也是回答）。
 *
 * 规则：
 *   - 只看 fenced 代码块（``` 围栏）；`json` 与无语言标注都认，其它语言标注跳过；
 *   - 多个可解析的块取**第一个**——模型若复读了两遍，第一遍是它的答案；
 *   - 逐块尝试：JSON.parse 失败就试下一个块（引导文字偶尔会被裹进围栏里）。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";

/** 扫描出的待勾选草稿（title 可在清单 UI 里改，detail 原样落盘）。 */
export interface CarryoverDraft {
  title: string;
  detail: string;
}

/**
 * 收尾扫描的 prompt。**它就是一条普通的用户消息**：点顶部的完成键 = 以当前
 * 会话的身份发出这句话，正常进消息流、正常进 pi 历史。
 *
 * 上一版是注入的隐形消息（visibility: "internal"），实机上用户看到的是「正文被折叠
 * 了、不知道它在干什么」，而一旦解析失败就静默丢失——发了什么、模型回了什么
 * 都无处可查。改成可见消息后这两件事都在屏幕上（代价：它进历史）。
 *
 * 措辞就是契约：解析器认的输出形状（一个 fenced json 块）在这里约定，两处一起改。
 */
export const CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。`;

/** 扫描轮的超时（ms）：超了就降级直接标完成，不让用户卡在等待里。 */
export const CLOSING_SCAN_TIMEOUT_MS = 60_000;

/**
 * 扫描轮落定后，从转录里取**解析输入**：基线之后最后一条已完成的 assistant
 * 消息的全部 text 块拼接。null = 这一轮根本没出现可用的回答。
 *
 * 三个口径各有来历：
 *   - **只取 text 块**：thinking 块常常排在前面，它不是回答；
 *   - **全部 text 块拼接**：围栏块可能被拆在多个 text 块里，只取最后一块会拿到半截围栏；
 *   - **跳过 streaming**：半截的流不是答案，宁可当没回答也不拿半截的去解。
 */
export function collectScanAnswer(
  transcript: readonly TranscriptItem[],
  baseline: number,
): string | null {
  let answer: string | null = null;
  for (const item of transcript.slice(baseline)) {
    if (item.role !== "assistant" || item.status === "streaming") continue;
    answer = item.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return answer;
}

/**
 * 扫描这**一轮**用哪个模型：设置里配了命名模型（`settings.titleModel`）就用它，
 * 没配就用会话自己的模型。扫描是一次机械的总结活，与命名同类，没必要花主力
 * 模型的钱。
 *
 * **只影响这一轮**：返回新对象、不改传入的轮次上下文；且 submit 携带的
 * providerId / modelId 不会回写会话 meta——主进程只在首轮建 meta 时落它，跨轮的
 * 模型真值由 `model` 事件写，而开轮不发这个事件。下一轮自然回到会话模型。
 */
export function scanTurnModel<T extends { providerId: string; modelId: string }>(
  turn: T,
  naming: { providerId: string; modelId: string } | undefined,
): T {
  if (naming === undefined) return turn;
  return { ...turn, providerId: naming.providerId, modelId: naming.modelId };
}

const FENCE_RE = /^([ \t]*```)[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;

/** 一段 markdown → 遗留事项草稿。结构不符 / 没有可解析块返回 null。 */
export function parseCarryoverResponse(markdown: string): CarryoverDraft[] | null {
  const lines = markdown.split("\n");
  /** 围栏是开/闭交替的：不在栏内才可能是开栏，在栏内只能是收栏。不跟踪这个状态的话，
   * 一个 ```text 块的收尾围栏会被当成「无标注的新开栏」，后面全乱。 */
  let inFence = false;
  let buffer: string[] | null = null;
  const candidates: string[] = [];

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      if (inFence) {
        // 收尾围栏：攒的这一块是一个候选（非 json 栏没攒，不 push）
        if (buffer !== null) candidates.push(buffer.join("\n"));
        buffer = null;
        inFence = false;
        continue;
      }
      const lang = fence[2] ?? "";
      // 开栏：只认 json 与无标注（其它语言标注的块不开攒）
      inFence = true;
      if (lang === "" || lang.toLowerCase() === "json") buffer = [];
      continue;
    }
    if (buffer !== null) buffer.push(line);
  }
  // 尾围栏缺失（流被截断）：buffer 里那半截丢弃——它不是完整答案

  for (const candidate of candidates) {
    const parsed = parseBlock(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * 整条消息是否**恰好是**一个可解析的 fenced json 块：是 → 返回草稿数组（空数组
 * 合法），否则 null。供消息流卡片化用——扫描回答按 prompt 契约就长这样，命中后
 * 整条消息不再按 markdown 渲染，改用只读展示卡。
 *
 * 与 parseCarryoverResponse 的分工：后者是「从一段 markdown 里尽力捞」，容忍前后
 * 杂文字（解析重试路径用）；这个是「整条消息就是答案」的严格形状判定。判定必须
 * 严格：卡片会整条替换原文，多吞一个字都是丢内容——夹杂引导文字 / 多个块 /
 * 围栏未闭合 / 语言标注不是 json，一律 null 走普通渲染，宁可不卡也不吞字。
 */
export function matchCarryoverMessage(text: string): CarryoverDraft[] | null {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  // 至少三行：开栏 / 内容 / 收栏
  if (lines.length < 3) return null;
  const open = FENCE_RE.exec(lines[0] ?? "");
  if (open === null) return null;
  const lang = open[2] ?? "";
  if (!(lang === "" || lang.toLowerCase() === "json")) return null;
  // 中间不许再出现围栏行（出现就是多块）；末行必须是收栏（缺了就是被截断）
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (FENCE_RE.test(lines[i] ?? "")) return null;
  }
  if (FENCE_RE.exec(lines[lines.length - 1] ?? "") === null) return null;
  return parseCarryoverResponse(trimmed);
}

/** 一个块的内容 → 草稿数组。形状差一点就 null（见文件头的容错口径）。 */
function parseBlock(text: string): CarryoverDraft[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root["carryovers"])) return null;
  const drafts: CarryoverDraft[] = [];
  for (const entry of root["carryovers"]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["title"] !== "string" || record["title"].trim() === "") return null;
    if (typeof record["detail"] !== "string") return null;
    drafts.push({ title: record["title"], detail: record["detail"] });
  }
  return drafts;
}

/**
 * 在 transcript 里给一条遗留事项找锚点（sourceMessageRange 的「尽力而为」）：
 * detail 是模型从对话里摘的原句/概括，拿它的开头在 user/assistant 消息文本里搜，
 * 第一条命中的序号就是锚（区间收成 [i, i]——粒度到消息，够「跳回原文」用）。
 * 摘录是概括时搜不到，返回 null——锚点缺省是设计内的常态，不阻塞落盘。
 */
export function locateMessageRange(
  transcript: readonly TranscriptItem[],
  detail: string,
): [number, number] | null {
  const probe = detail.trim().slice(0, 48);
  if (probe === "") return null;
  for (let i = 0; i < transcript.length; i += 1) {
    const item = transcript[i];
    if (item === undefined) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      if (block.text.includes(probe)) return [i, i];
    }
  }
  return null;
}
