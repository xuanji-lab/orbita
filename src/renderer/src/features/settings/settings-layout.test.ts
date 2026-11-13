/**
 * 设置面根栅格的列宽：必须显式 minmax(0,1fr)。
 *
 * 缺省是隐式 auto 列，下限是页签内容的 min-content；右栏打开、主槽变窄时这一列不缩，
 * 内容溢出主槽、画到右栏底下（2026-11-07 用户报：模型服务页被右栏盖住）。布局问题单测
 * 量不到真实宽度，这里钉住源码里这一行，防止以后重写根容器时把它丢掉。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");

describe("设置面根栅格", () => {
  it("显式写了 gridTemplateColumns: minmax(0,1fr)，主槽变窄时内容跟着缩、不溢出到右栏下", () => {
    assert.match(source, /gridTemplateColumns:\s*"minmax\(0,\s*1fr\)"/);
  });
});

/**
 * 设置页里「只定义行、不定义列」的 grid：隐式 auto 列下限是内容的固有宽，列被右栏挤窄时撑出去。
 * 2026-11-07 Windows 验收：语音页 1200 宽右栏开，经典滚动条占 10px 后 clientWidth 502 < scrollWidth 506，
 * 输入框右边框被裁——根因是 .set-row-ctl 的隐式列被 320px 的输入框撑到 320，而控件列只有 306
 * （Mac overlay 滚动条下同样超出 14px，只是落在 20px 内边距里量不出来）。同类：模型服务页 .pv-wall
 * 被工具条撑出 26px。
 */
const settingsCss = readFileSync(new URL("./settings-view.css", import.meta.url), "utf8");
const providersCss = readFileSync(new URL("./providers-view.css", import.meta.url), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `找不到规则 ${selector}`);
  return match[1] ?? "";
}

describe("设置页内部 grid 的列宽可收", () => {
  it(".set-row-ctl（每个设置行的控件列）单列 minmax(0, 1fr)", () => {
    assert.match(ruleBody(settingsCss, ".set-row-ctl"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it(".pv-wall / .pv-wall-group（模型服务页）单列 minmax(0, 1fr)", () => {
    assert.match(ruleBody(providersCss, ".pv-wall"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(ruleBody(providersCss, ".pv-wall-group"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
