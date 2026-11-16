/**
 * 收尾（wrap-up）的旧记录形状：会话 meta 里的 `wrapups`。
 *
 * 收尾扫描 2026-11-16 整套删了（点「完成」只标完成，不再扫描、不再记遗留事项）。以前确认过的收尾
 * 仍留在 meta 里、照常读：任务账本回填据它把「做完的事」画进价格 · 能力图（usage-tasks.json 的 done）。
 * 没有人再写新的。
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
