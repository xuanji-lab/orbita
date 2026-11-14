/**
 * iframe 注入前的 HTML 改造：脚本 / 事件属性必须一个不留，CSP 必须在，pptx 的缩放
 * 必须按面板宽度算——这三条任何一条漏了，要么不安全，要么幻灯片在窄面板里溢出。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { officeDocumentHtml, officeShellStyle, officeValuePreview, stripEventAttributes, stripScripts, PPTX_DESIGN_WIDTH } from "./office-frame.ts";

const html = `<!DOCTYPE html><html><head><title>x</title>
<script type="importmap">{"imports":{"three":"https://evil.example/three.js"}}</script>
</head><body>
<button onclick="steal()">x</button>
<div data-path="/slide[1]/shape[@id=2]" onmouseover='boom()'>Q3</div>
<script>console.log("should not run")</script>
</body></html>`;

describe("stripScripts / stripEventAttributes", () => {
  test("脚本整段删掉（含 importmap 与外部 CDN 依赖）", () => {
    const cleaned = stripScripts(html);
    assert.equal(/<script/i.test(cleaned), false);
    assert.equal(cleaned.includes("evil.example"), false);
    assert.equal(cleaned.includes("should not run"), false);
  });

  test("on* 事件属性（双 / 单引号）都摘掉，data-path 留着", () => {
    const cleaned = stripEventAttributes(stripScripts(html));
    assert.equal(/\son[a-z]+\s*=/i.test(cleaned), false);
    assert.match(cleaned, /data-path="\/slide\[1\]\/shape\[@id=2\]"/);
    assert.match(cleaned, />Q3</);
  });
});

describe("officeDocumentHtml", () => {
  test("注入 CSP（断网）与我们自己的外壳样式；原文一个脚本都不剩", () => {
    const doc = officeDocumentHtml({ html, format: "pptx", width: 800, accent: "accent-from-theme" });
    assert.match(doc, /Content-Security-Policy/);
    assert.match(doc, /default-src 'none'/);
    assert.equal(/<script/i.test(doc), false);
    assert.match(doc, /id="orbita-office-shell"/);
    assert.match(doc, /accent-from-theme/);
  });

  test("pptx 按面板宽度缩放（留出内边距）：(800-28) / 1280 = 0.6031", () => {
    const style = officeShellStyle("pptx", 800, "accent-from-theme");
    assert.match(style, /\.slide\{zoom:0\.6031\}/);
    // 设计宽度常量改了这个数也要跟着变（两张卡都读它）
    assert.match(officeShellStyle("pptx", PPTX_DESIGN_WIDTH + 28, "accent-from-theme"), /zoom:1\.0000/);
    // 面板比幻灯片还宽时不放大
    assert.match(officeShellStyle("pptx", 4000, "accent-from-theme"), /zoom:1\.0000/);
    // 极窄面板也留一个下限，不至于缩成看不见的一条
    assert.match(officeShellStyle("pptx", 100, "accent-from-theme"), /zoom:0\.2000/);
  });

  test("xlsx 不缩放（表格自己会滚动），但同样隐藏 OfficeCLI 外壳", () => {
    const style = officeShellStyle("xlsx", 800, "accent-from-theme");
    assert.equal(style.includes("zoom"), false);
    assert.match(style, /\.sidebar/);
  });

  test("没有 <head> 的 HTML 也能注入（样式与 CSP 放最前面）", () => {
    const doc = officeDocumentHtml({ html: "<div data-path=\"/A1\">x</div>", format: "xlsx", width: 500, accent: "accent-from-theme" });
    assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<div"));
  });
});

describe("officeValuePreview", () => {
  test("压平空白、截到 80 字；全空回空串", () => {
    assert.equal(officeValuePreview("  Q3\n   results  "), "Q3 results");
    assert.equal(officeValuePreview(""), "");
    assert.equal(officeValuePreview(undefined), "");
    const long = "字".repeat(120);
    assert.equal(Array.from(officeValuePreview(long)).length, 80);
  });
});
