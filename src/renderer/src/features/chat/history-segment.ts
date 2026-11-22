/**
 * 历史段派生（纯模块）：把「最后一条 user 记录之前」的记录摊平、合并、折叠成渲染视图，
 * 并在记录前缀没有变化时**复用上一次的全部产物**。
 *
 * 流式期间 transcript 的引用逐帧变化，但变化只发生在尾段（最后一条 user 之后）。这个模块
 * 只在历史前缀真的变了（回退 / 撤销 / 压缩界碑 / 分页前插）时才重算；否则返回同一个
 * `HistorySegment` 对象，`ChatView` 里历史段的 `turnView` 元素与行组件 props 全部保持
 * 引用相等，memo 才能真正命中。
 *
 * 这里的派生口径与整段一次性计算**等价**，依赖的是 `groupToolUnits` / `groupTurns*` 的
 * 切段规则：user / 压缩界碑 / 通道标记都是段边界，相邻同类合并不会跨过 user 记录。
 * 因此「跑到最后一条 user 为止」与「整段里那部分」逐项相同。
 *
 * 不依赖 React / DOM，可被 `node --test` 直接加载。
 */
import type { TranscriptRecord } from "@shared/session";
import type { ProcessView } from "@shared/settings";
import type { PlanTimeline } from "../context/plan-timeline.ts";
import { planTimeline } from "../context/plan-timeline.ts";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import { stablePrefix } from "./transcript-split.ts";
import {
  branchAnchorEntries,
  branchAnchorIds,
  flattenRenderUnits,
  groupToolUnits,
  groupTurns,
  groupTurnsByTurn,
  indexToolResults,
  interruptedToolCallIds,
  scanAnswerCards,
  type RenderEntry,
  type ScanAnswerCard,
  type ToolResultIndex,
  type TurnViewEntry,
} from "./tool-results.ts";

/** 历史段里不可能有流式消息：所有 assistant 记录都已落定 */
const NO_STREAMING_IDS: ReadonlySet<string> = new Set<string>();

export interface HistorySegmentInputs {
  /** 整段记录（含尾段）；只取前 `boundary` 条 */
  records: readonly TranscriptRecord[];
  /** 历史段长度：最后一条 user 记录的下标 + 1 */
  boundary: number;
  /** 只用到 slug / name（分组时认 skill read）；用宽类型免得测试要造完整 SkillMeta */
  skills: ReadonlyArray<{ slug: string; name: string }>;
  processView: ProcessView;
}

/** 历史段的全部派生（引用在输入不变时保持） */
export interface HistorySegment {
  /** 稳定前缀（不是整段记录） */
  records: readonly TranscriptRecord[];
  toolResults: ToolResultIndex;
  entries: readonly RenderEntry[];
  turnView: readonly TurnViewEntry[];
  plan: PlanTimeline | null;
  interruptedCalls: ReadonlySet<string>;
  streamingIds: ReadonlySet<string>;
  /** 视图下标 → 分支锚点消息 id（历史段的下标从 0 起） */
  branchRows: ReadonlyMap<number, string>;
  carryoverCards: ReadonlyMap<string, ScanAnswerCard>;
}

/** 跨渲染帧的缓存：segment 与它对应的输入签名 */
export interface HistoryCache {
  segment: HistorySegment;
  boundary: number;
  skills: ReadonlyArray<{ slug: string; name: string }>;
  processView: ProcessView;
}

/**
 * 取历史段派生。`cache` 由调用方跨帧持有（React 里放 ref）；输入前缀与上次相同则原样
 * 返回 cache。前缀逐元素引用比较由 `stablePrefix` 负责——中间插入 / 替换会让它失效。
 */
export function deriveHistorySegment(
  cache: HistoryCache | null,
  inputs: HistorySegmentInputs,
): HistoryCache {
  const { records, boundary, skills, processView } = inputs;
  const cachedPrefix = cache === null ? null : cache.segment.records;
  const prefix = stablePrefix(cachedPrefix, records, boundary);
  if (
    cache !== null &&
    cache.boundary === boundary &&
    cache.skills === skills &&
    cache.processView === processView &&
    prefix === cachedPrefix
  ) {
    return cache;
  }

  const toolResults = indexToolResults(prefix);
  const units = flattenRenderUnits(prefix);
  const entries = groupToolUnits(units, skills);
  const turnView =
    processView === "turn"
      ? groupTurnsByTurn(entries, false, toolResults)
      : groupTurns(entries, false, toolResults);
  const plan = planTimeline(
    prefix.filter((record) => record.role === "tool" && record.toolName === PLAN_TOOL_NAME),
  );
  return {
    segment: {
      records: prefix,
      toolResults,
      entries,
      turnView,
      plan,
      interruptedCalls: interruptedToolCallIds(prefix, toolResults, false),
      streamingIds: NO_STREAMING_IDS,
      branchRows: branchAnchorEntries(branchAnchorIds(prefix, toolResults, false), turnView),
      carryoverCards: scanAnswerCards(prefix),
    },
    boundary,
    skills,
    processView,
  };
}
