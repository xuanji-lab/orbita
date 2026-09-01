/**
 * 模型参数表单的纯逻辑 —— ModelMetaEditor 的数字格解析与防呆判定。
 * 纯函数（node --test 直接加载，不碰 React / IPC）。这里只管「怎么读输入」；
 * 「什么合法」由 upsert 的 validateProvider 按字段路径结构化拦截、表单标红。
 */
import type { ModelCostDecl, ModelDecl } from "@shared/provider";

/** 数字格：空串 = 不覆盖（undefined），否则 Number（非法串得 NaN，交给校验层拦）。 */
export function parseOverrideNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

/** 四格费率 → cost 覆盖：全空 = 整份撤掉；填了任何一格，其余按 0（明确报价）计。 */
export function parseCostRates(rates: {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}): ModelCostDecl | undefined {
  if (rates.input === "" && rates.output === "" && rates.cacheRead === "" && rates.cacheWrite === "") {
    return undefined;
  }
  return {
    input: Number(rates.input || "0"),
    output: Number(rates.output || "0"),
    cacheRead: Number(rates.cacheRead || "0"),
    cacheWrite: Number(rates.cacheWrite || "0"),
  };
}

/** 行内编辑器的本地输入 → 覆盖声明。空格全撤（只剩 id），保留既有的 name。 */
export function buildModelDecl(
  base: ModelDecl,
  fields: { ctx: string; maxOut: string; rates: { input: string; output: string; cacheRead: string; cacheWrite: string } },
): ModelDecl {
  const contextWindow = parseOverrideNumber(fields.ctx);
  const maxTokens = parseOverrideNumber(fields.maxOut);
  const cost = parseCostRates(fields.rates);
  return {
    id: base.id,
    ...(base.name !== undefined ? { name: base.name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * contextWindow 防呆（2026-09-01 事故）：本应用固定的系统提示词 + 工具定义约 26k token，
 * pi 的 clampMaxTokensToContext 还要再扣 4096 安全垫——声明 26000 时输出预算被钳到
 * 1 个 token，模型「思考两个字」就 finish_reason=length 截止，且压缩救不了（那 26k
 * 开销不在会话里，每轮重建，压缩永远摘不到）。低于 40k 一律警示；null = 不警示。
 */
export function contextWindowWarning(ctx: number | undefined): string | null {
  // NaN（非法输入）是校验层的事，这里不双重报信
  if (ctx === undefined || Number.isNaN(ctx) || ctx >= 40_000) return null;
  return "Too small — the built-in prompt alone needs ~26k tokens; answers get cut off";
}
