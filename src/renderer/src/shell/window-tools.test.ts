/**
 * 顶部工具栏（2026-10-19 方案 B v2）的几何与结构守卫。几何纯函数在
 * `window-tools.ts`；这里的断言分三层：
 *
 *  1. 纯函数：左胶囊 x、对话列、会话胶囊的居中与收缩（原型 v2 的实算数字做用例）；
 *  2. 垂直链：胶囊中心 y = 红绿灯中心 25 —— 主进程 trafficLightPosition ↔ 常量 ↔
 *     tokens（--titlebar-row / --titlebar-capsule / --titlebar-capsule-top）三方对账；
 *  3. 结构：**工具栏的直接子元素只有胶囊**（.toolbar-capsule；Windows 自绘窗口键
 *     .win-ctl 是唯一声明的例外）——散放的字和键从结构上进不来；右栏胶囊左缘钉
 *     右栏分隔线、左胶囊 x 与侧栏开合无关，都在 Toolbar.tsx 里按文本断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CENTER_Y,
  COLLAPSE_BREAKPOINT,
  LEFT_CAPSULE_W,
  RAIL_W,
  SESSION_GAP,
  SESSION_W,
  TRAFFIC_LIGHT_GROUP_W,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  conversationColumn,
  leftCapsuleX,
  rightEdge,
  sessionCapsule,
} from "./window-tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_SRC = join(HERE, "..");
const REPO_ROOT = join(RENDERER_SRC, "..", "..", "..");
const stylesCss = readFileSync(join(RENDERER_SRC, "styles.css"), "utf8");
const toolbarCss = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
const toolbarTsx = readFileSync(join(RENDERER_SRC, "shell/Toolbar.tsx"), "utf8");
const appTsx = readFileSync(join(RENDERER_SRC, "App.tsx"), "utf8");
const spacingCss = readFileSync(join(REPO_ROOT, "design-system/tokens/spacing.css"), "utf8");
const mainIndexTs = readFileSync(join(REPO_ROOT, "src/main/index.ts"), "utf8");

/* ── 1. 纯函数 ─────────────────────────────────────────────── */

test("左胶囊 x：darwin 在红绿灯右侧留 10px（=80），其它平台从窗口内边距起（=12）", () => {
  assert.equal(leftCapsuleX("darwin"), TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_GROUP_W + 10);
  assert.equal(leftCapsuleX("darwin"), 80);
  assert.equal(leftCapsuleX("other"), 12);
});

test("对话列与右端边界（原型 v2 的 1440 窗实算：SBW 288 / RAIL 32 / PANEL 360）", () => {
  // 侧栏展开、无右栏：列 = 312..1384（中心 848，与原型状态 1 一致）
  const wide = conversationColumn({ windowWidth: 1440, sidebarCollapsed: false, sidebarWidth: 288, panelOpen: false, panelWidth: 0 });
  assert.equal(wide.left, 312);
  assert.equal(wide.right, 1384);
  // 侧栏收起：列 = 12..1384（中心 698，原型状态 2）
  const flat = conversationColumn({ windowWidth: 1440, sidebarCollapsed: true, sidebarWidth: 288, panelOpen: false, panelWidth: 0 });
  assert.equal(flat.left, 12);
  assert.equal(flat.right, 1384);
  // 右栏开 360：列右缘 = 分隔线 1024（原型状态 3）
  const panel = conversationColumn({ windowWidth: 1440, sidebarCollapsed: false, sidebarWidth: 288, panelOpen: true, panelWidth: 360 });
  assert.equal(panel.right, 1024);
  // 右端边界：无右栏 = 右栏开关胶囊左缘（W−12−32=1396）
  assert.equal(rightEdge({ windowWidth: 1440, platform: "darwin", panelOpen: false, panelWidth: 0 }), 1396);
  assert.equal(rightEdge({ windowWidth: 1440, platform: "darwin", panelOpen: true, panelWidth: 360 }), 1024);
});

test("会话胶囊：优先居中于对话列（对称收缩），低于 280 才贴左", () => {
  // 状态 1（1440，侧栏展开、无右栏）：对话列中心 848，对称可用远超 480 → 满宽居中
  const a = sessionCapsule({ windowWidth: 1440, colLeft: 312, colRight: 1384, leftCapRight: 80 + LEFT_CAPSULE_W, rightLimit: 1364 });
  assert.equal(a.width, SESSION_W);
  assert.equal(a.x, 608);
  // 验收实例（1200 宽、侧栏展开、右栏开到分隔线 654）：中心 483，对称可用 2×159=318
  // → 缩到 318 居中（x=324），不铺满左胶囊到右栏胶囊的整段
  const m = sessionCapsule({ windowWidth: 1200, colLeft: 312, colRight: 654, leftCapRight: 80 + LEFT_CAPSULE_W, rightLimit: 654 });
  assert.equal(m.width, 318);
  assert.equal(m.x, 324);
  assert.equal(m.x + m.width, 642);
  // 对称凑不到 280：贴左（宽度取 280，左缘钉下限）
  const b = sessionCapsule({ windowWidth: 620, colLeft: 12, colRight: 564, leftCapRight: 192, rightLimit: 560 });
  assert.equal(b.width, 280);
  assert.equal(b.x, 204);
  // 连 280 都放不下：能拿多少拿多少
  const c = sessionCapsule({ windowWidth: 480, colLeft: 12, colRight: 424, leftCapRight: 192, rightLimit: 460 });
  assert.equal(c.width, 244);
  assert.equal(c.x, 204);
});

