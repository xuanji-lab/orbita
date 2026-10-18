/**
 * 发版兜底：package.json 必须给当前版本写了应用内说明（builtin-notes.ts 的出处）。
 * 没写 / 写成了带 HTML 的文本时 builtinNotes() 是 null，设置页「当前版本」展开只剩一句
 * 「这一版没有更新说明」——那不该等到发布后才发现，这里在提交阶段就拦下。
 *
 * 写错图标名不会崩，但那一条会没有图标；所以同时守：每行都带 [icon:名字]、
 * 图标真的登记在 Icon.tsx 里。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { builtinNotes } from "./builtin-notes.ts";

describe("builtinNotes —— 当前版本的应用内说明", () => {
  const notes = builtinNotes() ?? [];
  const iconSource = readFileSync(new URL("../../renderer/src/shell/Icon.tsx", import.meta.url), "utf8");

  test("package.json 写了说明，且是纯文本（不是从 Release 页抄来的 markdown / HTML）", () => {
    assert.ok(notes.length > 0, "build.releaseInfo.releaseNotes 为空：软件里这一版会没有说明");
    for (const note of notes) {
      assert.ok(note.text.trim() !== "", "条目正文不能是空的");
      assert.doesNotMatch(note.text, /^#|\*\*|^\|/, `像是 markdown：${note.text}`);
    }
  });

  test("每一条都带 [icon:名字]，且图标已在 Icon.tsx 登记（有 svg、有 import）", () => {
    for (const note of notes) {
      assert.ok(note.icon !== null, `这一条没写图标：${note.text}`);
      const svg = new URL(`../../../design-system/assets/icons/lucide/${note.icon}.svg`, import.meta.url);
      assert.ok(existsSync(svg), `design-system 里没有 ${note.icon}.svg`);
      assert.ok(iconSource.includes(`lucide/${note.icon}.svg?raw`), `Icon.tsx 没有登记 ${note.icon}`);
    }
  });
});
