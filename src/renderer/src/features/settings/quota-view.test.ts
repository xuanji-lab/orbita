import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  checkedLabel,
  creditsBreakdownText,
  failedLabel,
  formatDuration,
  formatMoney,
  progressOf,
  quotaExhaustedText,
  quotaMenuItems,
  resetLabel,
  usedPercent,
  windowLabel,
  windowValueText,
} from "./quota-view.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import type { QuotaResult, QuotaWindow } from "@shared/quota";

const window = (overrides: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "tokens:3:5",
  label: "5-hour window",
  usedPercent: 62,
  ...overrides,
});

describe("formatMoney —— 金额保精度、符号不留空格", () => {
  test("认识的币种写符号，不认识的把代码放在后面", () => {
    assert.equal(formatMoney({ amount: "43.21", currency: "CNY" }), "¥43.21");
    assert.equal(formatMoney({ amount: "40.00", currency: "USD" }), "$40.00");
    assert.equal(formatMoney({ amount: "6.50", currency: "SGD" }), "6.50 SGD");
    assert.equal(formatMoney({ amount: "0", currency: "" }), "0");
  });

  test("字符串原样：末尾的 0 不被吃掉", () => {
    assert.equal(formatMoney({ amount: "40.00", currency: "CNY" }), "¥40.00");
  });
});

describe("formatDuration —— 机器口径，不翻译", () => {
  test("天 / 时 / 分 / 秒各一档", () => {
    assert.equal(formatDuration((2 * 60 + 14) * 60_000), "2h 14m");
    assert.equal(formatDuration(41 * 60_000), "41m");
    assert.equal(formatDuration(30_000), "30s");
    assert.equal(formatDuration((26 * 60 + 5) * 60_000), "1d 2h");
  });

  test("负数（时钟回拨 / 过点）夹到 0s", () => {
    assert.equal(formatDuration(-5_000), "0s");
  });
});

describe("窗口的展示", () => {
  const now = 1_700_000_000_000;

  test("已用百分比取整并夹到 0–100；条宽同口径", () => {
    assert.equal(usedPercent(window({ usedPercent: 62.4 })), 62);
    assert.equal(usedPercent(window({ usedPercent: 100 })), 100);
    assert.equal(usedPercent(window({ usedPercent: 120 })), 100);
    assert.equal(usedPercent(window({ usedPercent: -3 })), 0);
    assert.equal(progressOf(window({ usedPercent: 50 })), 0.5);
  });

  test("值行带 used，后面接剩余时长（环里那一行）", () => {
    assert.equal(
      windowValueText(window({ resetsAt: now + (2 * 60 + 14) * 60_000 }), now, en),
      "62% used · 2h 14m",
    );
    // 不知道什么时候重置就只写已用，不编一个时间
    assert.equal(windowValueText(window(), now, en), "62% used");
    // 已经过点：不再写剩余
    assert.equal(windowValueText(window({ resetsAt: now - 1 }), now, en), "62% used");
  });

  test("中文同样带「已用」：数字后面永远有那个词", () => {
    assert.equal(windowValueText(window(), now, zh), "62% 已用");
  });

  test("重置行：有将来时间才写", () => {
    assert.equal(resetLabel(window({ resetsAt: now + 41 * 60_000 }), now, en), "resets in 41m");
    assert.equal(resetLabel(window(), now, en), null);
    assert.equal(resetLabel(window({ resetsAt: now }), now, en), null);
  });
});

describe("页脚的时间说法", () => {
  const now = 1_700_000_000_000;

  test("不到一分钟算刚刚，之后按分 / 时 / 天走", () => {
    assert.equal(ageLabel(30_000, en), "just now");
    assert.equal(ageLabel(12 * 60_000, en), "12 min ago");
    assert.equal(ageLabel(3 * 3_600_000, en), "3h ago");
    assert.equal(ageLabel(2 * 86_400_000, en), "2d ago");
    assert.equal(checkedLabel(now - 30_000, now, en), "Checked just now");
    assert.equal(checkedLabel(now - 60_000, now, en), "Checked 1 min ago");
  });

  test("中文的分 / 时 / 天：数字与汉字之间一个空格", () => {
    assert.equal(ageLabel(12 * 60_000, zh), "12 分钟前");
    assert.equal(zh.quota.checked("12 分钟前"), "查于 12 分钟前");
  });

  test("刷新失败：原因分类 + 旧值多久以前", () => {
    assert.equal(
      failedLabel("network", now - 12 * 60_000, now, en),
      "Couldn't refresh (network error) · 12 min ago",
    );
    assert.equal(failedLabel("auth", now - 12 * 60_000, now, zh), "刷新失败（密钥无效） · 12 分钟前");
  });
});

