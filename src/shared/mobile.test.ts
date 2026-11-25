import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBindAddress,
  deriveMobileSessionState,
  errorReply,
  isBindableAddress,
  isMobilePort,
  mobileNotification,
  MOBILE_CRYPTO,
  MOBILE_FRAME_MAX_BYTES,
  MOBILE_LIMITS,
  MOBILE_METHODS,
  MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES,
  MOBILE_OUTBOUND_WIRE_MAX_BYTES,
  MOBILE_REQUEST_ID_MAX,
  okReply,
  sortBindCandidates,
  type MobileBindCandidate,
} from "./mobile.ts";

describe("可绑地址的分类与排序", () => {
  test("Tailscale 段、三段私网、回环各归各类", () => {
    assert.equal(classifyBindAddress("100.100.101.102"), "tailscale");
    assert.equal(classifyBindAddress("100.64.0.1"), "tailscale");
    assert.equal(classifyBindAddress("100.127.255.254"), "tailscale");
    assert.equal(classifyBindAddress("10.1.2.3"), "private");
    assert.equal(classifyBindAddress("172.16.0.1"), "private");
    assert.equal(classifyBindAddress("172.31.255.1"), "private");
    assert.equal(classifyBindAddress("192.168.1.20"), "private");
    assert.equal(classifyBindAddress("127.0.0.1"), "loopback");
  });

  test("公网、链路本地、段边界之外、IPv6、乱写的都不列", () => {
    // 100.63 / 100.128 是段边界的外侧；172.15 / 172.32 是私网段的外侧
    assert.equal(classifyBindAddress("100.63.255.255"), null);
    assert.equal(classifyBindAddress("100.128.0.1"), null);
    assert.equal(classifyBindAddress("172.15.0.1"), null);
    assert.equal(classifyBindAddress("172.32.0.1"), null);
    assert.equal(classifyBindAddress("8.8.8.8"), null);
    assert.equal(classifyBindAddress("169.254.10.1"), null);
    assert.equal(classifyBindAddress("0.0.0.0"), null);
    assert.equal(classifyBindAddress("256.1.1.1"), null);
    assert.equal(classifyBindAddress("fe80::1%en0"), null);
    assert.equal(classifyBindAddress("fd7a:115c:a1e0::1"), null);
    assert.equal(classifyBindAddress("::1"), null);
    assert.equal(classifyBindAddress("192.168.1"), null);
    assert.equal(classifyBindAddress(""), null);
    assert.equal(isBindableAddress("203.0.113.5"), false);
    assert.equal(isBindableAddress("192.168.1.20"), true);
  });

  test("IPv4 映射的 IPv6 写法按里面的 IPv4 判", () => {
    assert.equal(classifyBindAddress("::ffff:192.168.1.20"), "private");
    assert.equal(classifyBindAddress("::FFFF:100.100.1.2"), "tailscale");
  });

  test("排序：Tailscale → 私网 → 回环，同一类里保持原来的顺序", () => {
    const candidates: MobileBindCandidate[] = [
      { address: "127.0.0.1", kind: "loopback", interfaceName: "lo0" },
      { address: "192.168.1.20", kind: "private", interfaceName: "en5" },
      { address: "100.100.101.102", kind: "tailscale", interfaceName: "utun6" },
      { address: "192.168.5.9", kind: "private", interfaceName: "en0" },
    ];
    assert.deepEqual(
      sortBindCandidates(candidates).map((candidate) => candidate.address),
      ["100.100.101.102", "192.168.1.20", "192.168.5.9", "127.0.0.1"],
    );
    // 不改原数组
    assert.equal(candidates[0]?.address, "127.0.0.1");
  });

  test("端口只认 1–65535 的整数", () => {
    assert.equal(isMobilePort(47620), true);
    assert.equal(isMobilePort(1), true);
    assert.equal(isMobilePort(65535), true);
    for (const bad of [0, 65536, 47620.5, "47620", null, NaN, Infinity, undefined]) assert.equal(isMobilePort(bad), false);
  });
});

