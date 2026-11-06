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
