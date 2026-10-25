/**
 * 收尾（wrap-up）契约 —— IPC 四层的第 1 层。
 *
 * 点「完成」后，家务活模型回看会话，列出**做完的事**（每件占第几轮到第几轮）与**留下的事**
 * （遗留事项）；用户在确认卡里改、或打字 / 口述让它改；确认后：
 *   - 做完的事每件 = 价格 · 能力图里的一个任务（花费 = 那几轮合计，算给那几轮里 token 最多的
 *     型号 × 档——用户 2026-10-24 只接受这一条规则）；
 *   - 留下的事进遗留清单（carryovers.jsonl）。
 *
 *   session:wrapup-plan     (sessionId)                → WrapupPlan | null   这次要扫的轮次与各轮用量
 *   session:wrapup-revise   (sessionId, WrapupReviseInput) → WrapupReviseResult  按用户一句话改清单
 *   session:wrapup-confirm  (sessionId, WrapupConfirmInput) → void            确认：落账 + 遗留 + 标完成
 *
 * ## 「第 n 轮」的定义（扫描 prompt、解析器、落账三处同一个口径）
 * 第 n 轮 = 会话生效视图里**第 n 条真人用户消息**起，到下一条用户消息（任何一条，含机器提问）之前。
 * 机器提问（收尾扫描的 prompt）不是一轮，它和它的回答不属于任何一轮——所以收尾的开销不会算进
 * 任何一件做完的事。通道标记（子会话交回的消息）不切轮，算在它所在的那一轮里。
 */
import type { ThinkingLevel } from "./thinking.ts";
import type { CarryoverDraft } from "./session.ts";

/** token 四项（与主进程 task-cost 的 TokenCounts 同形） */
export interface WrapupTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一轮里某个「服务商 × 型号 × 档」花的 token（同一轮可能换过型号 / 档） */
export interface WrapupTurnUsage {
  providerId: string;
  modelId: string;
  /** null = 这几条记录的档无从可考（盖章之前、pi 时间线又对不上的旧记录） */
  level: ThinkingLevel | null;
  tokens: WrapupTokens;
  /** 记录上自带的花费（cost.total > 0 的那些）之和 */
  recordedCost: number;
  /** 零价记录（套餐 / 订阅）的 token：按官方单价折算 */
  unpricedTokens: WrapupTokens;
  /** 按官方价折算的花费（美元）；有零价 token 而找不到官方单价时 null */
  officialCost: number | null;
}

/** 一轮 */
export interface WrapupTurn {
  /** 第几轮（1 起，见文件头的定义） */
  n: number;
  /** 这一轮那条用户消息的转录 id（「第 x–y 轮」点了跳回去） */
  userId: string;
  /** 用户消息首行，截断（扫描 prompt 里给模型对轮号用） */
  preview: string;
  usage: WrapupTurnUsage[];
}

/** 这次收尾要看的轮次：上次确认之后的那些（会话重开后再点完成，只扫新的） */
export interface WrapupPlan {
  /** 本次从第几轮起（上次确认到的轮 + 1；第一次收尾是 1） */
  sinceTurn: number;
  /** 会话目前一共几轮 */
  lastTurn: number;
  /** sinceTurn..lastTurn 各轮（含两端） */
  turns: WrapupTurn[];
  /**
   * 本次范围里发生过的上下文压缩（旧 → 新）：afterTurn = 压缩发生时已经开始了几轮（压缩点落在
   * 第 afterTurn 轮里或它之后）；summary = 那条 compacted 记录的摘要。扫描时模型的上下文里只有
   * 最后一次压缩的摘要与之后的轮次，更早的轮次原文看不到——扫描 prompt 按压缩切段，把每段的
   * 摘要连同轮次范围一起给它（用户 2026-10-24：「去前面看五次压缩，然后总结五次，然后再整合」）。
   */
  compactions: WrapupCompaction[];
}

export interface WrapupCompaction {
  afterTurn: number;
  summary: string;
}

/** 清单上的一行被反馈改动的方式（卡片上挂的小标签） */
export type WrapupChange = "merged" | "moved-to-left" | "moved-to-done" | "added" | "edited";

export const WRAPUP_CHANGES: readonly WrapupChange[] = ["merged", "moved-to-left", "moved-to-done", "added", "edited"];

/** 清单上的一行（做完的事与留下的事同形：两组之间挪动时字段原样带着走） */
export interface WrapupEntry {
  title: string;
  /** 上下文摘录：留下的事必有（可空串），做完的事一般为空 */
  detail: string;
  /** 占第几轮到第几轮（含两端）；null = 没指定（用户自己加的、或从留下的事挪过来的） */
  turns: [number, number] | null;
  /** 反馈改过的标签；缺席 = 没改 */
  change?: WrapupChange;
}

export interface WrapupDraft {
  done: WrapupEntry[];
  left: WrapupEntry[];
}

export interface WrapupReviseInput {
  /** 当前计划的轮次范围（模型给的轮号要落在里面） */
  sinceTurn: number;
  lastTurn: number;
  draft: WrapupDraft;
  /** 用户打字或口述的那句话 */
  feedback: string;
}

export type WrapupReviseResult =
  | { ok: true; draft: WrapupDraft; summary: string }
  | { ok: false; error: string };

export interface WrapupConfirmInput {
  /** 这次确认覆盖到第几轮（下次收尾从它 + 1 起） */
  throughTurn: number;
  done: { title: string; turns: [number, number] | null }[];
  carryovers: CarryoverDraft[];
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