describe("deriveMobileSessionState：五种状态与优先级", () => {
  const idle = { phase: undefined, planAwaiting: false, unread: null, settledRecently: false };

  test("什么都没有 = 空闲", () => {
    assert.equal(deriveMobileSessionState(idle), "idle");
    assert.equal(deriveMobileSessionState({ ...idle, phase: "idle" }), "idle");
  });

  test("计划等确认 = 等你，压过在跑", () => {
    assert.equal(deriveMobileSessionState({ ...idle, planAwaiting: true }), "waiting");
    assert.equal(deriveMobileSessionState({ ...idle, planAwaiting: true, phase: "turn" }), "waiting");
  });

  test("在跑压过未读：又开了一轮就不再是「跑完」", () => {
    for (const phase of ["turn", "compaction", "retry", "branch_summary"]) {
      assert.equal(deriveMobileSessionState({ ...idle, phase }), "running");
    }
    assert.equal(deriveMobileSessionState({ ...idle, phase: "turn", unread: { failed: true } }), "running");
    assert.equal(deriveMobileSessionState({ ...idle, phase: "turn", settledRecently: true }), "running");
  });

  test("未读带 failed = 没看成；未读或刚落定 = 跑完没看", () => {
    assert.equal(deriveMobileSessionState({ ...idle, unread: { failed: true } }), "failed");
    assert.equal(deriveMobileSessionState({ ...idle, unread: { failed: false } }), "done");
    assert.equal(deriveMobileSessionState({ ...idle, settledRecently: true }), "done");
    // failed 的未读压过「刚落定」
    assert.equal(deriveMobileSessionState({ ...idle, unread: { failed: true }, settledRecently: true }), "failed");
  });
});

describe("方法名单与出站构造", () => {
  test("十个方法，手机只能调这些", () => {
    assert.deepEqual([...MOBILE_METHODS], [
      "sessions.list",
      "sessions.watch",
      "sessions.unwatch",
      "tail.load",
      "tail.watch",
      "tail.unwatch",
      "reply",
      "stop",
      "unread.clear",
      "ping",
    ]);
  });

  test("应答与通知的形状", () => {
    assert.deepEqual(okReply(3, { now: 7 }), { id: 3, ok: true, result: { now: 7 } });
    assert.deepEqual(okReply(3, null), { id: 3, ok: true, result: null });
    assert.deepEqual(errorReply(4, "busy", "排队满了"), { id: 4, ok: false, error: { code: "busy", message: "排队满了" } });
    assert.deepEqual(mobileNotification("tail.changed", { sessionId: "s", rev: 12 }), {
      event: "tail.changed",
      params: { sessionId: "s", rev: 12 },
    });
    assert.deepEqual(mobileNotification("host.shutdown", {}), { event: "host.shutdown", params: {} });
  });
});


describe("单帧上限：线上字节与明文字节对得上（契约给两端的那几个数）", () => {
  /** 一帧加密帧的线上字节：帧外壳 + base64(明文 ‖ 16 字节 tag)。seq 按 16 位十进制算，留足 */
  const wireBytes = (plaintextBytes: number): number =>
    new TextEncoder().encode(`{"v":1,"n":${Number.MAX_SAFE_INTEGER},"ct":""}`).length + 4 * Math.ceil((plaintextBytes + MOBILE_CRYPTO.tagBytes) / 3);

  test("请求 id 的上限两端写死", () => {
    assert.equal(MOBILE_REQUEST_ID_MAX, 0x7fffffff);
  });

  test("电脑 → 手机：明文写满 256 KB 的一帧，线上不超过 384 KB，且确实比明文多出 base64 的那 1/3", () => {
    assert.equal(MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES, 256 * 1024);
    assert.equal(MOBILE_OUTBOUND_WIRE_MAX_BYTES, 384 * 1024);
    const wire = wireBytes(MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES);
    assert.ok(wire <= MOBILE_OUTBOUND_WIRE_MAX_BYTES, `${wire}`);
    assert.ok(wire > MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES, "手机按 256 KB 设入站上限会收不下");
  });

  test("手机 → 电脑：合法请求里最大的一条（4000 字、每字 4 个字节）线上远不到 64 KB", () => {
    const body = JSON.stringify({
      id: Number.MAX_SAFE_INTEGER,
      method: "reply",
      params: { sessionId: "0199a0aa-6bb0-7cc0-8000-123456789012", text: "😀".repeat(MOBILE_LIMITS.replyText), requestId: "r".repeat(MOBILE_LIMITS.requestId) },
    });
    const wire = wireBytes(new TextEncoder().encode(body).length);
    assert.ok(wire < MOBILE_FRAME_MAX_BYTES / 2, `${wire}`);
  });
});
