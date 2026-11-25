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
    assert.deepEqual(await probeQuota(input({ kind: "zhipu-coding", probe: "plan-windows" })), {
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
