/**
 * ProvidersView 的纯函数层 —— 弹窗解析 / 费率合并 / 复制 id / 行简报。
 * UI 状态留在组件里，这里只放有边界要守的换算；node --test 可直接加载。
 */
import type { ModelDefaults } from "@shared/model-defaults";
import type { ModelCostDecl, ModelDecl, ProviderDto } from "@shared/provider";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名（type import 剥离后无此问题）
import { KNOWN_PROVIDERS } from "../../../../shared/known-providers.ts";
import { formatTokens } from "../../utils/format-tokens.ts";

/** 弹窗数值输入的解析结果：undefined = 留空继承，"invalid" = 不是合法数字 */
export type ParsedInput = number | undefined | "invalid";

/** "128000" / "128k" / "1M" → tokens；空串 = 继承（undefined）。不许负号与其它花样 */
export function parseTokenInput(text: string): ParsedInput {
  const t = text.trim().toLowerCase();
  if (t === "") return undefined;
  const m = /^([0-9.]+)\s*(k|m)?$/.exec(t);
  if (m === null) return "invalid";
  let value = Number(m[1]);
  if (!Number.isFinite(value)) return "invalid";
  if (m[2] === "k") value *= 1_000;
  if (m[2] === "m") value *= 1_000_000;
  return Math.round(value);
}

/** 费率输入：空串 = 继承；负数 / 非数 = invalid */
export function parseRateInput(text: string): ParsedInput {
  const t = text.trim();
  if (t === "") return undefined;
  const value = Number(t);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/**
 * 弹窗 Apply 的费率合并：只动 input / output 两档，cacheRead / cacheWrite 按
 * 现值 → 目录 → 0 兜住（decl.cost 是整份替换，四档必须齐全）。
 * 两档都留空 = 纯继承，返回 undefined（decl.cost 整个删掉）。
 */
export function mergeModelCost(
  existing: ModelCostDecl | undefined,
  meta: { cost: ModelCostDecl } | undefined,
  patch: { input: number | undefined; output: number | undefined },
): ModelCostDecl | undefined {
  if (patch.input === undefined && patch.output === undefined) return undefined;
  const pick = (a: number | undefined, b: number | undefined) => a ?? b ?? 0;
  return {
    input: pick(patch.input, existing?.input ?? meta?.cost.input),
    output: pick(patch.output, existing?.output ?? meta?.cost.output),
    cacheRead: existing?.cacheRead ?? meta?.cost.cacheRead ?? 0,
    cacheWrite: existing?.cacheWrite ?? meta?.cost.cacheWrite ?? 0,
  };
}

/** 复制厂商的 id：deepseek → deepseek-copy → deepseek-copy2 …（全程过 provider id 正则） */
export function nextCopyId(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  if (!taken.has(`${base}-copy`)) return `${base}-copy`;
  for (let n = 2; ; n++) {
    const id = `${base}-copy${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * 拖拽重排后的 id 顺序：被拖行落到目标行的位置（小框框住的那行），其余行顺移补位。
 * from/to 不在表里或相同则原样返回。
 */
export function reorderIds(ids: readonly string[], from: string, to: string): readonly string[] {
  const fi = ids.indexOf(from);
  const ti = ids.indexOf(to);
  if (fi < 0 || ti < 0 || from === to) return ids;
  const next = ids.slice();
  next.splice(fi, 1);
  next.splice(ti, 0, from);
  return next;
}

/** provider 对应的目录 kind 兜底（自建网关按协议落到两个「兼容」条目上）。
 * 设置页与聊天底栏的模型简报共用——两边必须认同同一个目录。 */
export function kindOf(provider: ProviderDto): string {
  return (
    KNOWN_PROVIDERS.find((k) => k.id === provider.id)?.id ??
    (provider.endpoint.api === "anthropic-messages" ? "anthropic-compatible" : "openai-compatible")
  );
}

/**
 * 模型行的上下文简报。**生效值 = 用户覆盖 > 推断出的基线**（基线内部已经是
 * 白名单 > pi 目录 > 兜底，见 shared/model-defaults），与 agent 注册时的装配同源
 * ——显示与 runtime 讲同一个故事。
 *
 * fallback: true = 这个数字是编出来的（目录、白名单、用户都没说话）。徽标上不写
 * "(fallback)" 字样（用户要求干净），悬停 title 由调用方用这个标志给兜底说明。
 */
export function modelContextText(
  decl: ModelDecl | undefined,
  defaults: ModelDefaults,
): { text: string; fallback: boolean } {
  const ctx = decl?.contextWindow ?? defaults.contextWindow;
  // 徽标要 1M 不要 1.0M——底栏统计要小数，这里不要；只抹 .0，1.2M 原样
  return {
    text: formatTokens(ctx).replace(/\.0(?=[kM]$)/, ""),
    fallback: decl?.contextWindow === undefined && defaults.source === "fallback",
  };
}

/**
 * 这个模型到底能不能吃图：用户的 vision 开关优先，没填就看推断出的模态。
 * 行上的图片徽标与弹窗的 Inherit 档位共用它，两处不会说两个答案。
 */
export function modelAcceptsImage(decl: ModelDecl | undefined, defaults: ModelDefaults): boolean {
  return decl?.vision ?? defaults.input.includes("image");
}

/**
 * 手填模型 id 的合法形状：小写字母 / 数字 / 点 / 短横，1–64 字，不以点或短横开头。
 *
 * **点号必须允许**——内置目录（known-providers）自己就有 `glm-5.3-flash`、`step-3.5-flash`，
 * 不认点号的校验会拒绝自家目录的 id 格式（2026-09-11 验收：加 `glm-5.3` 被拦）。
 * 这是 renderer 侧对用户输入的形状约束；shared 层对 model id 只查非空 + 不重复。
 */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** 校验不过时给用户看的话；过了返回 null。 */
export function modelIdIssue(id: string): string | null {
  return MODEL_ID_PATTERN.test(id)
    ? null
    : "Lowercase letters, digits, dots and dashes; 1–64 chars, no leading dot or dash.";
}
