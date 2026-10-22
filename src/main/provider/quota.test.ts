import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseDeepseekBalance, probeQuota, type QuotaProbeInput } from "./quota.ts";

const DEEPSEEK = "https://api.deepseek.com";

/** 替换全局 fetch，返回捕获到的请求；还原由文件末尾那一条 afterEach 统一管 */
let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function stubFetch(run: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return run(String(input), init);
  }) as typeof fetch;
  return { calls };
}

function input(overrides: Partial<QuotaProbeInput> = {}): QuotaProbeInput {
  return {
    probe: "balance",
    kind: "deepseek",
    baseUrl: DEEPSEEK,
    apiKey: "sk-test",
    ...overrides,
  };
}

const okBody = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("parseDeepseekBalance —— 公开文档接口的响应形状", () => {
  test("正常响应：两币种取第一个，金额保持字符串、拆分照搬", () => {
    const snapshot = parseDeepseekBalance(
      {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "43.21", granted_balance: "3.21", topped_up_balance: "40.00" },
          { currency: "USD", total_balance: "6.00", granted_balance: "0.00", topped_up_balance: "6.00" },
        ],
      },
      1_000,
    );
    assert.deepEqual(snapshot, {
      fetchedAt: 1_000,
      windows: [],
      credits: { amount: "43.21", currency: "CNY", granted: "3.21", toppedUp: "40.00" },
    });
    // 保精度：末尾的 0 不能被吃掉（任何 Number() 往返都会）
    assert.equal(snapshot?.credits?.toppedUp, "40.00");
  });

  test("is_available:false → 金额就是 0（厂商明说的，不是未知）", () => {
    const snapshot = parseDeepseekBalance(
      { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] },
      2_000,
    );
    assert.deepEqual(snapshot?.credits, { amount: "0", currency: "USD" });
  });

  test("没有拆分字段时不造字段", () => {
    const snapshot = parseDeepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }, 0);
    assert.deepEqual(snapshot?.credits, { amount: "1.00", currency: "CNY" });
  });

  test("结构不认（没有 balance_infos / 条目不是对象）→ null", () => {
    assert.equal(parseDeepseekBalance({}, 0), null);
    assert.equal(parseDeepseekBalance({ balance_infos: "nope" }, 0), null);
    assert.equal(parseDeepseekBalance({ balance_infos: [null] }, 0), null);
    assert.equal(parseDeepseekBalance(null, 0), null);
    assert.equal(parseDeepseekBalance([{ total_balance: "1" }], 0), null);
  });
});

