import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress, resolveAddressOrSearch } from "./address.ts";

test("带 http / https 协议的原样放行（规范化成 href）", () => {
  assert.equal(normalizeAddress("https://www.scopus.com"), "https://www.scopus.com/");
  assert.equal(normalizeAddress("  http://example.com/a?b=1  "), "http://example.com/a?b=1");
});

test("裸域名补 https，机构代理域名也认", () => {
  assert.equal(normalizeAddress("scopus.com"), "https://scopus.com/");
  assert.equal(
    normalizeAddress("www-scopus-com.ezproxy.lib.example.edu/search"),
    "https://www-scopus-com.ezproxy.lib.example.edu/search",
  );
  assert.equal(normalizeAddress("scopus.com:443/x"), "https://scopus.com/x");
});

test("本机与 IP 地址补 http", () => {
  assert.equal(normalizeAddress("localhost:5273"), "http://localhost:5273/");
  assert.equal(normalizeAddress("localhost"), "http://localhost/");
  assert.equal(normalizeAddress("192.168.1.1/admin"), "http://192.168.1.1/admin");
});

test("危险或无意义的协议一律拒绝", () => {
  assert.equal(normalizeAddress("file:///etc/passwd"), null);
  assert.equal(normalizeAddress("javascript:alert(1)"), null);
  assert.equal(normalizeAddress("data:text/html,hi"), null);
  assert.equal(normalizeAddress("chrome://settings"), null);
});

test("about:blank 放行（大小写不敏感）", () => {
  assert.equal(normalizeAddress("about:blank"), "about:blank");
  assert.equal(normalizeAddress("About:Blank"), "about:blank");
});

test("不是网址：空白、含空格、没有点的词、单字符顶级域", () => {
  assert.equal(normalizeAddress(""), null);
  assert.equal(normalizeAddress("   "), null);
  assert.equal(normalizeAddress("systematic review"), null);
  assert.equal(normalizeAddress("scopus"), null);
  assert.equal(normalizeAddress("文献检索"), null);
  assert.equal(normalizeAddress("a.b"), null);
  assert.equal(normalizeAddress("1.5"), null);
});

test("resolveAddressOrSearch：网址照走，文字交给搜索，带回原词", () => {
  assert.deepEqual(resolveAddressOrSearch("scopus.com"), { url: "https://scopus.com/", search: null });
  assert.deepEqual(resolveAddressOrSearch("  NUS  library   scopus "), {
    url: "https://www.google.com/search?q=NUS%20library%20scopus",
    search: "NUS library scopus",
  });
  assert.equal(resolveAddressOrSearch("文献检索")?.search, "文献检索");
  // 冒号不当协议：「LLM: survey」是搜索词
  assert.equal(resolveAddressOrSearch("LLM: survey")?.search, "LLM: survey");
});

test("resolveAddressOrSearch：空输入与被禁的协议回 null，不拿去搜", () => {
  assert.equal(resolveAddressOrSearch("   "), null);
  assert.equal(resolveAddressOrSearch("file:///etc/passwd"), null);
  assert.equal(resolveAddressOrSearch("javascript:alert(1)"), null);
  assert.equal(resolveAddressOrSearch("chrome://settings"), null);
  // 本地路径不拿去搜
  assert.equal(resolveAddressOrSearch("/Users/me/page.html"), null);
  assert.equal(resolveAddressOrSearch("C:\\Users\\me\\page.html"), null);
});
