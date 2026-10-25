/**
 * 侧栏用量格的数据：从任务账本按「天 × 型号」汇总（与价格 · 能力图同一本账、同一个型号口径）。
 * **纯模块**，可被 `node --test` 直接测。
 *
 * 每天的 tokens = 当天各任务的 token 之和 + 意图召回的 token——与改之前的日账本（usage-daily.json）
 * 口径相同：同样只算原生会话的 assistant 记录与意图召回、同样按消息 id 去重、同样按本地日期切天
 * （day-summary.test.ts 拿同一份会话数据比对两种算法的每天合计）。
 *
 * 花费按官方单价折算：记录上自带的花费照用，零价记录（套餐 / 订阅）按这个型号的官方单价折算——
 * 与价格 · 能力图同一个价。找不到单价的 token（含意图召回）不算进去，标 partial。
 */
import type { UsageDayModel, UsageDayTotal } from "../../shared/usage.ts";
import type { ModelGroups } from "./model-groups.ts";
import { taskCost, type StoredTask, type TokenCounts } from "./task-cost.ts";

const sum = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite;

export function usageDays(input: {
  dates: readonly string[];
  tasks: readonly StoredTask[];
  intent: ReadonlyMap<string, TokenCounts>;
  models: ModelGroups;
}): UsageDayTotal[] {
  return input.dates.map((date) => {
    const byModel = new Map<string, UsageDayModel>();
    let usd = 0;
    let partial = false;
    for (const task of input.tasks) {
      const day = task.days[date];
      if (day === undefined) continue;
      const tokens = sum(day.tokens);
      if (tokens === 0) continue;
      const group = input.models.of(task.modelId, task.providerId);
      const row = byModel.get(group.key) ?? { modelId: group.modelId, name: group.name, vendor: group.vendor, tokens: 0 };
      row.tokens += tokens;
      byModel.set(group.key, row);
      const cost = taskCost(day, group.rates);
      if (cost === null) {
        usd += day.recordedCost;
        partial = true;
      } else {
        usd += cost;
      }
    }
    const intentTokens = sum(input.intent.get(date) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    if (intentTokens > 0) partial = true;
    const models = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
    const tokens = models.reduce((total, row) => total + row.tokens, 0) + intentTokens;
    return { date, tokens, models, intentTokens, cost: tokens === 0 ? null : { usd, partial } };
  });
}