describe("probeQuota —— DeepSeek 余额", () => {
  test("打的是 origin + /user/balance，带 Bearer 与 Accept，地址里的路径段被丢掉", async () => {
    const stub = stubFetch(() => okBody({ balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }));
    const result = await probeQuota(input({ baseUrl: "https://api.deepseek.com/v1/" }));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.snapshot.credits?.amount : null, "1.00");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.url, "https://api.deepseek.com/user/balance");
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-test");
    assert.equal(headers.Accept, "application/json");
  });

  test("401 → auth", async () => {
    stubFetch(() => new Response("{}", { status: 401 }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "auth", cached: null });
  });

  test("403 → auth（权限被拒与钥匙不对是同一类处置：换钥匙）", async () => {
    stubFetch(() => new Response("{}", { status: 403 }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "auth", cached: null });
  });

  test("404 → protocol（端点没了 = 厂商改版）", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "protocol", cached: null });
  });

  test("坏 JSON → protocol", async () => {
    stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "protocol", cached: null });
  });

  test("200 但结构不认 → protocol，不猜 0", async () => {
    stubFetch(() => okBody({ data: { balance: 12 } }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "protocol", cached: null });
  });

  test("5xx → network", async () => {
    stubFetch(() => new Response("oops", { status: 502 }));
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "network", cached: null });
  });

  test("fetch 抛错 / 超时 → network（一次都没打出去）", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await probeQuota(input());
    assert.deepEqual(result, { status: "error", reason: "network", cached: null });
  });

  test("没有密钥 → auth（界面要说「先填密钥」而不是「额度没了」）", async () => {
    const stub = stubFetch(() => okBody({ balance_infos: [] }));
    assert.deepEqual(await probeQuota(input({ apiKey: null })), {
      status: "error",
      reason: "auth",
      cached: null,
    });
    assert.deepEqual(await probeQuota(input({ apiKey: "" })), {
      status: "error",
      reason: "auth",
      cached: null,
    });
    assert.equal(stub.calls.length, 0, "没有密钥不该发请求");
  });

  test("capability none → none；声明了但这家没接 → unsupported", async () => {
    assert.deepEqual(await probeQuota(input({ probe: "none" })), { status: "none" });
    const stub = stubFetch(() => okBody({}));
    assert.deepEqual(await probeQuota(input({ kind: "openai-compatible", probe: "plan-windows" })), {
      status: "error",
      reason: "unsupported",
      cached: null,
    });
    assert.equal(stub.calls.length, 0);
  });

  test("baseUrl 不是合法 URL → protocol（不发请求）", async () => {
    const stub = stubFetch(() => okBody({}));
    const result = await probeQuota(input({ baseUrl: "not a url" }));
    assert.deepEqual(result, { status: "error", reason: "protocol", cached: null });
    assert.equal(stub.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * 套餐额度：智谱 / Z.AI / Kimi
 * ------------------------------------------------------------------ */

const headersOf = (call: { init?: RequestInit } | undefined): Record<string, string> =>
  (call?.init?.headers ?? {}) as Record<string, string>;

const planInput = (kind: string, overrides: Partial<QuotaProbeInput> = {}): QuotaProbeInput => ({
  probe: "plan-windows",
  kind,
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  apiKey: "sk-test",
  ...overrides,
});

/** 智谱：两条 TOKENS_LIMIT（5 小时 + 每周），重置时间一条毫秒、一条 ISO */
const ZHIPU_OK = {
  success: true,
  code: 200,
  msg: "成功",
  data: {
    level: "max",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 62.4,
        remaining: 1234,
        usage: 2000,
        currentValue: 766,
        nextResetTime: 1_700_000_000_000,
      },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 30, nextResetTime: "2026-10-30T00:00:00.000Z" },
    ],
  },
};

