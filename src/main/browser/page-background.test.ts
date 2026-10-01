/**
 * 空白 tab 垫底色的守卫：主进程抄的色值必须与设计系统 tokens/colors.css 各档的
 * `--color-bg-app` 一致（token 改了这里当场红），以及 system 按系统深浅落档。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_BACKGROUNDS, pageBackgroundColor } from "./page-background.ts";

const COLORS_CSS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "Orbita Design System",
  "tokens",
  "colors.css",
);

/** 取某一档 token 块里的 --color-bg-app。light 的块挂在 `:root,` 上，其余在 `:root[data-theme="…"]` */
function bgAppOf(theme: string): string {
  const css = readFileSync(COLORS_CSS, "utf8");
  const selector = theme === "light" ? ":root,\\s*\\[data-theme-preview=\"light\"\\]" : `:root\\[data-theme="${theme}"\\]`;
  const match = css.match(new RegExp(`${selector}[^{]*\\{([\\s\\S]*?)\\}`));
  assert.ok(match !== null, `colors.css 里找不到 ${theme} 的 token 块`);
  const value = (match[1] ?? "").match(/--color-bg-app:\s*([^;]+);/)?.[1]?.trim();
  assert.ok(value !== undefined, `${theme} 的块里没有 --color-bg-app`);
  return value;
}

describe("空白 tab 垫底色", () => {
  for (const [theme, color] of Object.entries(PAGE_BACKGROUNDS)) {
    it(`${theme}：与 colors.css 的 --color-bg-app 一致`, () => {
      assert.equal(color.toLowerCase(), bgAppOf(theme).toLowerCase());
    });
  }

  it("system 按系统深浅落档：深 → 玄（black），浅 → light", () => {
    assert.equal(pageBackgroundColor("system", true), PAGE_BACKGROUNDS.black);
    assert.equal(pageBackgroundColor("system", false), PAGE_BACKGROUNDS.light);
  });

  it("手选的档不看系统深浅：黛在浅色系统下仍是黛，纸面档在深色系统下仍是纸面", () => {
    assert.equal(pageBackgroundColor("graphite", false), PAGE_BACKGROUNDS.graphite);
    assert.equal(pageBackgroundColor("copybook", true), PAGE_BACKGROUNDS.copybook);
  });
});
