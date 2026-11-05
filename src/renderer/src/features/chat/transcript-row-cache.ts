/**
 * 转录列行级派生的记忆（纯函数 + 按对象的 WeakMap 缓存）。
 *
 * 流式期间 TranscriptColumn 每帧重算派生链，但已落定的记录跨帧是同一个对象：
 * 按记录对象记住结果，每帧只为新出现 / 正在变的那几条重算，交出去的值也保持同一引用
 * （行级 memo 靠它命中，见 ChatView 的 TranscriptRow）。
 */
import type { TranscriptRecord } from "@shared/session";
import { matchScanMessage, type ScanMessage } from "./carryover-parse.ts";
import { replySpeed } from "./stats-format.ts";
import { answerText, turnAssistantRecordsAt } from "./tool-results.ts";
import { sameItems } from "./render-stability.ts";

/** 收尾扫描回复卡片（TranscriptColumn 的 carryoverCards）：整条消息由第一个 text 块的位置渲染成卡 */
export type CarryoverCard = { scan: ScanMessage; firstKey: string };

/**
 * 一条落定的 assistant 记录是不是收尾扫描回复（整条恰好一个可解析的 fenced json）。
 * 按记录对象记忆：落定记录跨帧是同一个对象，判定只做一次。
 */
const scanCardCache = new WeakMap<object, CarryoverCard | null>();
export function scanCardOf(record: Extract<TranscriptRecord, { role: "assistant" }>): CarryoverCard | null {
  const cached = scanCardCache.get(record);
  if (cached !== undefined) return cached;
  let firstKey: string | null = null;
  const parts: string[] = [];
  record.content.forEach((block, index) => {
    if (block.type !== "text") return;
    if (firstKey === null) firstKey = `${record.id}:${index}`;
    parts.push(block.text);
  });
  let card: CarryoverCard | null = null;
  if (firstKey !== null) {
    const scan = matchScanMessage(parts.join(""));
    if (scan !== null) card = { scan, firstKey };
  }
  scanCardCache.set(record, card);
  return card;
}

/** 分支行要显示的：整轮回答的复制文本与速度 */
export type BranchInfo = { speed: number | null; copyText: string };

/** 按锚点记录对象记忆：同一锚点、整轮记录逐项相同就复用上次算好的结果 */
const branchInfoCache = new WeakMap<object, { turn: readonly TranscriptRecord[]; info: BranchInfo }>();

/**
 * 每个分支锚点（branchRows 的值）→ 复制文本与速度。锚点按 id 一次建索引，
 * 再从锚点往回走到轮边界（turnAssistantRecordsAt 的口径，见 tool-results.ts）。
 */
export function branchInfoOf(
  records: readonly TranscriptRecord[],
  branchRows: ReadonlyMap<number, string>,
): ReadonlyMap<string, BranchInfo> {
  const out = new Map<string, BranchInfo>();
  if (branchRows.size === 0) return out;
  const anchors = new Set(branchRows.values());
  for (let end = 0; end < records.length; end += 1) {
    const anchor = records[end];
    if (anchor === undefined || !anchors.has(anchor.id) || out.has(anchor.id)) continue;
    const turn = turnAssistantRecordsAt(records, end);
    const cached = branchInfoCache.get(anchor);
    if (cached !== undefined && sameItems(cached.turn, turn)) {
      out.set(anchor.id, cached.info);
      continue;
    }
    const info = { speed: replySpeed(turn), copyText: answerText(turn) };
    branchInfoCache.set(anchor, { turn, info });
    out.set(anchor.id, info);
  }
  return out;
}
