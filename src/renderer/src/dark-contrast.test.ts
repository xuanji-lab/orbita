/**
 * 暗色两档的对比度守卫。
 *
 * 起因（2026-09-27）：用户点名黑色档里「回答结束后的折叠统计小字」看不清——
 * tertiary #6e6e6e 压在井 #141414 上只有 ~3.5:1，还落在 11px 的 micro 字号上。
 * 这类「调主题值时顺手把对比度调塌」的回归光靠眼睛兜不住，用 WCAG 对比度
 * 公式把底线钉进测试：井上的 tertiary ≥ 4.5（小字可读）、secondary ≥ 7、
 * 正文 ≥ 10，且三档文字的明度次序不许被调平。
 *
 * 只读 tokens/colors.css 的暗色两块（graphite / black）；色值解析认 `#rrggbb`，
 * 遇 rgba / color-mix 的 token 直接跳过（暗档文字色全是实色 hex）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "Orbita Design System",
  "tokens",
);

function themeBlock(theme: string): Map<string, string> {
  const css = readFileSync(join(TOKENS, "colors.css"), "utf8");
  // 选择器是成对的（:root[data-theme] 与 [data-theme-preview] 共用一个块），
  // [^{]* 跨过逗号与第二个选择器再开块
  const match = css.match(new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([\\s\\S]*?)\\}`));
  assert.ok(match !== null, `colors.css 里找不到 ${theme} 的 token 块`);
  const body = match[1] ?? "";
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name === undefined || value === undefined) continue;
    vars.set(name, value.trim());
  }
  return vars;
}

/** sRGB 相对亮度（WCAG）；入参 #rrggbb */
function luminance(hex: string): number {
  const lin = (i: number): number => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

function contrast(fg: string, bg: string): number {
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

const REQUIRED = [
  { token: "--color-text-tertiary", floor: 4.5, why: "micro 小字（折叠统计行）的底线" },
  { token: "--color-text-secondary", floor: 7, why: "副标与状态词要稳读" },
  { token: "--color-text-primary", floor: 10, why: "正文对比即阅读舒适" },
] as const;

describe("暗色两档的对比度底线（井 = --color-bg-panel）", () => {
  for (const theme of ["graphite", "black"] as const) {
    it(`${theme}：${REQUIRED.map((r) => `${r.token.slice("--color-text-".length)} ≥ ${r.floor}`).join("、")}`, () => {
      const vars = themeBlock(theme);
      const well = vars.get("--color-bg-panel");
      assert.ok(well !== undefined && /^#[0-9a-f]{6}$/i.test(well), `${theme} 的井底必须是实色 hex`);
      for (const { token, floor, why } of REQUIRED) {
        const value = vars.get(token);
        assert.ok(value !== undefined && /^#[0-9a-f]{6}$/i.test(value), `${theme} 的 ${token} 必须是实色 hex`);
        const ratio = contrast(value, well);
        assert.ok(
          ratio >= floor,
          `${theme}：${token} ${value} 压井 ${well} 只有 ${ratio.toFixed(2)}:1，低于 ${floor}（${why}）`,
        );
      }
    });

    it(`${theme}：三档文字的明度次序不被调平（primary > secondary > tertiary）`, () => {
      const vars = themeBlock(theme);
      const pick = (token: string): number => {
        const value = vars.get(token);
        assert.ok(value !== undefined);
        return luminance(value);
      };
      assert.ok(
        pick("--color-text-primary") > pick("--color-text-secondary") &&
          pick("--color-text-secondary") > pick("--color-text-tertiary"),
        `${theme} 的文字档位次序被调平了`,
      );
    });
  }
});
