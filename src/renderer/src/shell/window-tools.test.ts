/**
 * 「窗口工具」组坐标不变量的对账（几何见 `window-tools.ts` 的头注释）：
 *
 *   展开态组左缘 = LAYER_PAD + SIDEBAR_PAD + 红绿灯净空
 *   收起态组左缘 = LAYER_PAD + 页头 inset（--window-tools-inset）
 *
 * 第一条断言验证两条链算出同一个 x（纯函数层面）；其余断言把链上每一环与
 * 真正排版的那份 CSS / 组件源码对上——常量若在任一侧被单独改动，这里先红：
 * 坐标不变不是「量出来没跳」，而是两侧由同一套值保证。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLAPSE_BREAKPOINT,
  DARWIN_CLEARANCE,
  LAYER_PAD,
  SIDEBAR_PAD,
  TITLEBAR_ROW_HEIGHT,
  TRAFFIC_LIGHT_DOT,
  TRAFFIC_LIGHT_Y,
  collapsedHeaderInset,
  clearanceOf,
  expandedToolsX,
} from "./window-tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/src/renderer/src/shell —— 上到 src/renderer/src，再上三层到仓库根
const RENDERER_SRC = join(HERE, "..");
const REPO_ROOT = join(RENDERER_SRC, "..", "..", "..");
const stylesCss = readFileSync(join(RENDERER_SRC, "styles.css"), "utf8");
const spacingCss = readFileSync(join(REPO_ROOT, "design-system/tokens/spacing.css"), "utf8");
const typographyCss = readFileSync(join(REPO_ROOT, "design-system/tokens/typography.css"), "utf8");
const sidebarTsx = readFileSync(join(RENDERER_SRC, "shell/Sidebar.tsx"), "utf8");
const appTsx = readFileSync(join(RENDERER_SRC, "App.tsx"), "utf8");
const iconTsx = readFileSync(join(RENDERER_SRC, "shell/Icon.tsx"), "utf8");
const windowToolsTsx = readFileSync(join(RENDERER_SRC, "shell/WindowTools.tsx"), "utf8");
const mainIndexTs = readFileSync(join(REPO_ROOT, "src/main/index.ts"), "utf8");

/** 从 CSS 文本里抽出一条规则的声明块（选择器在行首匹配，避免子串误中长选择器）；找不到返回 null */
function ruleBlock(css: string, selector: string): string | null {
  const index = css.indexOf(`\n${selector}`);
  if (index === -1) return null;
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return close === -1 ? null : css.slice(open + 1, close);
}

const PLATFORMS = ["darwin", "other"] as const;

test("展开与收起两态，工具组左缘落在同一个窗口 x", () => {
  for (const platform of PLATFORMS) {
    const expanded = expandedToolsX(platform);
    // 收起态：pane 左缘（= .layer 的 padding）+ 页头 inset
    const collapsed = LAYER_PAD + collapsedHeaderInset(platform);
    assert.equal(
      collapsed,
      expanded,
      `${platform}: 收起态 ${collapsed}px ≠ 展开态 ${expanded}px——侧栏开关会跳位`,
    );
  }
});

test("darwin 有净空、其它平台为 0；收起态 inset = 侧栏那层 + 净空", () => {
  assert.equal(clearanceOf("darwin"), DARWIN_CLEARANCE);
  assert.equal(clearanceOf("other"), 0);
  assert.equal(collapsedHeaderInset("darwin"), SIDEBAR_PAD + DARWIN_CLEARANCE);
  assert.equal(collapsedHeaderInset("other"), SIDEBAR_PAD);
});

