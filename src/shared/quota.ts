/**
 * 厂商账号额度 —— IPC 四层契约的第 1 层（唯一真源）。
 *
 * 两类东西装在一个快照里，但**谁也不冒充谁**：
 *   - `credits` = API 余额（按 token 计费，一个带币种的标量）
 *   - `windows` = coding plan 额度（若干窗口的百分比 + 重置时间）
 * 参考实现里 Proma 把余额塞进「剩余百分比」的行里（`remainingLabel` + `showProgress:false`），
 * 下游每个消费者都要再判一次它到底是钱还是百分比；codex 的形状更干净，这里跟它走。
 *
 * 方向只有 `usedPercent`（已用）一个：智谱 / codex 的原始口径都是「已用」，
 * 界面上数字后面永远带 `used`，条本身方向中性（见 decisions 第 6 条）。
 * 厂商原文标签（「5-hour window」「Weekly」）不翻译——它们不是同一件事。
 */

/** 这一家能不能查额度，以及查的是哪一类。声明在 `known-providers.ts` 的条目上 */
export type QuotaProbe = "balance" | "plan-windows" | "none";

export interface QuotaCredits {
  /**
   * 金额字符串，**保精度**：厂商给的就是字符串（DeepSeek 的 `total_balance`），
   * 转 number 再转回来会掉末尾的 0，也可能在下一版里丢精度。
   */
  amount: string;
  /** ISO 4217（`CNY` / `USD`）；厂商给什么就放什么，不认识就原样显示 */
  currency: string;
  unlimited?: boolean;
  /**
   * 厂商给的充值 / 赠送拆分（DeepSeek 有），可选：没有就不显示那一行小字。
   * 两者相加应等于 amount，但我们不替厂商做算术——只原样展示。
   */
  granted?: string;
  toppedUp?: string;
}

export interface QuotaWindow {
  /** 厂商侧窗口 id（如 `tokens:3:5`），稳定、可作 React key */
  id: string;
  /** 厂商原文标签，不翻译（「5-hour window」/「Weekly」不是同一件事） */
  label: string;
  /** 已用百分比 0–100。**方向只有这一个** */
  usedPercent: number;
  /** 窗口长度（分钟）。厂商没给就不写 */
  windowMinutes?: number;
  /** 毫秒时间戳；不知道就不写 */
  resetsAt?: number;
}

export interface QuotaSnapshot {
  credits?: QuotaCredits;
  windows: QuotaWindow[];
  /** 这次数据是什么时候取到的（毫秒） */
  fetchedAt: number;
}

/**
 * 失败原因必须分三类（decisions 15），否则用户无法判断该改什么：
 * 钥匙错 / 厂商改版 / 网络。`unsupported` 是「这家就是查不了」（团队账号、未接入）。
 */
export type QuotaFailure = "auth" | "unsupported" | "network" | "protocol";

export type QuotaResult =
  | { status: "ok"; snapshot: QuotaSnapshot; fromCache: boolean }
  /** 这家没有可查的额度（capability = none）：整块不渲染，不留「—」 */
  | { status: "none" }
  /** `cached` = 上一次成功的快照（可能为 null）。失败**保留旧值**，不覆盖成 0 */
  | { status: "error"; reason: QuotaFailure; cached: QuotaSnapshot | null };

/** `provider:quota` 的入参。`refresh` = 用户点了刷新（绕过 60s 复用） */
export interface QuotaQuery {
  providerId: string;
  refresh?: boolean;
}

/**
 * 超过 24 小时的值不展示（decisions 14）：一周前的余额比「不知道」更容易误导。
 * 边界取**严格大于**——正好 24h 仍算有效，否则同一份快照在两台机器上会有两种结论。
 */
export const QUOTA_STALE_MS = 24 * 60 * 60 * 1000;

export function quotaIsStale(fetchedAt: number, now: number): boolean {
  return now - fetchedAt > QUOTA_STALE_MS;
}
