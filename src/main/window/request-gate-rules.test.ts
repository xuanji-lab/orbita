/**
 * 合并后的请求闸：插件面板那道闸原来拒的照样拒、原来放行的照样放行；阅读器的闸只管自己的协议。
 * 两道闸装在同一个监听里（Electron 每个 session 只认最后一个 onBeforeRequest 监听，见 request-gate.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateFilter, shouldCancel, type GateDetails, type GateFrame } from "./request-gate-rules.ts";
import { panelRequestGate } from "../plugin/panel-frame.ts";
import { readerRequestGate } from "../pdf-reader/gate.ts";

const OWN = "http://127.0.0.1:5273/";
const isOwnPage = (url: string): boolean => url.startsWith(OWN);
const gates = [panelRequestGate(isOwnPage), readerRequestGate(isOwnPage)];

const frame = (url: string, parent: GateFrame | null = null): GateFrame => ({ url, parent });
const ownPage = frame(OWN);
const PANEL = "orbita-panel://doc/0123456789abcdef0123456789abcdef";
const req = (url: string, resourceType: string, f: GateFrame | null, referrer = ""): GateDetails => ({ url, resourceType, frame: f, referrer });

test("过滤式只列这两个协议：别的请求（http、file、内置浏览器的网页）根本不进这个监听", () => {
  assert.deepEqual(gateFilter(gates), { urls: ["orbita-panel://*/*", "orbita-reader://*/*"] });
});

test("插件面板：主窗口自己页面的直接子框架加载文档——照样放行", () => {
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", frame("", ownPage))), false);
});

test("插件面板：原来拒的照样拒", () => {
  // 直接打开（顶层导航）
  assert.equal(shouldCancel(gates, req(PANEL, "mainFrame", frame(PANEL))), true);
  // 非主窗口页面发起（父框架不是我们的 renderer 页面，比如别的网页 / 阅读器页面）
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", frame("", frame("https://evil.example/")))), true);
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", frame("", frame("orbita-reader://app/reader.html", ownPage)))), true);
  // 嵌套框架（面板里再嵌一层）
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", frame("", frame(PANEL, ownPage)))), true);
  // 父框架是我们页面的地址、但它自己被嵌在别的框架里（我们的页面被别人套了一层）
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", frame("", frame(OWN, frame("https://evil.example/"))))), true);
  // 脚本 / fetch / 图片这类子资源
  assert.equal(shouldCancel(gates, req(PANEL, "script", frame(OWN))), true);
  assert.equal(shouldCancel(gates, req(PANEL, "xhr", frame("orbita-reader://app/reader.html", ownPage))), true);
  // 没有发起框架（worker 等）
  assert.equal(shouldCancel(gates, req(PANEL, "subFrame", null)), true);
});

test("阅读器：只管 orbita-reader://；入口页、内层 iframe、子资源各走各的判定", () => {
  assert.equal(shouldCancel(gates, req("orbita-reader://app/reader.html", "subFrame", frame("", ownPage))), false);
  assert.equal(shouldCancel(gates, req("orbita-reader://app/pdf/web/viewer.html", "subFrame", frame("", frame("orbita-reader://app/reader.html", ownPage)))), false);
  assert.equal(shouldCancel(gates, req("orbita-reader://app/reader.js", "script", frame("orbita-reader://app/reader.html", ownPage))), false);
  // 面板文档里去取阅读器的东西：拦
  assert.equal(shouldCancel(gates, req("orbita-reader://app/doc/x", "xhr", frame(PANEL, ownPage))), true);
  assert.equal(shouldCancel(gates, req("orbita-reader://app/reader.html", "mainFrame", frame("orbita-reader://app/reader.html"))), true);
});

test("不归任何一道闸管的 URL 一律取消（合并不会多放行任何东西）", () => {
  assert.equal(shouldCancel(gates, req("orbita-other://x/y", "subFrame", frame("", ownPage))), true);
  assert.equal(shouldCancel([], req(PANEL, "subFrame", frame("", ownPage))), true);
});

test("闸只装在默认 session 上；内置浏览器的持久化分区另有自己的闸、也没有这两个协议", () => {
  const glue = readFileSync(new URL("./request-gate.ts", import.meta.url), "utf8");
  assert.match(glue, /session\.defaultSession\.webRequest\.onBeforeRequest\(/);
  const browser = readFileSync(new URL("../browser/local-file.ts", import.meta.url), "utf8");
  assert.match(browser, /partition\.webRequest\.onBeforeRequest\(/);
  assert.doesNotMatch(browser, /orbita-panel|orbita-reader/);
});