test("CSS 侧同一套值：净空 / inset 变量与 .layer、侧栏的内边距", () => {
  // 红绿灯净空：常量与 styles.css 的 --traffic-clearance（darwin 覆盖值）同值
  const clearanceDecl = stylesCss.match(
    /:root\[data-platform="darwin"\]\s*\{[^}]*--traffic-clearance:\s*(\d+)px/,
  );
  assert.ok(clearanceDecl !== null, "styles.css 缺 darwin 的 --traffic-clearance 声明");
  assert.equal(Number(clearanceDecl[1]), DARWIN_CLEARANCE, "DARWIN_CLEARANCE 与 styles.css 的 --traffic-clearance 漂了");

  // 收起态页头 inset：基值 --window-tools-inset = --space-3（tokens/spacing.css）；
  // darwin 覆写 = calc(--space-3 + --traffic-clearance)（styles.css）
  assert.match(
    spacingCss,
    /--window-tools-inset:\s*var\(--space-3\)/,
    "tokens/spacing.css 缺 --window-tools-inset: var(--space-3)",
  );
  assert.match(
    stylesCss,
    /--window-tools-inset:\s*calc\(var\(--space-3\)\s*\+\s*var\(--traffic-clearance\)\)/,
    "styles.css 的 darwin --window-tools-inset 不是 --space-3 + --traffic-clearance",
  );

  // .layer 的内边距：--space-3（展开 / 收起两态共用的那层）
  assert.match(stylesCss, /\.layer\s*\{[^}]*padding:\s*var\(--space-3\)/, ".layer 的 padding 不再是 var(--space-3)");

  // --space-3 的实值与 TS 常量一致
  const space3 = spacingCss.match(/--space-3:\s*(\d+)px/);
  assert.ok(space3 !== null, "tokens/spacing.css 缺 --space-3");
  assert.equal(Number(space3[1]), LAYER_PAD, "LAYER_PAD 与 --space-3 漂了");
  assert.equal(SIDEBAR_PAD, LAYER_PAD, "侧栏 aside 的内边距与 .layer 不再共用 --space-3");
});

test("侧栏 aside 的 padding 仍以 --space-3 作行内边距（展开态链条的一环）", () => {
  assert.match(
    sidebarTsx,
    /padding:\s*"0 var\(--space-3\) var\(--space-2\)"/,
    "Sidebar 展开态 aside 的 padding 改了——window-tools.ts 的 SIDEBAR_PAD 要跟着改" +
      "（顶行要坐到卡顶，padding-top 是 0，行内边距仍是 --space-3）",
  );
});

test("顶栏行高：中心钉在红绿灯中心那条线上，主进程 / 常量 / CSS 三方同值", () => {
  // 行顶 = 卡顶（.layer 的 --space-3），行中心 = 红绿灯中心 → 2×(19+6−12) = 26
  assert.equal(TITLEBAR_ROW_HEIGHT, 2 * (TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_DOT / 2 - LAYER_PAD));
  assert.equal(TITLEBAR_ROW_HEIGHT, 26);

  // 红绿灯位置是真源：主进程改了 y，这里的推导就不再成立
  const pos = mainIndexTs.match(/trafficLightPosition:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/);
  assert.ok(pos !== null, "src/main/index.ts 里找不到 trafficLightPosition");
  assert.equal(Number(pos[2]), TRAFFIC_LIGHT_Y, "主进程红绿灯 y 改了——TRAFFIC_LIGHT_Y / TITLEBAR_ROW_HEIGHT 要重算");

  // 各处页头用的 CSS 变量与推导同值（token 真源在 tokens/spacing.css）
  const row = spacingCss.match(/--titlebar-row:\s*(\d+)px/);
  assert.ok(row !== null, "tokens/spacing.css 缺 --titlebar-row 声明");
  assert.equal(Number(row[1]), TITLEBAR_ROW_HEIGHT, "--titlebar-row 与 TITLEBAR_ROW_HEIGHT 漂了");
  assert.ok(!/--titlebar-row:\s*\d+px/.test(stylesCss), "--titlebar-row 又在渲染层 styles.css 里另写了一份——真源在 tokens");
});

test("断点常量只此一份：收起断点 960，App 的 matchMedia 用它", () => {
  assert.equal(COLLAPSE_BREAKPOINT, 960);
  assert.match(
    appTsx,
    /matchMedia\(`\(max-width: \$\{COLLAPSE_BREAKPOINT - 1}px\)`\)/,
    "App 的自动收起 effect 不再用 COLLAPSE_BREAKPOINT——断点改成了两处字面量",
  );
});

// —— 顶部栏公共规定（2026-10-19 用户：「感觉得搞下公共的规定，顶部栏相关的」）——
// 一处定义（token）+ 作用域兑底（.titlebar 规则自动接管行内一切）+ 组件只引 token。
// 下面的检查拦的是「下一处漏网」：token 被删 / 作用域被拆 / 组件又写回魔法数。

