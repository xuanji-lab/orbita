/**
 * 补蒸的蒸馏执行（agent utility 进程侧）——一批待蒸轮 → 逐轮蒸馏结果。
 *
 * 与实时蒸馏（runtime 的 scheduleMemoryDistill）同一条装配：先取冲突候选
 * （memoryContextRequest，主进程词法挑），再 completeSimple 一次小调用，
 * parseDistillReply 解析。差别只有三处：
 * - **日期锚在那一轮当时**（buildDistillPrompt 的 now = turn.at）——补蒸蒸的是
 *   几个月前的对话，「明天 / 上周」只有回到当时才解得开；
 * - 冲突候选**每轮现取**：补蒸按时间从旧到新跑，前一轮刚落的条目要能进后一轮
 *   的候选，判「推翻」才是对着完整的库判；
 * - 模型两级：choreModel（主进程解好密钥面，一次解析整批复用）→ 该会话自己的
 *   fallback 模型（按 (providerId, modelId) 缓存解析）。
 *
 * **纯模块**：模型调用与候选问答都是注入的依赖，`node --test` 直接测。
 */
import type { MemoryBackfillTurnInput, MemoryBackfillTurnResult, ProviderSecrets } from "../shared/agent-ipc.ts";
import type { MemoryCandidate, MemoryDraft } from "../shared/memory.ts";
import { buildDistillPrompt, parseDistillReply } from "./memory-distill.ts";

/** 候选问答：主进程按这轮内容词法挑可能相撞的旧条目。拿不到当空（判不了总比判错好）。 */
export type BackfillCandidatesFetcher = (input: {
  sessionId: string;
  query: string;
  scope: { workspaceId: string | null; cwd: string };
}) => Promise<MemoryCandidate[]>;

/** 一次蒸馏调用：注入方负责模型解析与 completeSimple；返回模型输出文本或错误。 */
export type BackfillDistillCaller = (input: {
  userText: string;
  assistantText: string;
  /** 日期锚：那一轮的用户消息时间戳 */
  now: number;
  candidates: readonly MemoryCandidate[];
  /** choreModel 没解析到时，这轮退回该会话自己的模型；主进程没装出来就没有 */
  fallback: { provider: ProviderSecrets; modelId: string } | undefined;
}) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

export interface BackfillDistillDeps {
  fetchCandidates: BackfillCandidatesFetcher;
  callDistillModel: BackfillDistillCaller;
  /** 批内并发上限（默认 3——编排层的窗口同样 3，再大容易撞家务活模型的限流） */
  concurrency?: number;
}

/** 限并发跑一批异步任务（保序收集结果）。补蒸批内并发的全部实现。 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 冲突候选的查询文本：用户输入 + 助手回答的拼串（实时蒸馏同款，截 8000）。 */
export function candidatesQuery(userText: string, assistantText: string): string {
  return `${userText}\n${assistantText}`.slice(0, 8000);
}

/** 蒸一轮（候选问答 → 蒸馏调用 → 解析）。任何失败都收敛成 ok:false，不抛。 */
async function distillOne(
  turn: MemoryBackfillTurnInput,
  deps: BackfillDistillDeps,
): Promise<MemoryBackfillTurnResult> {
  try {
    let candidates: MemoryCandidate[] = [];
    try {
      candidates = await deps.fetchCandidates({
        sessionId: turn.sessionId,
        query: candidatesQuery(turn.userText, turn.assistantText),
        scope: turn.scope,
      });
    } catch (cause) {
      // 候选拿不到照常蒸馏（实时蒸馏同款）：判不了推翻总比判错好
      console.error("[memory:backfill] 冲突候选没拿到（照常蒸馏，不判推翻）", turn.sessionId, turn.turn, cause);
    }
    const reply = await deps.callDistillModel({
      userText: turn.userText,
      assistantText: turn.assistantText,
      now: turn.at,
      candidates,
      fallback: turn.fallback,
    });
    if (!reply.ok) return { sessionId: turn.sessionId, turn: turn.turn, ok: false, error: reply.error };
    const entries: MemoryDraft[] = parseDistillReply(reply.text, turn.at, new Set(candidates.map((c) => c.id)));
    return { sessionId: turn.sessionId, turn: turn.turn, ok: true, entries };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { sessionId: turn.sessionId, turn: turn.turn, ok: false, error };
  }
}

/** 蒸一批（限并发，逐轮回执；单轮失败不影响别的轮）。 */
export function runBackfillDistill(
  turns: readonly MemoryBackfillTurnInput[],
  deps: BackfillDistillDeps,
): Promise<MemoryBackfillTurnResult[]> {
  return mapWithLimit(turns, deps.concurrency ?? 3, (turn) => distillOne(turn, deps));
}
