/**
 * 额度块的纯展示逻辑 —— 设置页的 `QuotaBlock` 与底栏环的菜单行共用这一份，
 * 两处不能对同一份快照说两套话（「62% used · 2h 14m」在两处必须一模一样）。
 *
 * 这里只有计算与字符串拼接，不碰 React、不发请求——所以能直接单测。
 * 方向只有已用（`usedPercent`），数字后面永远带 used（decisions 6）。
 */
import type { Messages } from "../../messages-en.ts";
import type { MenuItem } from "../../shell/Menu";
import type { QuotaCredits, QuotaExhaustedHint, QuotaFailure, QuotaProbe, QuotaResult, QuotaSnapshot, QuotaWindow, QuotaWindowKind } from "@shared/quota";

/** 金额：符号紧贴数字（`¥43.21`，中间不留空格）；不认识的币种把代码放在后面 */
const SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "JP¥",
};

export function formatMoney(credits: QuotaCredits): string {
  const symbol = SYMBOLS[credits.currency.toUpperCase()];
  if (symbol !== undefined) return `${symbol}${credits.amount}`;
  const code = credits.currency.trim();
  return code === "" ? credits.amount : `${credits.amount} ${code}`;
}

/**
 * 窗口名。**两处（设置页的额度块与环菜单行）必须用这一个函数**：
 * 智谱 / Kimi 都没给人读的标签，只给了 type / unit / duration 这类机器字段，
 * 我们猜出的语义类别存在 `kind` 里——已知就取本地化文案（中文界面不能出现英文），
 * 认不出（`custom` / 旧快照）才用厂商原文 `label`。
 */
export function windowLabel(window: QuotaWindow, t: Messages): string {
  return kindLabel(window.kind, window.label, t);
}

/**
 * 与 `windowLabel` 同一口径，但吃的是一对裸事实（`failed` 事件里的额度提示
 * 只有 kind + label，没有完整窗口）——不为了叫一个名字去伪造一个 `QuotaWindow`。
 */
export function kindLabel(kind: QuotaWindowKind | undefined, label: string, t: Messages): string {
  if (kind === undefined || kind === "custom") return label;
  return t.quota.windowKind[kind];
}

/** 已用百分比取整并夹到 0–100：厂商给小数，界面不显示 62.4% */
export function usedPercent(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.usedPercent)));
}

/** 进度条宽度用的比例（0–1），与 `progress` 字段同一口径 */
export function progressOf(window: QuotaWindow): number {
  return usedPercent(window) / 100;
}

/** 时长走 mono 机器口径，不翻译：`2h 14m` / `41m` / `30s` */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

/** 「多久以前」的人类说法。分钟以下算刚刚——额度不需要秒级精度 */
export function ageLabel(ms: number, t: Messages): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t.quota.justNow;
  if (minutes < 60) return t.quota.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.quota.hoursAgo(hours);
  return t.quota.daysAgo(Math.floor(hours / 24));
}

/** 页脚那句「Checked 1 min ago」——失败时由 `failedLabel` 接手 */
export function checkedLabel(fetchedAt: number, now: number, t: Messages): string {
  const age = now - fetchedAt;
  if (age < 60_000) return t.quota.checkedJustNow;
  return t.quota.checked(ageLabel(age, t));
}

/** 刷新失败但旧值还在：页脚说清「旧到什么程度 + 原因」，不把整块换成错误页 */
export function failedLabel(reason: QuotaFailure, fetchedAt: number, now: number, t: Messages): string {
  return t.quota.failedKeeping(failureText(reason, t), ageLabel(now - fetchedAt, t));
}

/** 失败原因分类的三类说法（decisions 15）：钥匙 / 厂商改版 / 网络 */
export function failureText(reason: QuotaFailure, t: Messages): string {
  switch (reason) {
    case "auth":
      return t.quota.reasonAuth;
    case "protocol":
      return t.quota.reasonProtocol;
    case "unsupported":
      return t.quota.reasonUnsupported;
    case "network":
      return t.quota.reasonNetwork;
  }
}

/**
 * 窗口的重置时刻：还剩多少（`resets in 2h 14m`）。
 * 没有 `resetsAt`、或已经过点了就不写——「0m 后重置」是句假话，厂商的窗口会自动续上。
 */
export function resetLabel(window: QuotaWindow, now: number, t: Messages): string | null {
  if (window.resetsAt === undefined) return null;
  const remaining = window.resetsAt - now;
  if (remaining <= 0) return null;
  return t.quota.resetsIn(formatDuration(remaining));
}

/** `62% used` —— 数字后面永远带 used（decisions 6） */
export function usedText(percent: number, t: Messages): string {
  return `${percent}% ${t.quota.usedUnit}`;
}

/**
 * 额度窗口用尽时的「账户状态」行（`5 小时窗口已用尽 · 2h 14m 后重置`，带「账户额度：」前缀）。
 *
 * 句子在 renderer 组（主进程只给 `kind` / `label` / `resetsAt`）：窗口名走
 * `kindLabel`，时长用 `formatDuration`，两者与设置页的额度块同一口径。
 * 渲染时重置时刻已经过点就不说时间——「0s 后重置」是句假话。
 *
 * **它是账户状态，不是失败原因**：缓存只说明窗口满了，说不了这次失败是谁造成的
 * （钥匙过期 + 恰好窗口满时，主因是 401），所以渲染位置只能在厂商原文之后。
 */