test("顶部栏 token 一份真源：几何量在 spacing.css，标题字号在 typography.css", () => {
  const expectToken = (css: string, name: string, value: string, file: string): void => {
    const found = css.match(new RegExp(`${name}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`));
    assert.ok(found !== null, `${file} 缺 ${name}: ${value}`);
  };
  expectToken(spacingCss, "--titlebar-row", `${TITLEBAR_ROW_HEIGHT}px`, "tokens/spacing.css");
  expectToken(spacingCss, "--titlebar-icon", "14px", "tokens/spacing.css");
  expectToken(spacingCss, "--titlebar-control", "24px", "tokens/spacing.css");
  expectToken(spacingCss, "--titlebar-field", "22px", "tokens/spacing.css");
  expectToken(typographyCss, "--font-size-titlebar", "var(--font-size-sm)", "tokens/typography.css");
});

test("作用域兑底还在：.titlebar 行内的图标 / 按钮 / 输入框 / 标题自动一档", () => {
  // 图标：作用域只翻 --icon-size，不用 !important（Icon 交出 inline 尺寸见下一案）
  assert.match(
    stylesCss,
    /\.titlebar:not\(\.window-titlebar\):not\(\.titlebar-exempt\)\s*\{\s*--icon-size:\s*var\(--titlebar-icon\)/,
    "顶部栏作用域的 --icon-size 规则不足——行内图标尺寸会失控",
  );
  assert.match(
    stylesCss,
    /\.titlebar \.titlebar-icon-own\s*\{\s*--icon-size:\s*var\(--icon-size-request\)/,
    "缺 .titlebar-icon-own 豁免（小箭头 / 状态点回自己的请求尺寸）",
  );
  const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [kind, prop, value] of [
    ["button", "height", "var(--titlebar-button-h, var(--titlebar-control))"],
    ["input", "height", "var(--titlebar-field)"],
    ["input", "font-size", "var(--font-size-titlebar)"],
    ["strong", "font-size", "var(--font-size-titlebar)"],
  ] as const) {
    assert.match(
      stylesCss,
      new RegExp(
        `\\.titlebar:not\\(\\.window-titlebar\\):not\\(\\.titlebar-exempt\\) ${kind}\\s*\\{[^}]*${prop}:\\s*${escapeRe(value)}`,
      ),
      `缺 .titlebar ${kind} 的 ${prop} 作用域规则（${value}）`,
    );
  }
});

test("Icon 把尺寸交给 CSS：请求值变量 + 全局宽度规则，不再 inline width/height", () => {
  assert.match(iconTsx, /"--icon-size-request": `\$\{size\}px`/, "Icon.tsx 不再写 --icon-size-request——作用域接管不了行内图标");
  assert.ok(!/width: size/.test(iconTsx), "Icon.tsx 又把 width 写回 inline 了——作用域永远盖不过 inline");
  const orbita = ruleBlock(stylesCss, ".orbita-icon {");
  assert.ok(orbita !== null, "styles.css 缺 .orbita-icon 基础规则");
  assert.match(
    orbita,
    /width:\s*var\(--icon-size,\s*var\(--icon-size-request\)\)/,
    ".orbita-icon 的宽度不再是 var(--icon-size, var(--icon-size-request)) 两层",
  );
});

test("顶部栏家族的 CSS 规则里不许再写字面量高度 / 字号（一律 token）", () => {
  const FAMILY = [
    ".panel-title strong",
    ".panel-title-toggle",
    ".panel-filter",
    ".panel-head-select",
    ".files-tab",
    ".files-title-toggle",
    ".intent-turn-chip",
  ];
  for (const selector of FAMILY) {
    const block = ruleBlock(stylesCss, `${selector} {`);
    assert.ok(block !== null, `styles.css 缺 ${selector} 规则`);
    const literal = block.match(/(?:height|font-size):\s*\d+(?:\.\d+)?px/);
    assert.equal(
      literal,
      null,
      `${selector} 里出现了字面量 ${literal?.[0]}——顶部行的高度 / 字号只能引 --titlebar-* / --font-size-titlebar`,
    );
  }
});

test("组件只引 token：面板按钮 / 收起态工具组的外框不写魔法数", () => {
  const rightPanelTsx = readFileSync(join(RENDERER_SRC, "shell/RightPanel.tsx"), "utf8");
  assert.match(rightPanelTsx, /size="var\(--titlebar-control\)"/, "PanelIconButton / PanelHelp 的外框不再走 --titlebar-control");
  assert.ok(!/size=\{2[46]\}/.test(rightPanelTsx), "RightPanel.tsx 里又出现了 size={24}/{26} 魔法数");
  assert.match(windowToolsTsx, /width: "var\(--titlebar-control\)"/, "RailButton 外框不再走 --titlebar-control");
});
