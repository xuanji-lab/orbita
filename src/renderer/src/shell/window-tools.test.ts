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
  RAIL_END,
  RAIL_W,
  PANE_RADIUS,
  TAB_FILLET,
  TOGGLE_CAP_W,
  toggleCapsuleLeft,
  PANEL_CAPSULE_INSET,
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

test("对话列与右端边界（1440 窗实算：SBW 288 / 图标条 44 + 右缘 4 / PANEL 360；2026-11-22 图标条收窄，原先 32 + 两侧各 12）", () => {
  // 侧栏展开、无右栏：列 = 312..1384（中心 848，与原型状态 1 一致）
  const wide = conversationColumn({ windowWidth: 1440, sidebarCollapsed: false, sidebarWidth: 288, panelOpen: false, panelWidth: 0 });
  assert.equal(wide.left, 312);
  assert.equal(wide.right, 1392);
  // 侧栏收起：列 = 12..1384（中心 698，原型状态 2）
  const flat = conversationColumn({ windowWidth: 1440, sidebarCollapsed: true, sidebarWidth: 288, panelOpen: false, panelWidth: 0 });
  assert.equal(flat.left, 12);
  assert.equal(flat.right, 1392);
  // 右栏开 360：列右缘 = 分隔线 1032（原型状态 3）
  const panel = conversationColumn({ windowWidth: 1440, sidebarCollapsed: false, sidebarWidth: 288, panelOpen: true, panelWidth: 360 });
  assert.equal(panel.right, 1032);
  // 右端边界：无右栏 = 右栏开关胶囊左缘（居中在图标条里：W−48+6 = 1398）
  assert.equal(rightEdge({ windowWidth: 1440, panelOpen: false, panelWidth: 0 }), 1398);
  assert.equal(rightEdge({ windowWidth: 1440, panelOpen: true, panelWidth: 360 }), 1032);
  // Windows / Linux：三键在品牌行，胶囊行不再为它们左让（2026-10-23：旧算法减 126px，
  // 1000 宽时把会话胶囊截到 372；正确值是开关胶囊左缘）
  assert.equal(rightEdge({ windowWidth: 1440, panelOpen: false, panelWidth: 0 }), 1398);
  assert.equal(rightEdge({ windowWidth: 1000, panelOpen: false, panelWidth: 0 }), 958);
  assert.equal(rightEdge({ windowWidth: 960, panelOpen: false, panelWidth: 0 }), 918);
});

test("会话标签：居左——侧栏展开时左缘 = 对话列左缘 + 井圆角 + 反向圆角，收起时紧跟左胶囊（专注键）", () => {
  // 反向圆角要落在井上缘的直线段上：最靠左 = 井左缘 + 井圆角 8 + 反向圆角 8
  const a = sessionCapsule({ colLeft: 312, leftCapRight: 88 + LEFT_CAPSULE_W, rightLimit: 1364 });
  assert.equal(a.x, 312 + PANE_RADIUS + TAB_FILLET);
  assert.equal(a.width, SESSION_W);
  // 侧栏收起（对话列贴窗口边 12）：左缘退到左胶囊右缘（88 + 112 = 200）再让出左反向圆角与一小格，标签紧跟专注键
  const c = sessionCapsule({ colLeft: 12, leftCapRight: 88 + LEFT_CAPSULE_W, rightLimit: 1364 });
  assert.equal(c.x, 88 + LEFT_CAPSULE_W + TAB_FILLET + SESSION_GAP / 3);
  // 专注中倒计时格把左胶囊撑宽：标签跟着右移，不压住它
  const wide = sessionCapsule({ colLeft: 12, leftCapRight: 88 + LEFT_CAPSULE_W + 40, rightLimit: 1364 });
  assert.equal(wide.x, c.x + 40);
  // 验收实例（1200 宽、侧栏展开、右栏开到分隔线 654）：右限让开右栏胶囊再留 SESSION_GAP
  const m = sessionCapsule({ colLeft: 312, leftCapRight: 88 + LEFT_CAPSULE_W, rightLimit: 654 });
  assert.equal(m.x, 328);
  assert.equal(m.width, 654 - 12 - 328);
  // 放不下：能拿多少拿多少，最窄 0（Toolbar 不渲染 0 宽胶囊）
  const tight = sessionCapsule({ colLeft: 12, leftCapRight: 192, rightLimit: 260 });
  assert.equal(tight.width, 260 - 12 - tight.x);
  assert.equal(sessionCapsule({ colLeft: 12, leftCapRight: 192, rightLimit: 200 }).width, 0);
});