describe("余额小字", () => {
  test("两个拆分都在时用 · 分开；缺一个就只说有的那个；都没有返回 null", () => {
    assert.equal(
      creditsBreakdownText({ amount: "43.21", currency: "CNY", toppedUp: "40.00", granted: "3.21" }, en),
      "topped up ¥40.00 · granted ¥3.21",
    );
    assert.equal(creditsBreakdownText({ amount: "43.21", currency: "CNY", granted: "3.21" }, en), "granted ¥3.21");
    assert.equal(creditsBreakdownText({ amount: "43.21", currency: "CNY" }, en), null);
  });
});

const NOW = Date.now();
const okResult = (snapshot: { credits?: { amount: string; currency: string }; windows?: QuotaWindow[]; fetchedAt: number }): QuotaResult => ({
  status: "ok",
  fromCache: false,
  snapshot: { windows: [], ...snapshot },
});

const labels = (items: ReturnType<typeof quotaMenuItems>) => items.map((item) => item.label);

describe("窗口名 —— 已知语义类别就本地化", () => {
  test("kind 已知 → 本地化文案（中文界面不能出现英文 label）", () => {
    assert.equal(windowLabel(window({ kind: "5h" }), zh), "5 小时");
    assert.equal(windowLabel(window({ kind: "weekly" }), zh), "每周");
    assert.equal(windowLabel(window({ kind: "monthly" }), zh), "每月");
    assert.equal(windowLabel(window({ kind: "5h" }), en), "5-hour window");
  });

  test("MCP 月额度与套餐月窗口不是同一件事：两种 kind 两种文案", () => {
    // 智谱的第三行是 MCP 工具的月额度，混写成「每月」会把两件事说成一件
    assert.equal(windowLabel(window({ kind: "mcp", label: "MCP monthly" }), zh), "MCP 每月");
    assert.equal(windowLabel(window({ kind: "mcp", label: "MCP monthly" }), en), "MCP monthly");
    assert.notEqual(windowLabel(window({ kind: "mcp" }), zh), windowLabel(window({ kind: "monthly" }), zh));
  });

  test("OpenCode Go 的滚动窗：不是 5 小时，也不是每月", () => {
    assert.equal(windowLabel(window({ kind: "rolling", label: "Rolling window" }), zh), "滚动窗口");
    assert.equal(windowLabel(window({ kind: "rolling", label: "Rolling window" }), en), "Rolling window");
  });

  test("custom / 没有 kind（旧快照、余额类）→ 厂商原文", () => {
    assert.equal(windowLabel(window({ kind: "custom", label: "TOKENS_LIMIT" }), zh), "TOKENS_LIMIT");
    assert.equal(windowLabel(window({ label: "45m" }), zh), "45m");
  });

  test("环菜单与设置页同一口径：菜单行也用本地化后的名字", () => {
    const items = quotaMenuItems(
      okResult({
        windows: [{ id: "tokens_limit:6:1", label: "Weekly", kind: "weekly", usedPercent: 30 }],
        fetchedAt: NOW,
      }),
      "plan-windows",
      false,
      zh,
      undefined,
      () => undefined,
    );
    assert.deepEqual(labels(items), ["账户", "每周", "刚刚查过"]);
  });
});

