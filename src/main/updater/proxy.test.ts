/**
 * 更新代理环境变量的测试（updater/proxy.ts）。
 *
 * 钉住 Chromium `proxyRules` 的形状与「宁可不设，也不静默用一个坏代理」：
 * 带账号密码的值直接放弃（proxyRules 不吃凭据），认不出的协议也放弃。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hasProxySetting, proxyRulesOf } from "./proxy.ts";

describe("proxyRulesOf", () => {
  test("HTTPS_PROXY 的 URL 形态 → http/https 两条规则（同一个代理接管两者）", () => {
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "http://127.0.0.1:7897" }), "http=127.0.0.1:7897;https=127.0.0.1:7897");
  });

  test("不带 scheme 的值按 http 处理（客户端常见的写法）", () => {
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "127.0.0.1:7897" }), "http=127.0.0.1:7897;https=127.0.0.1:7897");
  });

  test("socks 的几种写法原样保留成 URL 形态（`socks5=` 这种写法 Chromium 不认）", () => {
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "socks5://127.0.0.1:1080" }), "socks5://127.0.0.1:1080");
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "socks4://127.0.0.1:1080" }), "socks4://127.0.0.1:1080");
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "socks://127.0.0.1:1080" }), "socks://127.0.0.1:1080");
  });

  test("HTTPS_PROXY 优先于 HTTP_PROXY；小写也认", () => {
    assert.equal(
      proxyRulesOf({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" }),
      "http=a:1;https=a:1",
    );
    assert.equal(proxyRulesOf({ https_proxy: "http://c:3" }), "http=c:3;https=c:3");
  });

  test("没配 / 带凭据 / 不认识的协议 → null（继续直连）", () => {
    assert.equal(proxyRulesOf({}), null);
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "   " }), null);
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "http://user:pass@127.0.0.1:7897" }), null);
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "ftp://127.0.0.1:21" }), null);
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "not a url" }), null);
  });

  test("hasProxySetting 区分「没配」与「配了但用不上」（后者要报一句，不静默直连）", () => {
    assert.equal(hasProxySetting({}), false);
    assert.equal(hasProxySetting({ HTTPS_PROXY: "   " }), false);
    assert.equal(hasProxySetting({ http_proxy: "127.0.0.1:7897" }), true);
    // 带凭据：proxyRules 用不上，但 env 里确实给了值——service 据此提醒
    assert.equal(hasProxySetting({ HTTPS_PROXY: "http://user:pass@127.0.0.1:7897" }), true);
    assert.equal(proxyRulesOf({ HTTPS_PROXY: "http://user:pass@127.0.0.1:7897" }), null);
  });
});
