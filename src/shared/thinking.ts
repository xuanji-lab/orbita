/**
 * 思考档（thinking level）的共享契约。
 *
 * **这不是「加一个新档位」，是「把一个已经在跑、但没人说出口的档位收归己有」**：
 * 此前开轮从不给 pi 传 thinkingLevel，pi 的解析链退到用户全局
 * `~/.pi/agent/settings.json`（orbita 的用户多半没有这份文件），再退到它自己的
 * 默认 "medium"——界面没有任何地方展示或修改这个值，而它实际左右每一轮的
 * 深度、耗时与 token 曲线。这一刀把它变成 orbita 自己的一等旋钮（与 mode /
 * model 同类：会话里选、meta 里存、开轮载荷里带）。
 *
 * 档位因模型而异（目录实测：glm-5.3 只有 low/high/max，claude 系 minimal→max
 * 而 off 关不掉）——词汇表不裁剪、菜单按模型真实支持集显示，见
 * BuiltinModel.supportedThinkingLevels。
 */

/** 思考档词汇表与 pi 同源：pi 认几档我们认几档（7 档，off…max）。 */
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-protocol";

/** pi 全集（不收窄——曾被收窄到 5 档，后被目录数据推翻：glm-5.3 只有 low/high/max，claude 系有 xhigh/max 而 off 关不掉，档位本来就因模型而异，裁剪词汇表只会递增假选项） */
export type ThinkingLevel = PiThinkingLevel;

/** 词汇表顺序（浅 → 深）。菜单不直接用它写死，而是按模型的 supportedThinkingLevels 显示真集；这里只作「完全未知时的全量兑底」与顺序真源。 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

/**
 * 芯片与菜单的显示名。**只有词，没有描述**——思考档是用户带着认知来的东西
 * （Low 就是 Low），一行解释只会让菜单更吵；宽度也因此能固定（wafo 2026-09-22）。
 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, { label: string }> = {
  off: { label: "Off" },
  minimal: { label: "Minimal" },
  low: { label: "Low" },
  medium: { label: "Medium" },
  high: { label: "High" },
  xhigh: { label: "Extra high" },
  max: { label: "Max" },
};

/**
 * 档位的**显示名**因模型家族而异（id 是协议层统一的，词是各家的）：
 * 迁移用户带着自己对模型的既有认知过来，菜单上该是他认识的那个词。
 * 目前只有 claude 有专属叫法（xhigh = Extra）；命中表里没有的档退通用名。
 */
const FAMILY_LABELS: ReadonlyArray<{
  matches: (modelId: string) => boolean;
  labels: Partial<Record<ThinkingLevel, string>>;
}> = [{ matches: (id) => id.startsWith("claude"), labels: { xhigh: "Extra" } }];

/** 档位在某模型上的显示名。modelId 未知 / 家族未定制时退通用名。 */
export function thinkingLevelLabel(level: ThinkingLevel, modelId: string | null | undefined): string {
  if (modelId != null && modelId !== "") {
    for (const family of FAMILY_LABELS) {
      if (family.matches(modelId)) {
        const override = family.labels[level];
        if (override !== undefined) return override;
        break;
      }
    }
  }
  return THINKING_LEVEL_LABELS[level].label;
}

/**
 * 磁盘 / IPC 上的任意值 → pi 七档之一。**坏值退 "medium"，不是 "off"**：
 * 这份缺省的读者是存量会话（meta 还没有这个字段的老会话），它们实际跑的档
 * 就是 pi 的默认 medium——退 "off" 才是改写历史。
 */
export function parseThinkingLevel(raw: unknown): ThinkingLevel {
  return isThinkingLevel(raw) ? raw : "medium";
}

/** 逐字校验：不认识就 false（不兑任何默认值——兑底是 parse 的事，守卫只回答「是不是」） */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly unknown[]).includes(value);
}
