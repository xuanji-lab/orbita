import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTokensModule, TOKENS_OUT } from "./gen-theme.ts";
import { buildIconsModule, ICONS_OUT, parseIcon } from "./gen-icons.ts";
import { metrics, themeColors } from "./tokens.ts";

test("已提交的 tokens.gen.ts 与设计系统同步（设计系统改了 token 就要重新 bun run gen）", () => {
  assert.equal(readFileSync(TOKENS_OUT, "utf8"), buildTokensModule());
});

test("已提交的 icons.gen.ts 与设计系统里的 lucide 文件同步", () => {
  assert.equal(readFileSync(ICONS_OUT, "utf8"), buildIconsModule());
});

test("颜色：var 引用、color-mix 透明度、暗档沿用浅色没声明的那几项", () => {
  const css = `
    :root,
    [data-theme-preview="light"] {
      --color-text-primary: #1f1f1f;
      --color-bg-active: color-mix(in srgb, var(--color-text-primary) 10%, transparent);
      --color-accent: #1d4ed8;
      --color-citation-mark: rgba(250, 204, 21, 0.45);
    }
    :root[data-theme="graphite"],
    [data-theme-preview="graphite"] { --color-text-primary: #fff; }
    :root[data-theme="black"],
    [data-theme-preview="black"] { --color-accent: #d6c245; }
  `;
  const colors = themeColors(css);
  assert.equal(colors.light["bgActive"], "rgba(31, 31, 31, 0.1)");
  assert.equal(colors.graphite["bgActive"], "rgba(255, 255, 255, 0.1)");
  assert.equal(colors.black["accent"], "#d6c245");
  assert.equal(colors.black["textPrimary"], "#1f1f1f");
  assert.equal(colors.light["citationMark"], "rgba(250, 204, 21, 0.45)");
  assert.throws(() => themeColors(css.replace("#1d4ed8", "hsl(0 0% 0%)")), /unsupported colour/);
});

test("尺寸：calc、rem、后声明覆盖先声明", () => {
  const out = metrics([":root { --radius: 0.5rem; --radius-xl: calc(var(--radius) + 2px); --space-0-5: 2px; }", ":root { --radius-xl: var(--radius); --ui-font-size: 14px; --font-size-sm: calc(var(--ui-font-size) - 2px); }"]);
  assert.deepEqual(out, { fontSizeSm: 12, radius: 8, radiusXl: 8, space0_5: 2, uiFontSize: 14 });
});

test("图标：只收图形元素与几何属性", () => {
  const icon = parseIcon('<svg class="x" stroke="currentColor"><path d="M1 1h2"></path><circle cx="12" cy="12" r="10" class="y"></circle></svg>');
  assert.deepEqual(icon, [
    ["path", { d: "M1 1h2" }],
    ["circle", { cx: "12", cy: "12", r: "10" }],
  ]);
  assert.throws(() => parseIcon("<svg><text>x</text></svg>"), /unsupported svg element/);
});