describe("probeQuota —— 智谱 / Z.AI 的套餐窗口", () => {
  test("按 type+unit+number 认出 5 小时与每周；percentage 就是已用；两种重置时间都认", async () => {
    const stub = stubFetch(() => okBody(ZHIPU_OK));
    const result = await probeQuota(planInput("zhipu-coding"));
    assert.equal(result.status, "ok");
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(windows, [
      {
        id: "tokens_limit:3:5",
        label: "5-hour window",
        kind: "5h",
        usedPercent: 62.4,
        windowMinutes: 300,
        resetsAt: 1_700_000_000_000,
      },
      {
        id: "tokens_limit:6:1",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 30,
        windowMinutes: 10080,
        resetsAt: Date.parse("2026-10-30T00:00:00.000Z"),
      },
    ]);
    // 端点：origin + 固定路径（baseUrl 里的 /api/anthropic 被丢掉）
    assert.equal(stub.calls[0]?.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  });

  test("只给 TIME_LIMIT → MCP 工具的每月额度（不归到 token 的月窗口）", async () => {
    stubFetch(() =>
      okBody({ success: true, code: 200, data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 12 }] } }),
    );
    const result = await probeQuota(planInput("zhipu-coding"));
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(windows, [
      { id: "time_limit:5:1", label: "MCP monthly", kind: "mcp", usedPercent: 12 },
    ]);
  });

  test("CREDIT_LIMIT（Z.AI 团队口径的同一件事）也是每月窗", async () => {
    stubFetch(() => okBody({ success: true, code: 200, data: { limits: [{ type: "CREDIT_LIMIT", percentage: 100 }] } }));
    const result = await probeQuota(planInput("zai"));
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(windows, [{ id: "credit_limit", label: "Monthly", kind: "monthly", usedPercent: 100 }]);
  });

  test("success:false / code!=200 → protocol（msg 是厂商自由文本，不拿来当分类依据）", async () => {
    stubFetch(() => okBody({ success: false, code: 1310, msg: "额度和权限异常" }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "protocol",
      cached: null,
    });
    stubFetch(() => okBody({ success: true, code: 500, msg: "boom" }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "protocol",
      cached: null,
    });
  });

  test("团队账号：成功但没有个人额度 → unsupported；错误信封提到组织也算 unsupported", async () => {
    stubFetch(() => okBody({ success: true, code: 200, data: { level: "team", limits: [] } }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "unsupported",
      cached: null,
    });
    stubFetch(() => okBody({ success: false, code: 1002, msg: "该账号属于组织，缺少组织标识" }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "unsupported",
      cached: null,
    });
  });

  test("2026-10-23 真实响应（个人账号 max 档）：5 小时 0%、每周 25%、MCP 月 6%（三种不同语义）", async () => {
    // 原文来自 open.bigmodel.cn（Z.AI 国际站同一个后端，字段一致）
    stubFetch(() =>
      okBody({
        code: 200,
        msg: "操作成功",
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 25, nextResetTime: 1_792_950_771_999 },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 4000,
              currentValue: 250,
              remaining: 3750,
              percentage: 6,
              nextResetTime: 1_793_948_515_998,
              usageDetails: [{ modelCode: "search-prime", usage: 250 }],
            },
          ],
          level: "max",
        },
        success: true,
      }),
    );
    const result = await probeQuota(planInput("zhipu-coding"));
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(
      windows.map((window) => [window.kind, window.usedPercent, window.resetsAt]),
      [
        ["5h", 0, undefined],
        ["weekly", 25, 1_792_950_771_999],
        ["mcp", 6, 1_793_948_515_998],
      ],
    );
    // percentage 是已用：MCP 那条 currentValue/usage = 250/4000 = 6.25% → 6
    assert.equal(windows[2]?.windowMinutes, undefined);
  });

  test("钥匙不对：两家都把错误装在 HTTP 200 里（code 401 / 1001）→ 也归 auth", async () => {
    // 2026-10-23 实测的响应原文：`{"code":401,"msg":"令牌已过期或验证不正确","success":false}`
    stubFetch(() => okBody({ code: 401, msg: "令牌已过期或验证不正确", success: false }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "auth",
      cached: null,
    });
    // 没带 Authorization 时是 code 1001
    stubFetch(() => okBody({ code: 1001, msg: "Header中未收到Authorization参数，无法进行身份验证。", success: false }));
    assert.deepEqual(await probeQuota(planInput("zai")), {
      status: "error",
      reason: "auth",
      cached: null,
    });
  });

  test("401 → auth；请求头是**裸 key**（加 Bearer 就是 401，这是这家最容易踩的一脚）", async () => {
    const stub = stubFetch(() => new Response("unauthorized", { status: 401 }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "auth",
      cached: null,
    });
    const headers = headersOf(stub.calls[0]);
    assert.equal(headers.Authorization, "sk-test");
    assert.equal(headers.Accept, "application/json");
    assert.equal(stub.calls.length, 1, "鉴权失败不换主机重试");
  });

  test("404 → 依次试官方主机，成功就用那一个（最多两次回退）", async () => {
    const stub = stubFetch((url) =>
      url.startsWith("https://open.bigmodel.cn")
        ? new Response("not found", { status: 404 })
        : okBody(ZHIPU_OK),
    );
    const result = await probeQuota(planInput("zhipu-coding"));
    assert.equal(result.status, "ok");
    assert.deepEqual(
      stub.calls.map((call) => call.url),
      [
        "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        "https://bigmodel.cn/api/monitor/usage/quota/limit",
      ],
    );
  });

  test("全失败按最后一次的原因归类：404 → protocol，连不上 → network", async () => {
    const notFound = stubFetch(() => new Response("not found", { status: 404 }));
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "protocol",
      cached: null,
    });
    assert.equal(notFound.calls.length, 2, "origin + 一个回退候选");

    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    assert.deepEqual(await probeQuota(planInput("zhipu-coding")), {
      status: "error",
      reason: "network",
      cached: null,
    });
  });
});

const KIMI_OK = {
  code: 0,
  usage: { remaining: 100, used: 900, resetTime: 1_700_000_000_000 },
  limits: [
    {
      window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
      detail: { remaining: 100, used: 900, resetTime: 1_700_000_000_000 },
    },
    {
      window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
      detail: { remaining: "50", used: "50", resetTime: "2026-11-01T00:00:00Z" },
    },
    { window: { duration: 45, timeUnit: "TIME_UNIT_MINUTE" }, detail: { remaining: 30, used: 15 } },
  ],
};

