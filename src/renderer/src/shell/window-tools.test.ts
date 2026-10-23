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
  LIGHTS_GAP,
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
/** 读源码做文本断言，统一把 CRLF 归一成 LF：Windows 检出（core.autocrlf=true）的工作区
 * 是 CRLF，下面的 indexOf / 正则断言都按 LF 写，不归一就在 Windows 上必挂。 */
function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const stylesCss = readSource(join(RENDERER_SRC, "styles.css"));
const toolbarCss = readSource(join(RENDERER_SRC, "shell/toolbar.css"));
const toolbarTsx = readSource(join(RENDERER_SRC, "shell/Toolbar.tsx"));
const appTsx = readSource(join(RENDERER_SRC, "App.tsx"));
const spacingCss = readSource(join(REPO_ROOT, "design-system/tokens/spacing.css"));
const mainIndexTs = readSource(join(REPO_ROOT, "src/main/index.ts"));

/* ── 1. 纯函数 ─────────────────────────────────────────────── */

test("左胶囊 x：darwin 与红绿灯右缘隔 18（=88，2026-10-19 验收：隔 10 太贴），其它平台从窗口内边距起（=12）", () => {
  assert.equal(leftCapsuleX("darwin"), TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_GROUP_W + LIGHTS_GAP);
  assert.equal(leftCapsuleX("darwin"), 88);
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
  const a = sessionCapsule({ windowWidth: 1440, colLeft: 312, colRight: 1384, leftCapRight: 88 + LEFT_CAPSULE_W, rightLimit: 1364 });
  assert.equal(a.width, SESSION_W);
  assert.equal(a.x, 608);
  // 验收实例（1200 宽、侧栏展开、右栏开到分隔线 654）：中心 483，对称可用 2×159=318
  // → 缩到 318 居中（x=324），不铺满左胶囊到右栏胶囊的整段
  const m = sessionCapsule({ windowWidth: 1200, colLeft: 312, colRight: 654, leftCapRight: 88 + LEFT_CAPSULE_W, rightLimit: 654 });
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
  // Toolbar 用同一常量渲染左胶囊（两态同一个元素）；宽度随内容置：leftW 的地板是
  // LEFT_CAPSULE_W（专注中的倒计时格比圆格宽，Toolbar 用 ResizeObserver 量内容）
  assert.match(toolbarTsx, /const left = leftCapsuleX\(props\.platform\)/);
  assert.match(toolbarTsx, /style=\{\{ left, width: leftW \}\}/);
  assert.match(toolbarTsx, /useState\(LEFT_CAPSULE_W\)/, "leftW 的地板应是 LEFT_CAPSULE_W");
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

test("工具栏的直接子元素只有胶囊（Windows brand row 是唯一例外）", () => {
  // Toolbar 组件 return 的 JSX：6 空格缩进的元素行 = .toolbar 的直接子节点
  // （只看主 return——WindowControls 内部的按钮在 brand row 那层，不是工具栏直接子元素）
  const start = toolbarTsx.indexOf('return (\n    <div className="titlebar toolbar" data-platform={props.platform}>');
  const body = toolbarTsx.slice(start, toolbarTsx.indexOf("/** 自绘三键"));
  const direct = [...body.matchAll(/^ {6}<[A-Za-z]/gm)].map((m) => m[0]);
  assert.ok(direct.length >= 2, "Toolbar 的直接子节点少了（至少左胶囊与右栏开关两颗常驻胶囊）");
  // 四颗胶囊都在场（会话 / 右栏两颗住在条件包裹里，按文本确认）
  const markers = [
    "toolbar-capsule\" style={{ left, width: leftW }}",
    "toolbar-capsule\" style={{ left: sess.x, width: sess.width }}",
    "toolbar-capsule cap-panel\" style={{ left: panelLeft, width: panelW }}",
    "toolbar-capsule\" style={{ left: toggleLeft, width: RAIL_W }}",
  ];
  for (const marker of markers) {
    assert.ok(body.includes(marker), `Toolbar 缺胶囊：${marker}`);
  }
  for (const line of direct) {
    // 取该元素的 className 首值；brand row 是 Windows 唯一声明的例外（商标 + 三键，2026-10-19 修订）
    const rest = body.slice(body.indexOf(line));
    const cls = rest.match(/className=\{?"([^"$]+)/)?.[1] ?? rest.match(/className="([^"]+)"/)?.[1] ?? "";
    assert.ok(
      cls.startsWith("toolbar-capsule") || cls.startsWith("brand-row"),
      `工具栏里出现了非胶囊的直接子元素：${line.trim()}（class=${cls}）——散放的字和键从结构上进不来`,
    );
  }
});

