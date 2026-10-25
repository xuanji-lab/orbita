/**
 * 每日 token 用量契约 —— IPC 四层的第 1 层。
 *
 * 侧栏左下角「7 天用量格 + 星云能量体」吃的数据面：
 *   usage:week（agent-ipc.ts 的 ipcChannels.usageWeek）  renderer 拉取最近 7 天（含今天，右端是今天）
 *   usage:event（ipcChannels.usageEvent）                 主进程 → renderer 的推送（账本每次变化推一份新的 7 天快照）
 *
 * 通道常量在 agent-ipc.ts 的 ipcChannels 里（全仓一份），这里只放载荷形状与
 * 纯函数。日期一律**本地时区**（用户在哪、一天就从哪里的零点切），键形如
 * `2026-10-08`。
 */

/**
 * 一天里一个型号用了多少（悬停某一格时列出来）。型号的口径与价格 · 能力图相同：同一型号
 * 挂在几家服务商下、写成别名（k3 / kimi-k3）合成一行；显示名与头像由主进程按 modelDisplayName /
 * 型号头像的规则解析好，renderer 直接画。
 */
export interface UsageDayModel {
  /** 代表 id（头像按它取） */
  modelId: string;
  /** 显示名（modelDisplayName：声明里的名字 > 白名单 > 目录名 > id） */
  name: string;
  /** 头像第三级兜底用的服务商（ModelAvatar 的 provider：厂商条目 id 与显示名） */
  vendor: { kindId: string; label: string };
  tokens: number;
}

/**
 * 一天的用量。tokens 是当日全部模型调用的四项 token 之和——**从任务账本按「天 × 型号」汇总**
 * （与价格 · 能力图同一本账），再加上意图召回的 token；数字与改账本之前的日账本一致（测试守着）。
 */
export interface UsageDayTotal {
  /** 本地日期键 `YYYY-MM-DD`（用户时区，跨午夜按本地零点切天） */
  date: string;
  /** 当日总 token（input + output + cacheRead + cacheWrite） */
  tokens: number;
  /** 当日按型号的分布，token 多的在前；意图召回不在这里（不是对话型号），单列 intentTokens */
  models: UsageDayModel[];
  /** 当日意图召回（实验功能，DeepSeek / Proma 管线）用掉的 token */
  intentTokens: number;
  /**
   * 当日花费，按官方单价折算（套餐与订阅的零价记录也折算，与价格 · 能力图同一个价）。
   * partial = 有一部分 token 找不到单价（含意图召回），没算进去；当日没有用量为 null。
   */
  cost: { usd: number; partial: boolean } | null;
}

/**
 * `usage:event` 的推送载荷：一份完整的 7 天快照。推快照而不是推增量——
 * renderer 无状态地整份替换，漏一推也不会留下半新半旧的两张脸。
 */
export interface UsageWeekEvent {
  days: UsageDayTotal[];
}

/**
 * timestamp → 本地日期键。`timeZone` 缺省用系统时区（主进程算账、renderer 显示，
 * 同一台机器自然一致）；可注入是给测试的——跨午夜 / 跨时区的切天必须可复现，
 * 不能赌跑测试的那台机器设的是哪个时区。
 *
 * 用 `Intl.DateTimeFormat("en-CA")`：en-CA 的日期格式恰是 `YYYY-MM-DD`，
 * 不用自己拼补零。
 */
export function localDateKey(timestamp: number, timeZone?: string): string {
  return partsToLocalKey(dateParts(timestamp, timeZone));
}

/** timestamp 在目标时区里的年 / 月 / 日（零基月，与 Date 的构造器一致） */
function dateParts(
  timestamp: number,
  timeZone?: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const pick = (type: string): number => {
    const part = parts.find((p) => p.type === type)?.value;
    if (part === undefined) throw new Error("Intl 没给出日期部件，不应该发生");
    return Number(part);
  };
  return { year: pick("year"), month: pick("month") - 1, day: pick("day") };
}

/** 年月日 → 键（用 UTC 锚点归一：溢出的日会进位到月 / 年，不用自己算日历） */
function partsToLocalKey(parts: { year: number; month: number; day: number }): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(parts.year, parts.month, parts.day)));
}

/** 今天（本地）的日期键。`now` 可注入，测试与「7 天窗口」共用同一口径 */
export function todayKey(now: number, timeZone?: string): string {
  return localDateKey(now, timeZone);
}

/**
 * 从今天往回数 n 天的日期键（含今天，旧的在前）。缺的日子调用方按 0 处理——
 * 「哪天没用」与「哪天的账还没读到」在界面上都是空格，数据侧只管给键。
 *
 * 回退在**目标时区的日历空间**里做：先解出今天在那时区的年月日，再用
 * `Date.UTC(y, m, d - back)` 归一（UTC 无夏令时，日溢出交给 Date 进位），
 * 最后按 UTC 格回键。不散减 86400000——夏令时切换日不总是 24 小时，
 * 按毫秒减会在那天错位一格；也不在系统本地日历里建 Date——那会把键跟
 * 机器时区耦合，注入时区就白注了。
 */
export function dateKeysBack(count: number, now: number, timeZone?: string): string[] {
  const today = dateParts(now, timeZone);
  const keys: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const anchored = new Date(Date.UTC(today.year, today.month, today.day - back));
    keys.push(
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: "UTC",
      }).format(anchored),
    );
  }
  return keys;
}
