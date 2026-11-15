/**
 * 契约里的纯函数：版本解析 / 比较 / 支持判定。这些是「探测结论」的唯一真源，
 * 设置页与导出工具都读它——钉死它们，才不会出现「界面说够新、导出说太旧」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DOCX_EXPORT_MIN_PANDOC,
  comparePandocVersions,
  formatPandocVersion,
  isDocxTemplateMode,
  isPandocSupported,
  parsePandocVersion,
} from "./docx-export.ts";

describe("pandoc 版本", () => {
  test("解析 --version 第一行（pandoc / pandoc.exe，两段或三段号）", () => {
    assert.deepEqual(parsePandocVersion("pandoc 3.12.1\nFeatures: +server"), { major: 3, minor: 12, patch: 1 });
    assert.deepEqual(parsePandocVersion("pandoc.exe 3.9\nFeatures: +server"), { major: 3, minor: 9, patch: 0 });
    assert.deepEqual(parsePandocVersion("pandoc 3.10"), { major: 3, minor: 10, patch: 0 });
  });

  test("第一行没有版本号就回 null —— 不猜", () => {
    assert.equal(parsePandocVersion(""), null);
    assert.equal(parsePandocVersion("pandoc\n3.12.1"), null);
    assert.equal(parsePandocVersion("not pandoc at all"), null);
  });

  test("逐段比较（缺段按 0）", () => {
    const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
    assert.ok(comparePandocVersions(v(3, 9, 0), v(3, 10, 2)) < 0);
    assert.ok(comparePandocVersions(v(3, 12, 1), v(3, 10, 2)) > 0);
    assert.equal(comparePandocVersions(v(3, 10, 2), v(3, 10, 2)), 0);
    assert.equal(comparePandocVersions(v(4, 0, 0), v(3, 99, 99)), 1);
  });

  test("3.10.1 不支持、3.10.2 支持（\\tag 修复的那一版就是门槛）", () => {
    assert.equal(isPandocSupported({ major: 3, minor: 10, patch: 1 }), false);
    assert.equal(isPandocSupported({ major: 3, minor: 10, patch: 2 }), true);
    assert.equal(isPandocSupported({ major: 3, minor: 12, patch: 1 }), true);
    assert.equal(isPandocSupported(null), false);
    assert.equal(formatPandocVersion({ major: 3, minor: 10, patch: 2 }), DOCX_EXPORT_MIN_PANDOC);
  });
});

describe("模板模式", () => {
  test("只认三个值", () => {
    assert.equal(isDocxTemplateMode("default"), true);
    assert.equal(isDocxTemplateMode("project"), true);
    assert.equal(isDocxTemplateMode("custom"), true);
    assert.equal(isDocxTemplateMode("school"), false);
    assert.equal(isDocxTemplateMode(undefined), false);
  });
});
