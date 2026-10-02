/**
 * 材料类型色组（--color-material-*）的对比度守卫。
 *
 * 这组颜色只有一个职责：游戏化材料区（俄罗斯方块）区分四种材料——截图 / 文件与目录 /
 * 粘贴文本 / 引用。用法是淡染（块底 = 本色 14% 混面板、描边 38% 透明、图标用本色、
 * 文字恒用正墨），所以承色的是 13px 的 lucide 图标：WCAG 对非文字的下线是 3:1，
 * 但主题色被「调主题时顺手调塌」的先例（dark-contrast.test.ts 的起因）提醒我们把底线
 * 钉高一点——**五档主题（含两档纸面）都要在各自面板上 ≥ 4.5**，图标色稳读之外，
 * 调色时的手抖也会当场被抓。
 *
 * 解析与 dark-contrast.test.ts 同源：读 tokens/colors.css 的主题块，只认实色 #rrggbb。
 * light 挂在裸 `:root` 上（与 [data-theme-preview="light"] 共用一个块），单独处理。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COLORS_CSS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "Orbita Design System",
  "tokens",
  "colors.css",
);

const MATERIAL_TYPES = ["image", "file", "pasted", "quote"] as const;

/** 各主题的 token 块：light 取裸 :root 块，其余取 :root[data-theme="…"] 块 */
function themeBlock(theme: "light" | "graphite" | "black" | "copybook" | "typescript"): Map<string, string> {
  const css = readFileSync(COLORS_CSS, "utf8");
  const pattern =
    theme === "light"
      ? /:root,?\s*\[data-theme-preview="light"\]\s*\{([\s\S]*?)\}/
      : new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([\\s\\S]*?)\\}`);
  const match = css.match(pattern);
  assert.ok(match !== null, `colors.css 里找不到 ${theme} 的 token 块`);
  const vars = new Map<string, string>();
  for (const m of (match[1] ?? "").matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name === undefined || value === undefined) continue;
    vars.set(name, value.trim());
  }
  return vars;
}

/** sRGB 相对亮度（WCAG，同 dark-contrast.test.ts）；入参 #rrggbb */
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

/**
 * HSL 色相角（0–360）。分类色板的「分得开」看色相距离，不是亮度对比：cyan 与
 * green 亮度可叠、色相离得开，淡染下仍一眼两色（亮度对比是同色相时的标尺）。
 * 入参 #rrggbb；饱和度低于 15% 的灰色没有色相可言，返回 null——本组四色都是彩色的。
 */
function hueOf(hex: string): number | null {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

describe("材料类型色组：五档主题的面板对比度 ≥ 4.5", () => {
  for (const theme of ["light", "graphite", "black", "copybook", "typescript"] as const) {
    for (const type of MATERIAL_TYPES) {
      it(`${theme} · ${type}`, () => {
        const vars = themeBlock(theme);
        const panel = vars.get("--color-bg-panel");
        assert.ok(panel !== undefined && /^#[0-9a-f]{6}$/i.test(panel), `${theme} 的面板底必须是实色 hex`);
        const value = vars.get(`--color-material-${type}`);
        assert.ok(
          value !== undefined && /^#[0-9a-f]{6}$/i.test(value),
          `${theme} 的 --color-material-${type} 必须是实色 hex`,
        );
        const ratio = contrast(value, panel);
        assert.ok(
          ratio >= 4.5,
          `${theme}：--color-material-${type} ${value} 压面板 ${panel} 只有 ${ratio.toFixed(2)}:1，低于 4.5（材料块的图标用本色承色）`,
        );
      });
    }
  }
});

describe("材料类型色组：四种材料在每一档里互相分得开（色相隔 ≥ 30°）", () => {
  for (const theme of ["light", "graphite", "black", "copybook", "typescript"] as const) {
    it(`${theme}：任意两种材料色色相隔 ≥ 30°`, () => {
      const vars = themeBlock(theme);
      const hues = MATERIAL_TYPES.map((type) => {
        const value = vars.get(`--color-material-${type}`);
        assert.ok(value !== undefined, `${theme} 缺 --color-material-${type}`);
        const hue = hueOf(value);
        assert.ok(hue !== null, `${theme} 的 --color-material-${type} 是灰色，没有色相可分`);
        return hue;
      });
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          const a = hues[i] ?? 0;
          const b = hues[j] ?? 0;
          const distance = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
          assert.ok(
            distance >= 30,
            `${theme}：${MATERIAL_TYPES[i]}（${a.toFixed(0)}°）与 ${MATERIAL_TYPES[j]}（${b.toFixed(0)}°）色相只隔 ${distance.toFixed(0)}°，两种材料快分不开了`,
          );
        }
      }
    });
  }
});
