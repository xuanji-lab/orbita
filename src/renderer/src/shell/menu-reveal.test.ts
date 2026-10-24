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
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// CRLF 归一：Windows 检出的工作区是 CRLF，下面的正则按 LF 写
const menu = readFileSync(join(HERE, "Menu.tsx"), "utf8").replace(/\r\n/g, "\n");

test("首帧 position 为 null 时面板不限高——这就是打开那一刻 scrollIntoView 滚不动的原因", () => {
  assert.match(menu, /\.\.\.\(position === null\s*\n\s*\? null\n/);
});

test("另有一道 reveal 按已写上的高度触发，且只在有高度时跑", () => {
  assert.match(menu, /const appliedCap = position === null \? null : position\.cap;/);
  assert.match(
    menu,
    /useLayoutEffect\(\(\) => \{\n\s*if \(!open \|\| appliedCap === null\) return;\n\s*revealCursor\(\);[\s\S]{0,80}?\}, \[open, appliedCap\]\);/,
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
