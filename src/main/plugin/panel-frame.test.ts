import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PANEL_FRAME_CSP, PANEL_FRAME_TTL_MS, PanelFrames, isPanelFrameLoad, isPanelFrameUrl } from "./panel-frame.ts";

describe("PanelFrames", () => {
  test("register 给出 orbita-panel://doc/<128 位随机 token>；两次的地址不同", () => {
    const frames = new PanelFrames();
    const a = frames.register("<p>a</p>");
    const b = frames.register("<p>a</p>");
    assert.match(a, /^orbita-panel:\/\/doc\/[0-9a-f]{32}$/);
    assert.notEqual(a, b);
  });

  test("iframe 请求取到模板原文（一个字节不改）与响应头 CSP；取走一次就作废", () => {
    const frames = new PanelFrames();
    // 模板里的假 <head> 在注释里：我们不在模板里找位置插 meta，所以它原样出去，CSP 走响应头不受影响
    const html = "<!-- <head><meta http-equiv=x> --><script>window.x=1</script>";
    const url = frames.register(html);
    const first = frames.respond(url);
    assert.equal(first.status, 200);
    assert.equal(first.body, html);
    assert.equal(first.headers["content-security-policy"], PANEL_FRAME_CSP);
    assert.equal(first.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(frames.respond(url).status, 404, "同一个地址第二次取不到");
    assert.equal(frames.size(), 0);
  });

  test("CSP 内容：约定里的五条一个不少，再收紧表单 / base / sandbox，且不含任何放开（connect / unsafe-eval / *）", () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src data:",
      "form-action 'none'",
      "base-uri 'none'",
      "sandbox allow-scripts",
    ]) {
      assert.ok(PANEL_FRAME_CSP.split("; ").includes(directive), directive);
    }
    assert.doesNotMatch(PANEL_FRAME_CSP, /connect-src|unsafe-eval|allow-same-origin|\*|https?:/);
  });

  test("非 GET 的请求 405，且不消耗 token（别处一次探测不能把真 iframe 的文档偷掉）", () => {
    const frames = new PanelFrames();
    const url = frames.register("<p>x</p>");
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal(frames.respond(url, method).status, 405, method);
    assert.equal(frames.respond(url, "GET").status, 200);
  });

  test("未知 token / 别的主机段 / 别的协议 / 乱 URL：404 或 400，不泄漏任何内容", () => {
    const frames = new PanelFrames();
    frames.register("<p>secret</p>");
    assert.equal(frames.respond("orbita-panel://doc/" + "0".repeat(32)).status, 404);
    assert.equal(frames.respond("orbita-panel://doc/").status, 404);
    assert.equal(frames.respond("orbita-panel://other/abc").status, 404);
    assert.equal(frames.respond("https://doc/abc").status, 404);
    assert.equal(frames.respond("not a url").status, 400);
    for (const url of ["orbita-panel://doc/../etc/passwd", "orbita-panel://doc/%2e%2e/x"]) {
      const reply = frames.respond(url);
      assert.equal(reply.status, 404);
      assert.doesNotMatch(reply.body, /secret/);
    }
  });

  test("没被取走的 60 秒后过期", () => {
    let now = 0;
    const frames = new PanelFrames(() => now);
    const url = frames.register("<p>x</p>");
    now = PANEL_FRAME_TTL_MS - 1;
    assert.equal(frames.size(), 1);
    now = PANEL_FRAME_TTL_MS;
    assert.equal(frames.respond(url).status, 404);
  });

  test("没取走的最多放 32 份，满了丢最旧的（renderer 反复开关面板不能无限涨内存）", () => {
    const frames = new PanelFrames();
    const urls = Array.from({ length: 40 }, (_, index) => frames.register(`<p>${index}</p>`));
    assert.equal(frames.size(), 32);
    assert.equal(frames.respond(urls[0] ?? "").status, 404);
    assert.equal(frames.respond(urls[39] ?? "").status, 200);
  });
});

describe("isPanelFrameLoad：只放行主窗口 renderer 页面的直接子框架", () => {
  const own = (url: string): boolean => url === "http://127.0.0.1:5273/" || url.startsWith("file:///app/out/renderer/");
  const iframeFromMain = { resourceType: "subFrame", parentUrl: "http://127.0.0.1:5273/", parentHasParent: false };

  test("正常的面板 iframe：放行（dev 与打包两种页面来源）", () => {
    assert.equal(isPanelFrameLoad(iframeFromMain, own), true);
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, parentUrl: "file:///app/out/renderer/index.html" }, own), true);
  });

  test("顶层导航（mainFrame：内置浏览器标签、拖进来的链接、window.location）一律拒", () => {
    assert.equal(isPanelFrameLoad({ resourceType: "mainFrame", parentUrl: null, parentHasParent: false }, own), false);
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, resourceType: "mainFrame" }, own), false);
  });

  test("脚本 / fetch / 图片 / 样式 / 样式里的 url() 等子资源请求一律拒", () => {
    for (const resourceType of ["script", "xhr", "image", "stylesheet", "font", "media", "object", "ping", "cspReport", "webSocket", "other"]) {
      assert.equal(isPanelFrameLoad({ ...iframeFromMain, resourceType }, own), false, resourceType);
    }
  });

  test("嵌套框架（模板里再嵌的 iframe，或面板 iframe 自己的子框架）拒；父页面不是我们自己的 renderer 页（网页、别的窗口）拒", () => {
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, parentHasParent: true }, own), false);
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, parentUrl: "orbita-panel://doc/abc" }, own), false);
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, parentUrl: "https://example.com/" }, own), false);
    assert.equal(isPanelFrameLoad({ ...iframeFromMain, parentUrl: null }, own), false);
  });
});

describe("isPanelFrameUrl", () => {
  test("只认面板协议；https、about、file、javascript、data 都不认", () => {
    assert.equal(isPanelFrameUrl("orbita-panel://doc/abc"), true);
    for (const url of ["https://example.com", "http://127.0.0.1:5273/", "file:///etc/passwd", "about:blank", "javascript:alert(1)", "data:text/html,hi", "orbita-panel://other/abc", "orbita-panel:doc/abc"]) {
      assert.equal(isPanelFrameUrl(url), false, url);
    }
  });
});