export function quotaExhaustedText(hint: QuotaExhaustedHint, now: number, t: Messages): string {
  const label = kindLabel(hint.kind, hint.label, t);
  const remaining = hint.resetsAt - now;
  if (remaining <= 0) return t.quota.exhaustedNoReset(label);
  return t.quota.exhausted(label, formatDuration(remaining));
}

/** 环里的值行：`62% used · 2h 14m`（紧凑，不带 resets in 的介词） */
export function windowValueText(window: QuotaWindow, now: number, t: Messages): string {
  const used = usedText(usedPercent(window), t);
  if (window.resetsAt === undefined) return used;
  const remaining = window.resetsAt - now;
  if (remaining <= 0) return used;
  return `${used} · ${formatDuration(remaining)}`;
}

/** 余额小字：`topped up ¥40.00 · granted ¥3.21`；缺一半就只说有的那半 */
export function creditsBreakdownText(credits: QuotaCredits, t: Messages): string | null {
  const parts: string[] = [];
  if (credits.toppedUp !== undefined) parts.push(t.quota.toppedUp(formatMoney({ ...credits, amount: credits.toppedUp })));
  if (credits.granted !== undefined) parts.push(t.quota.granted(formatMoney({ ...credits, amount: credits.granted })));
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * 从来没有可展示的值时，这一行说清是哪一种不通（decisions 15）：
 * 钥匙不对 / 厂商改版 / 网络——以及「这家就是查不了」。
 *
 * 鉴权失败分两句：盘上有钥匙 = 厂商拒了它（改钥匙），没钥匙 = 先填一把。
 * 两者都不是「额度为 0」。
 */
export function quotaProblemText(failure: QuotaFailure, t: Messages, hasKey?: boolean): string {
  if (failure === "auth") return hasKey === false ? t.quota.authMissing : t.quota.authRejected;
  if (failure === "unsupported") return t.quota.teamUnsupported;
  return t.quota.failedAlone(failureText(failure, t));
}

/** 结果 → 能展示的快照：成功那份，或失败时保留的上一次成功 */
export function snapshotOf(result: QuotaResult | null): QuotaSnapshot | null {
  if (result === null || result.status === "none") return null;
  return result.status === "ok" ? result.snapshot : result.cached;
}

/**
 * 底栏环菜单里的 Account 段（`Menu` 的 items）。
 *
 * 两条纪律写在这里：
 *   - capability 为 none 时整段不出现（连标题也不留）；
 *   - **这一层不画 loading**：值只来自缓存；没有值时就给「立即查询」这一行动作。
 *     唯一的例外是用户刚点了它：那时把标签换成「正在查询」（文字，不是转圈）。
 *
 * `providerName` 是**实例显示名**（不是目录名）：用户可能把同一个厂商加两次并改名成
 * 「DeepSeek 2」，而环卡里只有一行，「余额」不说自己是谁的余额就分不出来。
 */
export function quotaMenuItems(
  result: QuotaResult | null,
  probe: QuotaProbe,
  busy: boolean,
  t: Messages,
  providerName: string | undefined,
  onCheckNow: () => void,
): MenuItem[] {
  if (probe === "none") return [];
  const now = Date.now();
  const snapshot = snapshotOf(result);
  const failure = result !== null && result.status === "error" ? result.reason : null;
  const items: MenuItem[] = [
    {
      id: "quota-account",
      label: t.quota.account,
      header: true,
      // 分组头带 hint：右缘写这家是谁（Menu 的 header 行本来就支持，不用改 Menu）
      ...(providerName === undefined || providerName === "" ? {} : { hint: providerName }),
    },
  ];

  if (snapshot === null) {
    items.push({
      id: "quota-problem",
      label: failure === null ? t.quota.notCheckedYet : quotaProblemText(failure, t),
      fact: true,
    });
    items.push({
      id: "quota-check",
      label: busy ? t.quota.checking : t.quota.checkNow,
      icon: "refresh-cw",
      keepOpen: true,
      disabled: busy,
      onSelect: onCheckNow,
    });
    return items;
  }

  const credits = snapshot.credits;
  if (credits !== undefined) {
    items.push({
      id: "quota-balance",
      label: t.quota.balance,
      hint: credits.unlimited === true ? t.quota.unlimited : formatMoney(credits),
      fact: true,
    });
  }
  for (const window of snapshot.windows) {
    items.push({
      id: `quota-${window.id}`,
      // 窗口名与设置页同一份口径（见 windowLabel）
      label: windowLabel(window, t),
      hint: windowValueText(window, now, t),
      fact: true,
      progress: progressOf(window),
    });
  }
  items.push({
    id: "quota-checked",
    label:
      failure === null
        ? checkedLabel(snapshot.fetchedAt, now, t)
        : failedLabel(failure, snapshot.fetchedAt, now, t),
    fact: true,
  });
  return items;
}