describe("quotaMenuItems —— 环菜单里的 Account 段", () => {
  test("能力为 none：整段不出现（连标题都没有）", () => {
    assert.deepEqual(quotaMenuItems(null, "none", false, en, undefined, () => undefined), []);
  });

  test("从未查过：标题 + 事实行 + 立即查询（作战行可点）", () => {
    const items = quotaMenuItems(null, "balance", false, en, undefined, () => undefined);
    assert.deepEqual(labels(items), ["Account", "Not checked yet.", "Check now"]);
    assert.equal(items[0]?.header, true);
    assert.equal(items[1]?.fact, true);
    assert.equal(items[2]?.disabled, false);
  });

  test("分组头带实例显示名：余额不会说不清是谁的（同一家加两次也能区分）", () => {
    const named = quotaMenuItems(null, "balance", false, en, "DeepSeek 2", () => undefined);
    assert.equal(named[0]?.header, true);
    assert.equal(named[0]?.hint, "DeepSeek 2");
    // 不传 / 空串就只是普通标题，不造一个空 hint
    assert.equal("hint" in (quotaMenuItems(null, "balance", false, en, undefined, () => undefined)[0] ?? {}), false);
    assert.equal("hint" in (quotaMenuItems(null, "balance", false, en, "", () => undefined)[0] ?? {}), false);
  });

  test("查询中（用户刚点的）：标签换成正在查询且禁用，不出转圈", () => {
    const items = quotaMenuItems(null, "balance", true, en, undefined, () => undefined);
    assert.equal(items.at(-1)?.label, "Checking…");
    assert.equal(items.at(-1)?.disabled, true);
  });

  test("没有旧值时的失败：说清分类，不冒充 0", () => {
    const items = quotaMenuItems({ status: "error", reason: "network", cached: null }, "balance", false, en, undefined, () => undefined);
    assert.deepEqual(labels(items), ["Account", "Couldn't refresh (network error).", "Check now"]);
  });

  test("有值：余额与每个窗口各一行，窗行带 progress，页脚写查于何时", () => {
    const items = quotaMenuItems(
      okResult({
        credits: { amount: "43.21", currency: "CNY" },
        windows: [{ id: "tokens:3:5", label: "5-hour window", usedPercent: 62 }],
        fetchedAt: NOW - 12 * 60_000,
      }),
      "balance",
      false,
      en,
      undefined,
      () => undefined,
    );
    assert.deepEqual(labels(items), ["Account", "Balance", "5-hour window", "Checked 12 min ago"]);
    assert.equal(items[1]?.hint, "¥43.21");
    assert.equal(items[2]?.hint, "62% used");
    assert.equal(items[2]?.progress, 0.62);
  });

  test("有值但刷新失败：页脚写原因 + 旧值多久以前（值照旧显示）", () => {
    const items = quotaMenuItems(
      {
        status: "error",
        reason: "protocol",
        cached: { credits: { amount: "6.00", currency: "USD" }, windows: [], fetchedAt: NOW - 12 * 60_000 },
      },
      "balance",
      false,
      en,
      undefined,
      () => undefined,
    );
    assert.equal(items.at(-1)?.label, "Couldn't refresh (unexpected response) · 12 min ago");
    assert.equal(items[1]?.label, "Balance");
  });
});

// ── 额度用尽导致的失败：人话在 renderer 组（主进程只给事实） ──

describe("quotaExhaustedText —— 窗口用尽时的那句人话", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 23, 9, 0, 0);
  const hint = { kind: "5h" as const, label: "5-hour window", resetsAt: now + 2 * HOUR + 14 * 60_000 };

  test("中文：窗口名本地化 + 时长走机器口径", () => {
    assert.equal(quotaExhaustedText(hint, now, zh), "5 小时窗口已用尽 · 2h 14m 后重置");
  });

  test("英文：同一份事实，同一份时长", () => {
    assert.equal(quotaExhaustedText(hint, now, en), "5-hour window exhausted · resets in 2h 14m");
  });

  test("custom 名字用厂商原文，不硬翻", () => {
    assert.equal(
      quotaExhaustedText({ ...hint, kind: "custom", label: "TOKENS_LIMIT" }, now, zh),
      "TOKENS_LIMIT窗口已用尽 · 2h 14m 后重置",
    );
  });

  test("渲染时已经过点：不说时间（「0s 后重置」是句假话）", () => {
    assert.equal(quotaExhaustedText(hint, hint.resetsAt + 1, zh), "5 小时窗口已用尽");
    assert.equal(quotaExhaustedText(hint, hint.resetsAt + 1, en), "5-hour window exhausted");
  });
});
