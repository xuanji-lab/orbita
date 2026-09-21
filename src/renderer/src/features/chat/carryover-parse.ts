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
 * 注入的内部 prompt（visibility: "internal"）。收尾仪式的扫描指令——措辞就是
 * 契约：解析器认的输出形状（一个 fenced json 块）在这里约定，两处一起改。
 */
export const CLOSING_SCAN_PROMPT = `收尾扫描：回看本次对话，列出所有「说了但没做完」的开放环——答应要做但还没做的、被岔开没继续的话题、明确延后未完成的任务。
只输出一个 fenced json 代码块，不要输出任何其他内容，格式：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有遗留事项就输出 {"carryovers": []}。`;

/** 扫描轮的超时（ms）：超了就降级直接标完成，不让用户卡在等待里。 */
export const CLOSING_SCAN_TIMEOUT_MS = 60_000;

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
