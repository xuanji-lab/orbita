/**
 * 菜单打开时「把光标行带进视野」的时序。
 *
 * 仓里没有 renderer 组件测试设施（没有 jsdom），React effect 的先后与 DOM 滚动只能在真实例里看；
 * 这里按源码文本钉住**时序所依赖的几处结构**——任何一处被改掉，长清单里打勾行就会再次停在
 * 视野外（2026-10-25 实测：OpenCode 36 个型号，打开后 scrollTop 仍是 0）：
 *
 * 1. 首帧 position 为 null 时面板不设 height / maxHeight（在量自然高度），清单无处可滚；
 * 2. 所以必须另有一道按**已写上的高度**（appliedCap）触发的 reveal；
 * 3. close 把 position 清回 null——每次打开都经 null → cap，那一道必跑；
 * 4. 键盘上下那一道照旧 [open, active, visible.length] + nearest，不被高度牵动。
 *
 * 左栏（模型卡片的厂商列）同理：厂商多时左栏自己也滚，当前格要在同一时机带进视野；
 * 当前格要一眼看得出（光圈）、悬停要说得出是哪家（自绘提示，不靠两秒才出的原生 title）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// CRLF 归一：Windows 检出的工作区是 CRLF，下面的正则按 LF 写
const read = (path: string) => readFileSync(join(HERE, path), "utf8").replace(/\r\n/g, "\n");
const menu = read("Menu.tsx");
const styles = read("../styles.css");
const modelMenu = read("../features/settings/model-menu.tsx");

test("首帧 position 为 null 时面板不限高——这就是打开那一刻 scrollIntoView 滚不动的原因", () => {
  assert.match(menu, /\.\.\.\(position === null\s*\n\s*\? null\n/);
});

test("另有一道 reveal 按已写上的高度触发，且只在有高度时跑", () => {
  assert.match(menu, /const appliedCap = position === null \? null : position\.cap;/);
  assert.match(
    menu,
    /useLayoutEffect\(\(\) => \{\n\s*if \(!open \|\| appliedCap === null\) return;\n\s*revealCursor\(\);[\s\S]{0,800}?\}, \[open, appliedCap\]\);/,
  );
});

test("close 把 position 清回 null：每次打开都经 null → cap，那一道 reveal 必跑", () => {
  assert.match(menu, /const close = useCallback\(\(\) => \{\n\s*setOpen\(false\);\n\s*setPosition\(null\);/);
});

test("键盘上下那一道不变：[open, active, visible.length] + nearest，不依赖高度", () => {
  assert.match(menu, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(
    menu,
    /useLayoutEffect\(\(\) => \{\n\s*if \(!open\) return;\n\s*revealCursor\(\);[\s\S]{0,120}?\}, \[open, active, visible\.length\]\);/,
  );
});

test("左栏当前格（aria-selected）在同一道按高度触发的 reveal 里带进视野，不进键盘那一道", () => {
  const heightEffect = /if \(!open \|\| appliedCap === null\) return;([\s\S]*?)\}, \[open, appliedCap\]\);/.exec(menu);
  assert.ok(heightEffect !== null);
  assert.match(heightEffect[1] ?? "", /railRef\.current\?\.querySelector<HTMLElement>\('\[aria-selected="true"\]'\)\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
  const keyboardEffect = /if \(!open\) return;\n\s*revealCursor\(\);([\s\S]*?)\}, \[open, active, visible\.length\]\);/.exec(menu);
  assert.ok(keyboardEffect !== null);
  assert.doesNotMatch(keyboardEffect[1] ?? "", /railRef/);
});

test("左栏当前格：图标条当前项配方 + 1px 内圈光圈，全走 token、压过 hover", () => {
  const rule = /\.option-row\.model-rail-cell\[aria-selected="true"\] \{([^}]*)\}/.exec(styles);
  assert.ok(rule !== null, "缺左栏当前格的规则");
  const body = rule[1] ?? "";
  assert.match(body, /background: var\(--color-mode-active-bg\);/);
  assert.match(body, /color: var\(--color-mode-active-fg\);/);
  assert.match(body, /box-shadow: inset 0 0 0 1px var\(--color-mode-active-fg\);/);
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, "禁裸 hex");
});

test("左栏格子：自绘悬停提示报出全名，不挂原生 title（防双提示、防两秒延迟）", () => {
  const cell = /function RailCell\([\s\S]*?\n\}\n/.exec(modelMenu);
  assert.ok(cell !== null, "缺 RailCell");
  const body = cell[0];
  assert.match(body, /useHoverTooltip<HTMLButtonElement>/);
  assert.match(body, /className="model-rail-tip"/);
  assert.match(body, /aria-label=\{props\.label\}/);
  assert.match(body, /aria-selected=\{props\.selected\}/);
  assert.doesNotMatch(body, /\btitle=/);
  // 三种格子（星标 / 全部 / 各厂商）都走 RailCell：左栏里不再有裸 option-row 按钮
  const rail = /export function modelPickerRail\([\s\S]*?\n\}\n/.exec(modelMenu);
  assert.ok(rail !== null);
  assert.doesNotMatch(rail[0], /<button/);
  assert.equal((rail[0].match(/<RailCell/g) ?? []).length, 3);
});