test("断点与侧栏开关的结构性不变量：左胶囊 x 与侧栏开合无关", () => {
  assert.equal(COLLAPSE_BREAKPOINT, 960);
  // leftCapsuleX 不吃侧栏状态——「开关两态坐标不变」由「同一个容器」保证
  // leftCapsuleX 的签名只有 platform——不吃侧栏状态，两态同 x 由签名本身保证
  assert.ok(leftCapsuleX.length === 1, "leftCapsuleX 应只吃 platform 一个参数");
  // Toolbar 用同一常量渲染左胶囊（两态同一个元素）
  assert.match(toolbarTsx, /const left = leftCapsuleX\(props\.platform\)/);
  assert.match(toolbarTsx, /style=\{\{ left, width: LEFT_CAPSULE_W \}\}/);
});

/* ── 2. 垂直链：胶囊中心 = 红绿灯中心 = 25 ──────────────────── */

test("红绿灯位置是真源：主进程 y=19 与常量对账", () => {
  const pos = mainIndexTs.match(/trafficLightPosition:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/);
  assert.ok(pos !== null, "src/main/index.ts 里找不到 trafficLightPosition");
  assert.equal(Number(pos[1]), TRAFFIC_LIGHT_X);
  assert.equal(Number(pos[2]), TRAFFIC_LIGHT_Y);
  assert.equal(CENTER_Y, 25);
});

test("胶囊中心 y = 25：tokens 三方对账（行 52 · 胶囊 32 · 上沿 9）", () => {
  const row = spacingCss.match(/--titlebar-row:\s*(\d+)px/);
  const cap = spacingCss.match(/--titlebar-capsule:\s*var\(--control-height-md\)/);
  const top = spacingCss.match(/--titlebar-capsule-top:\s*(\d+)px/);
  assert.ok(row !== null, "tokens/spacing.css 缺 --titlebar-row");
  assert.equal(Number(row[1]), 52);
  assert.ok(cap !== null, "--titlebar-capsule 不再是 var(--control-height-md)");
  assert.ok(top !== null, "tokens/spacing.css 缺 --titlebar-capsule-top");
  // 9 + 32/2 = 25 = 红绿灯中心
  assert.equal(Number(top[1]) + 32 / 2, CENTER_Y);
  // 胶囊配方确实用这些 token（shell/toolbar.css）
  assert.match(toolbarCss, /\.toolbar-capsule\s*\{[^}]*top:\s*var\(--titlebar-capsule-top\)/);
  assert.match(toolbarCss, /\.toolbar-capsule\s*\{[^}]*height:\s*var\(--titlebar-capsule\)/);
  assert.match(toolbarCss, /\.toolbar\s*\{[^}]*height:\s*var\(--titlebar-row\)/);
  // App 断点仍是同一份常量
  assert.match(appTsx, /matchMedia\(`\(max-width: \$\{COLLAPSE_BREAKPOINT - 1}px\)`\)/);
});

/* ── 3. 结构守卫 ───────────────────────────────────────────── */

test("工具栏的直接子元素只有胶囊（Windows 窗口键是唯一例外）", () => {
  // Toolbar 组件 return 的 JSX：6 空格缩进的元素行 = .toolbar 的直接子节点
  // （只看主 return——WindowControls 内部的按钮在自己那层，不是工具栏直接子元素）
  const start = toolbarTsx.indexOf('return (\n    <div className="titlebar toolbar">');
  const body = toolbarTsx.slice(start, toolbarTsx.indexOf("/** 自绘三键"));
  const direct = [...body.matchAll(/^ {6}<[A-Za-z]/gm)].map((m) => m[0]);
  assert.ok(direct.length >= 2, "Toolbar 的直接子节点少了（至少左胶囊与右栏开关两颗常驻胶囊）");
  // 四颗胶囊都在场（会话 / 右栏两颗住在条件包裹里，按文本确认）
  const markers = [
    "toolbar-capsule\" style={{ left, width: LEFT_CAPSULE_W }}",
    "toolbar-capsule\" style={{ left: sess.x, width: sess.width }}",
    "toolbar-capsule cap-panel\" style={{ left: panelLeft, width: panelW }}",
    "toolbar-capsule\" style={{ left: toggleLeft, width: RAIL_W }}",
  ];
  for (const marker of markers) {
    assert.ok(body.includes(marker), `Toolbar 缺胶囊：${marker}`);
  }
  for (const line of direct) {
    // 取该元素的 className 首值
    const rest = body.slice(body.indexOf(line));
    const cls = rest.match(/className=\{?"([^"$]+)/)?.[1] ?? rest.match(/className="([^"]+)"/)?.[1] ?? "";
    assert.ok(
      cls.startsWith("toolbar-capsule") || cls.startsWith("win-ctl") || line.startsWith("      <WindowControls"),
      `工具栏里出现了非胶囊的直接子元素：${line.trim()}（class=${cls}）——散放的字和键从结构上进不来`,
    );
  }
});

