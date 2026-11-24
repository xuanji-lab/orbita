import type { ScopeSummary } from "./galaxy-data.ts";

/**
 * 编排里「一个智能体此刻在干什么」只有四个词（状态词表，侧栏行与页头胶囊共用，文案在 messages 的 agents.status）：
 * 等你（有活停在你这儿）> 在跑（有活在外面干）> 出错（最近一轮失败了，如模型返回 401）> 空闲。同一件事在两处永远是同一个词。
 */
export type AgentStatusKind = "waiting" | "running" | "failed" | "idle";

type StatusCounts = Pick<ScopeSummary, "waiting" | "running"> & Partial<Pick<ScopeSummary, "failed">>;

export function agentStatusOf(summary: StatusCounts): AgentStatusKind {
  if (summary.waiting > 0) return "waiting";
  if (summary.running > 0) return "running";
  if ((summary.failed ?? 0) > 0) return "failed";
  return "idle";
}

/** 状态后面的件数：等你 / 在跑 / 出错才带；空闲没有 */
export function agentStatusCount(summary: StatusCounts): number | null {
  const kind = agentStatusOf(summary);
  return kind === "waiting" ? summary.waiting : kind === "running" ? summary.running : kind === "failed" ? (summary.failed ?? 0) : null;
}

/**
 * 侧栏行第二行：永远先说状态；空闲时才在状态后面补「最近一件事」（措辞带前缀、灰度更浅，与状态区分）。
 * 在跑 / 等你时不挤进别的东西。
 */
export interface AgentLine {
  status: AgentStatusKind;
  count: number | null;
  /** 只有空闲且有会话时才有：最近一条会话的标题 */
  recent: string | null;
}

export function agentLineOf(summary: StatusCounts & Pick<ScopeSummary, "lastTitle">): AgentLine {
  const status = agentStatusOf(summary);
  return { status, count: agentStatusCount(summary), recent: status === "idle" ? summary.lastTitle : null };
}

/** 页头状态胶囊：同一份状态；等你时带直达的会话 id */
export interface HeaderStatus {
  status: AgentStatusKind;
  count: number | null;
  sessionId: string | null;
}

export function headerStatusOf(summary: StatusCounts & Pick<ScopeSummary, "waitingId">): HeaderStatus {
  const status = agentStatusOf(summary);
  return { status, count: agentStatusCount(summary), sessionId: status === "waiting" ? summary.waitingId : null };
}

/**
 * 侧栏行的次序：固定在前的（「主目录」）→ 等你的（新的在前）→ 其余按最近活动（新的在前，没有会话的垫底）；
 * 同分按原列表次序。等你的事处理掉后，那一行自然落回它的时间位。纯函数，不改入参。
 */
export interface AgentOrderKey {
  /** 固定在最前（不参与排序） */
  pinned: boolean;
  waiting: number;
  lastActive: number | null;
}

export function orderAgentRows<T>(rows: readonly T[], keyOf: (row: T) => AgentOrderKey): T[] {
  const indexed = rows.map((row, index) => ({ row, index, key: keyOf(row) }));
  const tier = (key: AgentOrderKey): number => (key.pinned ? 0 : key.waiting > 0 ? 1 : 2);
  indexed.sort(
    (a, b) =>
      tier(a.key) - tier(b.key) ||
      (b.key.lastActive ?? Number.NEGATIVE_INFINITY) - (a.key.lastActive ?? Number.NEGATIVE_INFINITY) ||
      a.index - b.index,
  );
  return indexed.map((item) => item.row);
}
