import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCERPT_CLIP_TOLERANCE_PX,
  isClipped,
  showToggle,
  toggleExpanded,
} from "./excerpt-expand.ts";

describe("isClipped", () => {
  test("藏了内容才算截断：scrollHeight 超过 clientHeight", () => {
    assert.equal(isClipped(120, 63), true);
    assert.equal(isClipped(63, 63), false);
  });

  test("亚像素差在容差内不算截断", () => {
    assert.equal(isClipped(63 + EXCERPT_CLIP_TOLERANCE_PX, 63), false);
    assert.equal(isClipped(63 + EXCERPT_CLIP_TOLERANCE_PX + 0.01, 63), true);
    assert.equal(isClipped(63.4, 63), false);
  });
});

describe("showToggle（是否显示展开 / 收起键）", () => {
  test("短摘抄没截断不出键；截断出键", () => {
    assert.equal(showToggle(false, false), false);
    assert.equal(showToggle(true, false), true);
  });

  test("展开后 isClipped 会翻回 false，键靠 expanded 兜底留着（否则收不回去）", () => {
    assert.equal(showToggle(false, true), true);
    assert.equal(showToggle(true, true), true);
  });
});

describe("toggleExpanded", () => {
  test("加一个、再切掉一个；原集合不被改动", () => {
    const before = new Set(["a"]);
    const once = toggleExpanded(before, "b");
    assert.deepEqual([...once].sort(), ["a", "b"]);
    const twice = toggleExpanded(once, "a");
    assert.deepEqual([...twice], ["b"]);
    assert.deepEqual([...before], ["a"]);
  });
});

describe("excerpts-tab.css 样式守卫", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "excerpts-tab.css"), "utf8");

  test("收起态仍是三行截断，展开态解掉 line-clamp", () => {
    assert.match(css, /\.excerpts-text\s*\{[^}]*-webkit-line-clamp:\s*3/s);
    assert.match(css, /\.excerpts-text\[data-expanded="true"\]\s*\{[^}]*-webkit-line-clamp:\s*unset/s);
  });

  test("展开 / 收起键是安静键：aria-expanded 驱动箭头旋转，贴左不占行尾", () => {
    assert.match(css, /\.excerpts-toggle\s*\{[^}]*justify-self:\s*start/s);
    assert.match(css, /\.excerpts-toggle\[aria-expanded="true"\][^{]*\{[^}]*transform:\s*rotate\(180deg\)/s);
    // 行尾血线：删除键的领地仍是 margin-left: auto，展开键不入驻
    assert.match(css, /\.excerpts-acts\s*\{[^}]*margin-left:\s*auto/s);
  });
});