test("与井相连的标签 / 窄图标条：尺寸 token 与 JS 几何对账", () => {
  assert.match(spacingCss, /--tab-fillet:\s*var\(--radius-xl\)/, "反向圆角半径 = 面圆角 token");
  assert.match(spacingCss, /--radius-xl:\s*var\(--radius\);?/, "面圆角 = --radius = 8（方向 N）");
  assert.match(spacingCss, /--radius:\s*0\.5rem/);
  assert.equal(TAB_FILLET, 8);
  assert.equal(PANE_RADIUS, 8);
  assert.match(spacingCss, /--rail-w:\s*44px/);
  assert.equal(RAIL_W, 44, "图标条宽 = 图标 28 + 左右各 --space-2");
  assert.match(spacingCss, /--rail-end:\s*var\(--space-1\)/);
  assert.equal(RAIL_END, 4);
  assert.match(spacingCss, /--tab-h:\s*48px/);
  // 井的右缘离窗口边 = 条宽 + 条右缘留白；开关胶囊（32）居中在 44 的条里，与条上 28 的图标同一条竖线
  assert.equal(toggleCapsuleLeft(1440), 1440 - RAIL_W - RAIL_END + (RAIL_W - TOGGLE_CAP_W) / 2);
  assert.equal(toggleCapsuleLeft(1440) + 2, 1440 - RAIL_W - RAIL_END + 8, "胶囊内的 28 圆格左缘 = 条左缘 + 8");
});