const kimiInput = (overrides: Partial<QuotaProbeInput> = {}): QuotaProbeInput => ({
  probe: "plan-windows",
  kind: "kimi-coding",
  baseUrl: "https://api.kimi.com/coding",
  apiKey: "sk-kimi",
  ...overrides,
});

describe("probeQuota —— Kimi Code 的套餐窗口", () => {
  test("used/(used+remaining)、duration+timeUnit → 分钟、resetTime 两种都认；Bearer 鉴权", async () => {
    const stub = stubFetch(() => okBody(KIMI_OK));
    const result = await probeQuota(kimiInput());
    assert.equal(result.status, "ok");
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(windows, [
      {
        id: "limit:0",
        label: "5-hour window",
        kind: "5h",
        usedPercent: 90,
        windowMinutes: 300,
        resetsAt: 1_700_000_000_000,
      },
      {
        id: "limit:1",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 50,
        windowMinutes: 10080,
        resetsAt: Date.parse("2026-11-01T00:00:00Z"),
      },
      // 认不出语义的长度：custom + 机器口径的短标签，不冒充 5 小时 / 每周
      { id: "limit:2", label: "45m", kind: "custom", usedPercent: 15 / 45 * 100, windowMinutes: 45 },
    ]);
    assert.equal(stub.calls[0]?.url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(headersOf(stub.calls[0]).Authorization, "Bearer sk-kimi");
  });

  test("2026-10-23 真实响应：limits 只有 5 小时窗（没有 used 字段），usage 是另一个周窗", async () => {
    // 原文：limits[0].detail 只有 limit / remaining；两个 resetTime 一个是微秒 ISO
    stubFetch(() =>
      okBody({
        usage: { limit: "100", used: "11", remaining: "89", resetTime: "2026-10-26T13:43:42.336823Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "100", resetTime: "2026-10-22T20:43:42.336823Z" },
          },
        ],
        usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.1093 } },
      }),
    );
    const result = await probeQuota(kimiInput());
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(
      windows.map((window) => [window.id, window.kind, window.usedPercent, window.windowMinutes]),
      [
        // limit / remaining 反推 used = 0；300 分钟 = 5 小时
        ["limit:0", "5h", 0, 300],
        // usage 的 11 / (11 + 89)
        ["usage", "weekly", 11, 10080],
      ],
    );
    assert.equal(windows[0]?.resetsAt, Date.parse("2026-10-22T20:43:42.336823Z"));
    assert.equal(windows[1]?.resetsAt, Date.parse("2026-10-26T13:43:42.336823Z"));
  });

  test("没有 limits 只有 usage → 一个周窗（id 固定 usage）", async () => {
    stubFetch(() => okBody({ code: 0, usage: { remaining: 250, used: 750, resetTime: 1_700_000_000_000 } }));
    const result = await probeQuota(kimiInput());
    assert.deepEqual(result.status === "ok" ? result.snapshot.windows : [], [
      {
        id: "usage",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 75,
        windowMinutes: 10080,
        resetsAt: 1_700_000_000_000,
      },
    ]);
  });

  test("分母为 0 的窗口被跳过（不写 0% 冒充），其余照常", async () => {
    stubFetch(() =>
      okBody({
        code: 0,
        usage: { remaining: 0, used: 0 },
        limits: [
          { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { remaining: 0, used: 0 } },
          { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { remaining: 25, used: 75 } },
        ],
      }),
    );
    const result = await probeQuota(kimiInput());
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(
      windows.map((window) => window.id),
      ["limit:1"],
    );
  });

  test("404 → protocol；连不上 → network（这一家没有可换的主机）", async () => {
    const notFound = stubFetch(() => new Response("not found", { status: 404 }));
    assert.deepEqual(await probeQuota(kimiInput()), { status: "error", reason: "protocol", cached: null });
    assert.equal(notFound.calls.length, 1);

    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(await probeQuota(kimiInput()), { status: "error", reason: "network", cached: null });
  });

  test("业务码不对 / 一个窗都没有 → protocol；没有密钥 → auth 且不发请求", async () => {
    stubFetch(() => okBody({ code: 40100, msg: "invalid key" }));
    assert.deepEqual(await probeQuota(kimiInput()), { status: "error", reason: "protocol", cached: null });

    stubFetch(() => okBody({ code: 0 }));
    assert.deepEqual(await probeQuota(kimiInput()), { status: "error", reason: "protocol", cached: null });

    const stub = stubFetch(() => okBody(KIMI_OK));
    assert.deepEqual(await probeQuota(kimiInput({ apiKey: null })), {
      status: "error",
      reason: "auth",
      cached: null,
    });
    assert.equal(stub.calls.length, 0);
  });
});

