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
 * **首刀只放 5 档**：pi 认 7 档（off…max），但 xhigh / max 的支持判据是目录的
 * `thinkingLevelMap`，注册链（model-registration）目前没把它抄过去——放出
 * 这两档等于让用户点到永远被 clamp 掉的假选项。补齐目录保真度是另一刀。
 */
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-protocol";

/** 我们放的 5 档。**类型从 pi 收窄**（收编 pi 的词汇表，不重抄一份联合类型）。 */
export type ThinkingLevel = Exclude<PiThinkingLevel, "xhigh" | "max">;

/** 菜单顺序（浅 → 深）。 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ThinkingLevel[];

/** 芯片与菜单的文案（形状照抄 PERMISSION_MODE_LABELS：label + hint）。 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, { label: string; hint: string }> = {
  off: { label: "Off", hint: "No thinking. Fastest and cheapest." },
  minimal: { label: "Minimal", hint: "Barely think before answering." },
  low: { label: "Low", hint: "Light thinking." },
  medium: { label: "Medium", hint: "Balanced thinking. The underlying default." },
  high: { label: "High", hint: "Think hard. Slower and more expensive." },
};

/**
 * 磁盘 / IPC 上的任意值 → 5 档之一。**坏值退 "medium"，不是 "off"**：
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
