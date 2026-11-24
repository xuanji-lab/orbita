import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 故事版样式的契约（静态读 CSS）：守住「运动只用 transform / opacity」「accent 只给主操作」「不画阴影」。
 * 视觉真值在真实例截图里看；这里只拦会悄悄变质的几条。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "story.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("story.css 的动效与配色约束", () => {
  test("所有 @keyframes 只动 transform / translate / scale / rotate / opacity", () => {
    const allowed = new Set(["transform", "translate", "scale", "rotate", "opacity"]);
    const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
    assert.ok(blocks.length >= 8, "应该找到故事版的全部关键帧");
    for (const block of blocks) {
      const props = [...(block[2] ?? "").matchAll(/([\w-]+)\s*:/g)].map((m) => m[1] ?? "");
      for (const prop of props) assert.ok(allowed.has(prop), `@keyframes ${block[1]} 动了 ${prop}（只许 transform / opacity）`);
    }
  });

  test("没有 accent：主按钮的 accent 来自全局 .btn-accent，故事版自己的样式不碰 accent 色", () => {
    assert.doesNotMatch(css, /--color-accent/);
  });

  test("不画阴影（发丝线分层）：只有底栏「上一步」那圈 inset 1px 描边", () => {
    const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    assert.deepEqual(shadows, ["inset 0 0 0 1px var(--color-border-default)"]);
    assert.doesNotMatch(css, /text-shadow|drop-shadow|filter\s*:/);
  });

  test("站不用 nebula 当色（浅色下它与 accent 肉眼同蓝）：nebula 只出现在通讯连线那一个变量里", () => {
    const uses = [...css.matchAll(/[^\n]*--color-nebula[^\n]*/g)].map((m) => m[0].trim());
    assert.equal(uses.length, 1, `nebula 出现了 ${uses.length} 处：${uses.join(" | ")}`);
    assert.match(uses[0] ?? "", /^--sv-comm:/);
    assert.match(css, /--sv-fill:\s*var\(--sv-ink\)/);
  });

  test("航行日志永远走夜空：夜空变量只靠 data-night，journal 自己不覆盖成浅色", () => {
    assert.match(css, /\.sv\[data-night="true"\]\s*\{/);
    assert.match(css, /\.sv\[data-style="journal"\]\[data-night="true"\]/);
  });

  test("持续的动效（转 / 抖 / 闪）都在窗口失焦暂停的清单里", () => {
    for (const selector of [".sv-ring", ".sv-ov-ring", ".sv-lbl-in", ".sv-shake", ".sv-hollow", ".sv-moon-orbit", ".sv-hintring", '.sv-card[data-state="lost"]']) {
      assert.ok(css.includes(`[data-window-inactive="true"] ${selector}`), `${selector} 不在失焦暂停清单里`);
    }
  });

  test("引导覆盖层在 Windows / Linux 上让出自绘三键（同手册）", () => {
    assert.match(css, /:root:not\(\[data-platform="darwin"\]\) \.sv\s*\{[^}]*top:\s*var\(--titlebar-brand-row\)/);
  });
});
