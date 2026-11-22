/**
 * 旧版「收尾确认」留在会话 meta 里的记录形状（`SessionMeta.wrapups`）。
 *
 * 「完成 / 收尾」功能已删（见 commit 说明），**不再产生新记录**；类型与解析保留，只因为
 * 任务账本重建（回填）时要从旧会话 meta 里把历史上确认过的「做完的事」补进价格 · 能力图。
 * 记账数字是当年确认那一刻算好的快照，读到什么用什么。
 */
import type { ThinkingLevel } from "./thinking.ts";

/** token 四项（与主进程 task-cost 的 TokenCounts 同形） */
export interface WrapupTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 确认后的一件做完的事（落在 SessionMeta.wrapups 里，任务账本按它记账）。
 * 记账数字是**确认那一刻**从这几轮的 assistant 记录算好的快照：账本回填直接读它，不再按轮号
 * 回头切记录——之后的回退 / 分支改了轮号也不会让旧账漂移。
 */
export interface WrapupItem {
  title: string;
  turns: [number, number] | null;
  /** 这几轮里 token 最多的服务商 × 型号 × 档（没有轮次 / 没有用量时为 null，不进价格图） */
  providerId: string | null;
  modelId: string | null;
  level: ThinkingLevel | null;
  tokens: WrapupTokens;
  recordedCost: number;
  unpricedTokens: WrapupTokens;
}

/** 一次确认 */
export interface SessionWrapup {
  id: string;
  /** 确认时刻（epoch ms） */
  at: number;
  throughTurn: number;
  items: WrapupItem[];
}
