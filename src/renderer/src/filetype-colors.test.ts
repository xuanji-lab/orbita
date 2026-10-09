/**
 * 文件类型色的对比度守卫（F，2026-10）。
 *
 * 文档 / 演示 / 表格三族的图标色只用在 13–14px 的小图标上——图标级别的可辨底线
 * 取 3:1（WCAG 非文字对比度）。这组色在五档主题里各配一套（明与两纸面共用深值、
 * 黛 / 玄共用亮值），消费面（文件面板树、输入框胶囊、Session·附件列表）坐在
 * 井、卡、壳三种底上，所以三个底面（--color-bg-panel / muted / app）都要过线；
 * 另断言三色色相彼此分开 ≥ 40°——色相不分开，「颜色差异」就只剩明度在撑。
 *
 * 解析口径同 dark-contrast.test.ts：只认 `#rrggbb`，遇 var() / rgba 的 token 跳过
 * （这组全是实色 hex）；明档块的选择器是 `:root,\n[data-theme-preview="light"]`，
 * 单独认。
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

function varsOf(css: string, from: number, to: number): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of css.slice(from, to).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name === undefined || value === undefined) continue;
    vars.set(name, value.trim());
  }
  return vars;
}

function themeBlock(theme: string): Map<string, string> {
  // 先折 CRLF：明档块靠两行字面量定位，Windows 工作区（core.autocrlf=true）拉
  // 下来的 colors.css 带 \r\n，字面量会找不到（2026-10-10 Windows CI 与本地同报
  // 「找不到明档 token 块」；Linux 上一直绿）
  const css = readFileSync(join(TOKENS, "colors.css"), "utf8").replace(/\r\n/g, "\n");
  if (theme === "light") {
    const open = css.indexOf(":root,\n[data-theme-preview=\"light\"] {");
    assert.ok(open >= 0, "colors.css 里找不到明档 token 块");
    const close = css.indexOf("\n}", open);
    return varsOf(css, open, close);
  }
  const match = css.match(new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{`));
  assert.ok(match !== null, `colors.css 里找不到 ${theme} 的 token 块`);
  const open = css.indexOf("{", match.index ?? 0);
  const close = css.indexOf("\n}", open);
  return varsOf(css, open, close);
}

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

/** HSL 色相（度）；饱和度近零的灰色返回 null（不参与色相距离） */
function hueOf(hex: string): number | null {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return h;
}

const THEMES = ["light", "graphite", "black", "copybook", "typescript"] as const;
const TONES = ["doc", "slides", "sheet"] as const;

describe("文件类型色（--color-filetype-*）", () => {
  for (const theme of THEMES) {
    it(`${theme}：五档主题都配齐三色，且三个底面上 ≥ 3:1（图标级）`, () => {
      const block = themeBlock(theme);
      for (const tone of TONES) {
        const hex = block.get(`--color-filetype-${tone}`);
        assert.ok(hex !== undefined && /^#[0-9a-f]{6}$/i.test(hex), `${theme} 缺 --color-filetype-${tone}（或不是实色 hex）`);
        for (const ground of ["--color-bg-panel", "--color-bg-muted", "--color-bg-app"]) {
          const bg = block.get(ground);
          assert.ok(bg !== undefined && /^#[0-9a-f]{6}$/i.test(bg), `${theme} 的 ${ground} 不是实色 hex`);
          const ratio = contrast(hex, bg);
          assert.ok(
            ratio >= 3,
            `${theme} 的 ${tone} 色 ${hex} 压在 ${ground} ${bg} 上只有 ${ratio.toFixed(2)}:1（要 ≥ 3）`,
          );
        }
      }
    });
  }

  for (const theme of THEMES) {
    it(`${theme}：三色色相彼此分开 ≥ 40°`, () => {
      const block = themeBlock(theme);
      const hues = TONES.map((tone) => {
        const hex = block.get(`--color-filetype-${tone}`);
        assert.ok(hex !== undefined);
        return hueOf(hex);
      });
      for (let i = 0; i < hues.length; i++) {
        assert.ok(hues[i] !== null, `${theme} 的 ${TONES[i]} 色接近灰，没有色相`);
      }
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          const a = hues[i];
          const b = hues[j];
          if (a === null || b === null || a === undefined || b === undefined) continue;
          const gap = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
          assert.ok(gap >= 40, `${theme} 的 ${TONES[i]} 与 ${TONES[j]} 色相只差 ${gap.toFixed(0)}°（要 ≥ 40）`);
        }
      }
    });
  }
});