const opencodeInput = (overrides: Partial<QuotaProbeInput> = {}): QuotaProbeInput => ({
  probe: "plan-windows",
  kind: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "sk-oc",
  ...overrides,
});

describe("probeQuota —— OpenCode Go 的订阅窗口", () => {
  test("三窗口齐全：kind / 已用百分比 / 重置时刻；URL 与 Bearer 鉴权", async () => {
    const stub = stubFetch(() =>
      okBody({
        usage: {
          rolling: { status: "ok", percent: 42, resetsAt: "2026-10-23T05:00:00Z" },
          weekly: { status: "ok", percent: 7.5, resetsAt: "2026-10-27T00:00:00.000Z" },
          monthly: { status: "ok", percent: 0 },
        },
      }),
    );
    const result = await probeQuota(opencodeInput());
    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" ? result.snapshot.windows : [], [
      { id: "rolling", label: "Rolling window", kind: "rolling", usedPercent: 42, resetsAt: Date.parse("2026-10-23T05:00:00Z") },
      { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 7.5, resetsAt: Date.parse("2026-10-27T00:00:00.000Z") },
      // 没有 resetsAt 就不造一个
      { id: "monthly", label: "Monthly", kind: "monthly", usedPercent: 0 },
    ]);
    assert.equal(stub.calls[0]?.url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(headersOf(stub.calls[0]).Authorization, "Bearer sk-oc");
    assert.equal(headersOf(stub.calls[0]).Accept, "application/json");
  });

  test("只有 weekly 就只报一个窗口，不补别的", async () => {
    stubFetch(() => okBody({ usage: { weekly: { status: "ok", percent: 12, resetsAt: "2026-10-27T00:00:00Z" } } }));
    const result = await probeQuota(opencodeInput());
    assert.deepEqual(
      (result.status === "ok" ? result.snapshot.windows : []).map((window) => window.id),
      ["weekly"],
    );
  });

  test("percent 缺了跳过该窗口（不写 0%）；status 不参与计算（rate-limited 也照收）", async () => {
    stubFetch(() =>
      okBody({
        usage: {
          rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-10-23T05:00:00Z" },
          weekly: { status: "rate-limited" },
          monthly: null,
        },
      }),
    );
    const result = await probeQuota(opencodeInput());
    const windows = result.status === "ok" ? result.snapshot.windows : [];
    assert.deepEqual(
      windows.map((window) => [window.id, window.usedPercent]),
      [["rolling", 100]],
    );
  });

  test("401 → auth；403 → unsupported（没订阅 / 凭据不合法，不是钥匙错）；404 → protocol", async () => {
    stubFetch(() => new Response("{}", { status: 401 }));
    assert.deepEqual(await probeQuota(opencodeInput()), { status: "error", reason: "auth", cached: null });

    stubFetch(() => new Response("{}", { status: 403 }));
    assert.deepEqual(await probeQuota(opencodeInput()), {
      status: "error",
      reason: "unsupported",
      cached: null,
    });

    stubFetch(() => new Response("not found", { status: 404 }));
    assert.deepEqual(await probeQuota(opencodeInput()), { status: "error", reason: "protocol", cached: null });
  });

  test("5xx / 连不上 → network；结构不认 → protocol", async () => {
    stubFetch(() => new Response("oops", { status: 502 }));
    assert.deepEqual(await probeQuota(opencodeInput()), { status: "error", reason: "network", cached: null });

    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(await probeQuota(opencodeInput()), { status: "error", reason: "network", cached: null });

    stubFetch(() => okBody({ usage: {} }));
    assert.deepEqual(await probeQuota(opencodeInput()), { status: "error", reason: "protocol", cached: null });
  });
});
