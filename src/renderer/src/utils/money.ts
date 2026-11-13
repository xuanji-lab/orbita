/**
 * 花费的显示币种 —— 纯函数，node --test 可直接加载。
 *
 * **数据一律美元**：pi 目录的 ModelCost 是「美元 / 百万 token」，会话记录里 pi 算出的花费、
 * 用户在模型弹窗里填的单价（ModelDecl.cost）落盘都是美元。只在显示（与弹窗输入）这一层按界面
 * 语言换算：中文界面人民币，英文界面美元（用户 2026-10-25：「帮我把价格都改成 rmb 吧」）。
 * 汇率是写死的一个数（`messages-zh` 的 currency，注明出处与日期），不联网取——本地优先，
 * 花费本身就是按官方单价折算的估计，差几个点的汇率不改变结论。
 */

export interface Currency {
  /** 金额前缀：¥ / $ */
  symbol: string;
  /** 1 美元折多少显示币种 */
  perUsd: number;
}

/** 美元 → 显示币种 */
export function shownAmount(usd: number, currency: Currency): number {
  return usd * currency.perUsd;
}

/** 显示币种 → 美元（弹窗里填的单价落盘前换回去） */
export function usdOf(amount: number, currency: Currency): number {
  return amount / currency.perUsd;
}

/**
 * 花费：≥ 1 两位小数，0 写 0，< 1 两位有效数字（¥0.21、$0.031）。侧栏用量格、收尾卡片用。
 */
export function formatMoney(usd: number, currency: Currency): string {
  const amount = shownAmount(usd, currency);
  if (amount >= 1) return `${currency.symbol}${amount.toFixed(2)}`;
  if (amount === 0) return `${currency.symbol}0`;
  return `${currency.symbol}${amount.toPrecision(2)}`;
}

/**
 * 弹窗输入框里的单价：换算后最多四位小数、去掉多余的零（0.3 美元 → 「2.0154」）。
 * 用户不改这一格时，提交按原值存回（见 ProvidersView），不让换算的舍入一来一回改掉用户的数。
 */
export function rateInputText(usd: number, currency: Currency): string {
  return String(Number(shownAmount(usd, currency).toFixed(4)));
}
