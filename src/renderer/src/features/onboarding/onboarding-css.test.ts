import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 引导覆盖层与 Windows / Linux 自绘窗口键的几何契约（2026-11-07 Windows 验收：全屏覆盖盖住三键，
 * 「跳过引导」压在最小化 / 最大化键上）。静态读 CSS——几何的真值在 Windows 实机 elementFromPoint 复验。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const onboardingCss = readFileSync(join(HERE, "onboarding.css"), "utf8");
const toolbarTsx = readFileSync(join(HERE, "../../shell/Toolbar.tsx"), "utf8");
const spacingCss = readFileSync(join(HERE, "../../../../../design-system/tokens/spacing.css"), "utf8");

describe("引导覆盖层给自绘三键让位", () => {
  test("非 macOS 时覆盖层从 brand row 下沿起铺（三键所在的行不被盖）", () => {
    const rule = /:root:not\(\[data-platform="darwin"\]\) \.ob\s*\{([^}]*)\}/.exec(onboardingCss);
    assert.ok(rule, "缺少非 darwin 的 .ob 让位规则");
    assert.match(rule[1] ?? "", /top:\s*var\(--titlebar-brand-row\)/);
  });

  test("macOS 不受影响：基础 .ob 仍是 inset: 0 全屏，让位规则不覆盖 darwin", () => {
    assert.match(/\n\.ob \{[^}]*inset:\s*0;/.exec(onboardingCss)?.[0] ?? "", /inset:\s*0;/);
    assert.doesNotMatch(onboardingCss, /:root\[data-platform="darwin"\] \.ob\b/);
  });

  test("三键确实住在 brand row（让位高度 = 三键所在行），且只在非 darwin 渲染", () => {
    assert.match(spacingCss, /--titlebar-brand-row:\s*\d+px/);
    assert.match(toolbarTsx, /\{!darwin && \(\s*<div className="brand-row">[\s\S]*?<WindowControls \/>/);
  });
});