test("右栏胶囊：左缘钉右栏分隔线、宽 = 右栏宽（窄窗锚右、默认宽）", () => {
  // 常态：left = col.right（conversationColumn 的 right 就是分隔线 x）
  assert.match(toolbarTsx, /const panelLeft = props\.narrow \? toggleLeft - panelW : col\.right;/);
  // conversationColumn 的 right = 卡片右缘 − 右栏宽（分隔线定义）
  assert.match(
    readFileSync(join(RENDERER_SRC, "shell/window-tools.ts"), "utf8"),
    /paneRight - \(input\.panelOpen \? input\.panelWidth : 0\)/,
  );
});

test("胶囊内件走 token：圆格 / 内嵌框 / 图标 / 标题字（家族规则禁字面量）", () => {
  const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [selector, prop, value] of [
    [".cap-seg", "height", "var(--titlebar-control)"],
    [".cap-pt", "height", "var(--titlebar-control)"],
    [".cap-pf", "height", "var(--titlebar-field)"],
    [".cap-tab", "height", "var(--titlebar-field)"],
    [".cap-title", "font-size", "var(--font-size-titlebar)"],
    [".cap-pt strong", "font-size", "var(--font-size-titlebar)"],
  ] as const) {
    const i = toolbarCss.indexOf(`\n${selector} {`);
    assert.ok(i !== -1, `toolbar.css 缺 ${selector}`);
    const block = toolbarCss.slice(i, toolbarCss.indexOf("\n}", i));
    assert.match(block, new RegExp(`${prop}:\\s*${escapeRe(value)}`), `${selector} 的 ${prop} 不再走 ${value}`);
  }
  // 窄断点与常量对账
  assert.match(toolbarCss, /@container \(width < 300px\)/);
  // 主题字号 = base
  const typographyCss = readFileSync(join(REPO_ROOT, "design-system/tokens/typography.css"), "utf8");
  assert.match(typographyCss, /--font-size-titlebar:\s*var\(--font-size-base\)/);
});

test("右栏最窄宽与常量对账（settings 的地板 = PANEL_MIN_W = 260）", () => {
  const settings = readFileSync(join(REPO_ROOT, "src/shared/settings.ts"), "utf8");
  const floor = settings.match(/RIGHT_PANEL_WIDTH_FLOOR = (\d+)/);
  assert.ok(floor !== null);
  assert.equal(Number(floor[1]), 260, "右栏地板变了——window-tools.ts 的 PANEL_MIN_W 与右栏胶囊的断点要一起看");
});

test("壳的竖直骨架在：.app-shell 撑满窗口高（上一提交被 CSS 手术误删，整窗下方空白）", () => {
  assert.match(stylesCss, /\.app-shell\s*\{[^}]*height:\s*100%/);
  assert.match(stylesCss, /\.app-shell\s*\{[^}]*display:\s*flex/);
  assert.match(stylesCss, /\.app-shell\s*\.layer\s*\{[^}]*flex:\s*1/);
});

test("控件配方兜住浏览器默认边框：quiet-control 与胶囊内 button 都重置 border", () => {
  assert.match(stylesCss, /\.quiet-control\s*\{[^}]*border:\s*0/, ".quiet-control 配方缺 border: 0——裸 button 会露出 2px outset");
  assert.match(toolbarCss, /\.toolbar-capsule button\s*\{[^}]*border:\s*0/, "胶囊内 button 缺边框重置");
});

test("旧机制的残骸清干净：没有 .panel-head / .titlebar-exempt / 旧净空变量", () => {
  assert.ok(!stylesCss.includes(".panel-head"), "styles.css 里还有 .panel-head");
  assert.ok(!stylesCss.includes("titlebar-exempt"), "titlebar-exempt 没删干净");
  for (const gone of ["--traffic-clearance", "--window-tools-inset", "--titlebar-icon-own"]) {
    assert.ok(!stylesCss.includes(gone) && !spacingCss.includes(gone), `旧 token ${gone} 还有残留`);
  }
  assert.ok(!toolbarTsx.includes("RailButton"), "RailButton 已被胶囊格取代，不该再出现");
});
