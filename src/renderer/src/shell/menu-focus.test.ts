import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReturnFocus } from "./menu-focus.ts";

const body = { tag: "body" } as unknown as Element;
const input = { tag: "input" } as unknown as Element;

test("焦点在 body 或没有焦点：还；已经在别的元素（菜单项交出去的输入框、用户点到的控件）：不抢", () => {
  assert.equal(shouldReturnFocus(body, body), true);
  assert.equal(shouldReturnFocus(null, body), true);
  assert.equal(shouldReturnFocus(input, body), false);
});

// 仓里没有 jsdom：opt-in 的结构只能按源码文本钉住——不传 manageFocus 时 Menu 走原来的代码路径
const HERE = dirname(fileURLToPath(import.meta.url));
const menu = readFileSync(join(HERE, "Menu.tsx"), "utf8").replace(/\r\n/g, "\n");

test("close 与 origin/main 逐字一致：不碰焦点、不带定时器（还焦点只在 manageFocus 的独立 effect 里）", () => {
  assert.match(
    menu,
    /const close = useCallback\(\(\) => \{\n    setOpen\(false\);\n    setPosition\(null\);\n    setQuery\(""\);\n  \}, \[\]\);/,
  );
});

test("两处焦点行为都以 props.manageFocus !== true 早退；还焦点的判断在 setTimeout 回调里（执行 focus 的那一刻）", () => {
  const effects = menu.match(/if \(props\.manageFocus !== true[^\n]*return;/g) ?? [];
  assert.equal(effects.length, 2);
  assert.match(
    menu,
    /setTimeout\(\(\) => \{\n\s*if \(shouldReturnFocus\(document\.activeElement, document\.body\)\) target\.focus\(\);\n\s*\}, 0\);/,
  );
});

test("选中一行（choose）不直接碰焦点——菜单项 onSelect 交出去的焦点归它自己", () => {
  const choose = /const choose = \(item: MenuItem\) => \{([\s\S]*?)\n  \};/.exec(menu);
  assert.ok(choose !== null);
  assert.doesNotMatch(choose[1] ?? "", /focus\(/);
});