test("井上的两个标签只在非纸面主题画；条上被点亮项的标签只在面板开着时画", () => {
  const toolbarCssSrc = readSource(join(RENDERER_SRC, "shell/toolbar.css"));
  const railTsx = readSource(join(RENDERER_SRC, "shell/RightRail.tsx"));
  assert.match(toolbarCssSrc, /\.session-tab \{\s*display:\s*none;/, "纸面两档默认不画标签");
  assert.match(toolbarCssSrc, /:root:not\(\[data-theme="copybook"\], \[data-theme="typescript"\]\) \{[\s\S]*?\.session-tab \{\s*display:\s*block/);
  assert.match(toolbarCssSrc, /\.session-tab \{[^}]*background:\s*var\(--color-bg-panel\)/, "标签底色 = 井（--color-bg-panel，与 .pane 同值）");
  assert.match(stylesCss, /:root:not\(\[data-theme="copybook"\], \[data-theme="typescript"\]\) \.pane \{\s*background:\s*var\(--color-bg-panel\)/, "井的底色是 --color-bg-panel");
  assert.match(stylesCss, /:root:not\(\[data-theme="copybook"\], \[data-theme="typescript"\]\) \.rail-tab \{[^}]*background:\s*var\(--color-bg-panel\)/, "条上标签底色 = 井");
  // 只有面板真开着（props.panel 非空且就是这一项）、且不在窄窗覆盖层里才融合；archived / 设置这类子视图的点亮不算
  assert.match(railTsx, /fused=\{props\.fuse && props\.panel !== null && item\.id === props\.panel\}/);
  assert.match(appTsx, /fuse=\{!narrow\}/);
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
    "toolbar-capsule has-tab\" style={{ left: sess.x, width: sess.width }}",
    "toolbar-capsule cap-panel\" style={{ left: panelLeft, width: panelW }}",
    "toolbar-capsule\" style={{ left: toggleLeft, width: TOGGLE_CAP_W }}",
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
  // 行数 = 页头（有才占一行 auto）+ 通栏 banner（有才占一行 auto）+ 滚动区 1fr + 输入卡 auto：
  // 缺一行滚动区就会掉进 auto 行、输入卡掉进 1fr 行
  assert.match(
    chat,
    /props\.hideHeader === true \? "" : "auto "\}\$\{props\.banner === undefined \? "" : "auto "\}minmax\(0,1fr\) auto/,
    "Pane 的 grid 行没随页头 / 通栏有无切换——滚动区会掉进 auto 行、输入卡掉进 1fr 行",
  );
});

test("字标与星云同一行：绝对定位在停机坪、中心对齐云心（24），最左两格右移对齐今天", () => {
  const usageCss = readSource(join(RENDERER_SRC, "shell/usage.css"));
  assert.match(usageCss, /\.usage-brand\s*\{[^}]*position:\s*absolute[^}]*height:\s*48px/s, "字标没有绝对定位到星云那行（48px 空域）");
  assert.match(usageCss, /\.usage-brand\[data-yield\]\s*\{\s*transform:\s*translateX\(calc\(216px - 100%\)\)/, "星云在最左两格时字标没有右移对齐「今天」格");
  const meter = readSource(join(RENDERER_SRC, "shell/UsageMeter.tsx"));
  assert.match(meter, /data-yield=\{active <= 1 \|\| undefined\}/, "避让判定没接 active 格序");
});

test("胶囊页签头：有标题时三列 grid 让页签居中且标题不叠到页签下；审查面板页签即标题", () => {
  // 两侧 minmax(max-content, 1fr)：等宽轨道让页签组构造性居中；标题比 1fr 宽时轨道撑开、
  // 页签组让位右移，不再叠在标题上（2026-10-30「Context」叠在页签底下实测）
  assert.match(
    toolbarCss,
    /\.cap-review-head\s*\{\s*display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(max-content, 1fr\) auto minmax\(max-content, 1fr\)/,
    "缺页签头的三列 grid（两侧下限取内容宽）",
  );
  // 审查面板三个页签（改动 / 摘抄 / 记忆）加标题放不下：不画标题，页签靠左打头
  assert.match(toolbarCss, /\.cap-review-head\.tabs-as-title\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  const review = readSource(join(RENDERER_SRC, "features/review/ReviewPanel.tsx"));
  assert.match(review, /className="cap-review-head tabs-as-title"/, "审查头没用页签即标题的形态");
  assert.match(review, /className="cap-tabs"/, "审查页签组不在页签头里");
  // 来源下拉收成图标键（点开同一个来源菜单）
  assert.match(review, /git-branch" size=\{16\}/, "来源图标键没了");
  assert.match(review, /cap-review-head[\s\S]{0,2000}cap-seg solo/, "来源下拉没收成图标键");
});

test("胶囊内带文字的键豁免兜底重置（页签曾被压到 44px、padding 被清零）", () => {
  for (const cls of [".cap-tab", ".cap-sel", ".cap-crumb", ".cap-pt"]) {
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

test("会话胶囊窄时逐级让位、不重叠：标题居左成组、只有标题能缩（省略号）、面包屑与 id 保内容宽", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  assert.match(css, /\.cap-sess \{[^}]*display:\s*flex[^}]*justify-content:\s*flex-start/s, "标题居左：flex 起点对齐，不再是三栏居中");
  assert.doesNotMatch(css, /grid-template-columns:\s*1fr minmax\(0, max-content\) 1fr/, "居中三栏网格已删");
  assert.match(css, /\.cap-sess \{[^}]*container-type:\s*inline-size/s);
  assert.match(css, /\.cap-sess \.cap-sl \{[^}]*min-width:\s*max-content/s, "面包屑不许被压到内容以下");
  assert.match(css, /\.cap-sess \.cap-sc \{[^}]*flex:\s*0 1 auto/s, "标题是组里唯一能缩的");
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
    /rightLimit:\s*narrowLimit === null \? limit : Math\.min\(limit, narrowLimit\)/,
    "会话胶囊右限要让开右栏胶囊",
  );
  assert.doesNotMatch(toolbar, /panelLeft = props\.narrow\s*\?/, "panelLeft 不再单算一套窄窗分支");
});

test("会话胶囊容器显式铺满：设置页只有标题一个孩子也不塌", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  // container-type: inline-size 下元素宽不随内容撑开，没有显式宽就塌成 0
  assert.match(css, /\.cap-sess \{[^}]*container-type:\s*inline-size[^}]*width:\s*100%/s);
});

test("会话胶囊左缘与右栏胶囊同一条内缩：标题文字离胶囊左缘 12（右栏面板标题图标同样离 12）", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  assert.match(css, /\.cap-sess \{[^}]*padding:\s*0 var\(--space-0-5\) 0 var\(--space-1-5\)/s);
  assert.match(css, /\.toolbar-capsule \.cap-pt \{\s*padding:\s*0 var\(--space-2\) 0 var\(--space-2-5\)/, "右栏标题键的左内边距（2 + 10 = 12）");
  assert.equal(PANEL_CAPSULE_INSET, 8);
});

test("会话胶囊豁免拖拽：拖拽区收不到悬停，铅笔 / 复制键只在指针压到隐形按钮上时才显形", () => {
  const css = readFileSync(join(RENDERER_SRC, "shell/toolbar.css"), "utf8");
  assert.match(css, /\.cap-sess \{[^}]*-webkit-app-region:\s*no-drag/s, "整颗会话胶囊 no-drag，:hover 才会在标题 / 短 id 上成立");
  assert.match(css, /\.toolbar-capsule:hover \.cap-hov,\s*\.toolbar-capsule:focus-within \.cap-hov \{\s*visibility:\s*visible/, "键盘焦点进胶囊时也显形");
});
