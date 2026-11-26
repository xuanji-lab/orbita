import { test } from "node:test";
import assert from "node:assert/strict";
import { PANEL_FRAME_CSP, PanelFrames } from "../plugin/panel-frame.ts";
import { chatEmbedFrameOf } from "./embed-frame.ts";

test("chat:embed-frame：合规文档换一次性地址，取走一次即作废；不合规回 null 且不登记", () => {
  const frames = new PanelFrames();
  assert.equal(chatEmbedFrameOf(frames, { html: "" }), null);
  assert.equal(chatEmbedFrameOf(frames, "nope"), null);
  assert.equal(frames.size(), 0);
  const result = chatEmbedFrameOf(frames, { html: "<p>图</p>" });
  assert.ok(result !== null);
  if (result === null) return;
  assert.match(result.frameUrl, /^orbita-panel:\/\/doc\/[0-9a-f]{32}$/);
  const first = frames.respond(result.frameUrl);
  assert.equal(first.status, 200);
  assert.equal(first.body, "<p>图</p>");
  assert.match(first.headers["content-security-policy"] ?? "", /default-src 'none'/);
  assert.equal(frames.respond(result.frameUrl).status, 404);
});

test("文档的 CSP（协议响应头）：一切网络与本地文件都禁，只放内联脚本与样式、data: 图片字体", () => {
  const directives = new Map(
    PANEL_FRAME_CSP.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values.join(" ")] as const;
    }),
  );
  assert.equal(directives.get("default-src"), "'none'");
  assert.equal(directives.get("script-src"), "'unsafe-inline'");
  assert.equal(directives.get("img-src"), "data:");
  assert.equal(directives.get("form-action"), "'none'");
  assert.equal(directives.get("base-uri"), "'none'");
  assert.equal(directives.get("sandbox"), "allow-scripts");
  // 没有任何一条放行 http(s) / file / 通配；connect / frame / worker 由 default-src 'none' 兜住
  assert.ok(!/https?:|file:|\*/.test(PANEL_FRAME_CSP));
  assert.ok(!directives.has("connect-src"));
});