test("右栏胶囊：钉右栏分隔线 + 两侧内缩 8（与右栏内容左缘对齐，2026-10-19 验收）", () => {
  assert.match(toolbarTsx, /col\.right \+ PANEL_CAPSULE_INSET/, "右栏胶囊左缘没加分隔线内缩");
  assert.match(toolbarTsx, /- 2 \* PANEL_CAPSULE_INSET/, "右栏胶囊宽度没减两侧内缩");
  const wt = readSource(join(RENDERER_SRC, "shell/window-tools.ts"));
  assert.match(wt, /PANEL_CAPSULE_INSET = 8/, "内缩档不再是 8（--space-2）——改的话测试与注释一起改");
  // conversationColumn 的 right = 卡片右缘 − 右栏宽（分隔线定义）
  assert.match(
    readSource(join(RENDERER_SRC, "shell/window-tools.ts")),
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
  const typographyCss = readSource(join(REPO_ROOT, "design-system/tokens/typography.css"));
  assert.match(typographyCss, /--font-size-titlebar:\s*var\(--font-size-base\)/);
});

test("右栏最窄宽与常量对账（settings 的地板 = PANEL_MIN_W = 260）", () => {
  const settings = readSource(join(REPO_ROOT, "src/shared/settings.ts"));
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

test("选中蓝底在：rail 入口走 quiet-control 配方，右栏开关跟任意面板点亮", () => {
  const rail = readSource(join(RENDERER_SRC, "shell/RightRail.tsx"));
  // 点亮不再是 inline 玻璃白（2026-10-19 回归：用户点名要保留蓝底）
  assert.ok(!rail.includes('background: lit ?'), "rail 入口的点亮又写回 inline 玻璃白了——走 quiet-control[aria-pressed]");
  assert.match(rail, /className="quiet-control"\n      title=\{props\.label\}/, "RailEntryButton 没挂 quiet-control");
  // 右栏开关：点亮 = 面板开着（不是只看 drawer）
  assert.match(toolbarTsx, /aria-pressed=\{props\.panelOpen \|\| undefined\}/, "右栏开关的点亮没跟任意面板开");
});

test("对话卡的高度链：删页头后 grid 行数跟着切换（composer 曾卡半空）", () => {
  const chat = readSource(join(RENDERER_SRC, "features/chat/ChatView.tsx"));
  assert.match(
    chat,
    /props\.hideHeader === true \? "minmax\(0,1fr\) auto" : "auto minmax\(0,1fr\) auto"/,
    "Pane 的 grid 行没随页头有无切换——滚动区会掉进 auto 行、输入卡掉进 1fr 行",
  );
});

test("字标与星云同一行：绝对定位在停机坪、中心对齐云心（24），最左两格右移对齐今天", () => {
  const usageCss = readSource(join(RENDERER_SRC, "shell/usage.css"));
  assert.match(usageCss, /\.usage-brand\s*\{[^}]*position:\s*absolute[^}]*height:\s*48px/s, "字标没有绝对定位到星云那行（48px 空域）");
  assert.match(usageCss, /\.usage-brand\[data-yield\]\s*\{\s*transform:\s*translateX\(calc\(216px - 100%\)\)/, "星云在最左两格时字标没有右移对齐「今天」格");
  const meter = readSource(join(RENDERER_SRC, "shell/UsageMeter.tsx"));
  assert.match(meter, /data-yield=\{active <= 1 \|\| undefined\}/, "避让判定没接 active 格序");
});

test("审查页签以胶囊中心居中：三列 grid 两个 1fr 等宽轨道（构造性 ±0），放不下自退化", () => {
  // grid 1fr auto 1fr：两轨等宽 → 页签组构造性落在胶囊中心；放不下轨道压缩、
  // 页签组顺排（cap-tabs 自带横滚渐隐），不与两侧重叠（绝对居中压过下拉，已弃）
  assert.match(
    toolbarCss,
    /\.cap-review-head\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*1fr auto 1fr/s,
    "缺审查头的三列 grid——页签组无法构造性居中",
  );
  const review = readSource(join(RENDERER_SRC, "features/review/ReviewPanel.tsx"));
  assert.match(review, /className="cap-review-head"/, "审查头没用三列 grid");
  assert.match(review, /className="cap-tabs"/, "审查页签组不在 grid 中列");
  // 来源下拉收成图标键（给居中让位；点开同一个来源菜单）
  assert.match(review, /git-branch" size=\{16\}/, "来源图标键没了");
  assert.match(review, /cap-review-head[\s\S]{0,2000}cap-seg solo/, "来源下拉没收成图标键");
});

test("胶囊内带文字的键豁免兜底重置（页签曾被压到 44px、padding 被清零）", () => {
  for (const cls of [".cap-tab", ".cap-sel", ".cap-subchip", ".cap-crumb", ".cap-pt"]) {
    assert.match(
      toolbarCss,
      new RegExp(`\\.toolbar-capsule ${cls.replace(".", "\\.")}\\s*\\{[^}]*width:\\s*auto`),
      `${cls} 没豁免 .toolbar-capsule button 的 padding:0 / 定宽`,
    );
  }
});

test("页签组的右缘渐隐只在装不下时出现（曾常驻，把「摘抄」的「抄」字淡掉）", () => {
  const block = /\.cap-tabs\s*\{[^}]*\}/g;
  for (const rule of toolbarCss.match(block) ?? []) {
    assert.doesNotMatch(rule, /mask-image/, ".cap-tabs 规则里不得直接写 mask-image（会常驻）");
  }
  assert.match(toolbarCss, /animation-timeline:\s*scroll\(self inline\)/, "渐隐要挂在页签组自身的横向滚动时间线上");
  assert.match(toolbarCss, /@keyframes cap-tabs-fade/, "渐隐关键帧没了");
});

test("旧机制的残骸清干净：没有 .panel-head / .titlebar-exempt / 旧净空变量", () => {
  assert.ok(!stylesCss.includes(".panel-head"), "styles.css 里还有 .panel-head");
  assert.ok(!stylesCss.includes("titlebar-exempt"), "titlebar-exempt 没删干净");
  for (const gone of ["--traffic-clearance", "--window-tools-inset", "--titlebar-icon-own"]) {
    assert.ok(!stylesCss.includes(gone) && !spacingCss.includes(gone), `旧 token ${gone} 还有残留`);
  }
  assert.ok(!toolbarTsx.includes("RailButton"), "RailButton 已被胶囊格取代，不该再出现");
});

test("工具栏右栏胶囊只认右栏实际渲染宽（夹过 1/3–2/3），不认盘上原始宽", () => {
  const app = readFileSync(join(RENDERER_SRC, "App.tsx"), "utf8");
  const slot = readFileSync(join(RENDERER_SRC, "shell/RightPanel.tsx"), "utf8");
  assert.match(app, /panelWidth=\{panelRenderedWidth\}/, "Toolbar 的 panelWidth 必须是 RightPanelSlot 报上来的渲染宽");
  assert.doesNotMatch(app, /<Toolbar[\s\S]{0,800}panelWidth=\{panelWidth\}/, "Toolbar 不能拿未夹的原始宽");
  assert.match(app, /onRenderedWidth=\{setPanelRenderedWidth\}/);
  assert.match(slot, /onRenderedWidth\?\.\(renderedWidth\)/, "RightPanelSlot 要把夹过的宽度报出去");
});

test("会话胶囊窄时逐级让位、不重叠：中栏可缩、两侧保内容宽、标题能省略", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  assert.match(css, /\.cap-sess \{[^}]*grid-template-columns:\s*1fr minmax\(0, max-content\) 1fr/s, "中栏要能缩（原先 auto 不缩，右端短 id 溢进标题）");
  assert.match(css, /\.cap-sess \{[^}]*container-type:\s*inline-size/s);
  assert.match(css, /\.cap-sess \.cap-sl,\s*\.cap-sess \.cap-sr \{\s*min-width:\s*max-content/, "两侧轨道不许被压到内容以下");
  assert.match(css, /\.cap-sess \.cap-sc \{[^}]*justify-self:\s*stretch/s, "中栏按内容定宽会溢出轨道");
  assert.match(css, /\.cap-title \{[^}]*min-width:\s*0/s, "flex 子项不设 min-width:0 省略号不生效");
  assert.match(css, /@container \(max-width: 380px\) \{\s*\.cap-sess \.cap-sid \{\s*display:\s*none/, "第一档：短 id 先藏");
});

test("窄窗右栏覆盖层从工具栏下面开始——不压住窗口三键与会话胶囊", () => {
  const css = readSource(join(RENDERER_SRC, "styles.css"));
  const slot = readSource(join(RENDERER_SRC, "shell/RightPanel.tsx"));
  // 工具栏高度只有一份真源：.layer 的顶部留白与覆盖层的 top 都从这里取。
  // 工具栏是绝对定位的（住在 .layer 里、top:0），覆盖层若从 .layer 顶边算 12px
  // 就会压在它上面（2026-10-22 验收：900px 窗口下最小化 / 最大化被终端面板盖死）。
  assert.match(css, /:root \{\s*--chrome-height:\s*var\(--titlebar-row\)/, "macOS 单行：--chrome-height = 胶囊行");
  assert.match(
    css,
    /:root\[data-platform="win32"\],\s*:root\[data-platform="linux"\]\s*\{\s*--chrome-height:\s*calc\(var\(--titlebar-brand-row\) \+ var\(--titlebar-row\)\)/,
    "Windows / Linux 两行：加 brand row",
  );
  assert.match(css, /\.layer \{[^}]*padding:\s*var\(--chrome-height\) var\(--space-3\) var\(--space-3\)/s, ".layer 顶部留白同源");
  assert.match(slot, /top:\s*"calc\(var\(--chrome-height\) \+ var\(--space-3\)\)"/, "覆盖层 top 要让开工具栏");
  assert.doesNotMatch(slot, /top:\s*"var\(--space-3\)"/, "旧值会盖住工具栏");
});

test("窄窗右栏胶囊不与会话胶囊重叠：会话胶囊的右限要让开它", () => {
  const toolbar = readSource(join(RENDERER_SRC, "shell/Toolbar.tsx"));
  // 窄窗覆盖层不占布局宽（conversationColumn 不扣它），但胶囊仍画在工具栏右端。
  // 侧栏一收起（<960）会话胶囊会突然长到 476，压住右栏胶囊（2026-10-22 验收实测）。
  assert.match(toolbar, /const narrowPanelLeft\s*=/, "先算窄窗右栏胶囊左缘");
  assert.match(
    toolbar,
    /colRight:\s*narrowLimit === null \? col\.right : Math\.min\(col\.right, narrowLimit\)/,
    "对话列右缘要让开右栏胶囊",
  );
  assert.match(
    toolbar,
    /rightLimit:\s*narrowLimit === null \? limit : Math\.min\(limit, narrowLimit\)/,
    "会话胶囊右限要让开右栏胶囊",
  );
  assert.doesNotMatch(toolbar, /panelLeft = props\.narrow\s*\?/, "panelLeft 不再单算一套窄窗分支");
});

test("会话胶囊容器显式铺满 + 标题钉中栏：设置页只有标题一个孩子也不塌、居中", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  // container-type: inline-size 下元素宽不随内容撑开，没有显式宽就塌成 0
  assert.match(css, /\.cap-sess \{[^}]*container-type:\s*inline-size[^}]*width:\s*100%/s);
  assert.match(css, /\.cap-sess \.cap-sc \{[^}]*grid-column:\s*2/s);
});
