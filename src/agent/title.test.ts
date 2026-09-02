import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "./title.ts";

describe("normalizeGeneratedTitle", () => {
  it("取 <title> 标记里的内容", () => {
    strictEqual(normalizeGeneratedTitle("<title>修复登录按钮</title>"), "修复登录按钮");
    strictEqual(
      normalizeGeneratedTitle("好的，标题如下：<title>Fix login button</title>"),
      "Fix login button",
    );
  });

  it("无标记时剥残片取首行——半截回答不该整行当标题", () => {
    strictEqual(normalizeGeneratedTitle("<title>修复登录按钮"), "修复登录按钮");
    strictEqual(normalizeGeneratedTitle("</title> 修复登录"), "修复登录");
  });

  it("只取第一行", () => {
    strictEqual(normalizeGeneratedTitle("<title>修复登录按钮</title>\n<title>第二个</title>"), "修复登录按钮");
  });

  it("剥掉首尾引号与尾标点", () => {
    strictEqual(normalizeGeneratedTitle("<title>「修复登录按钮」。</title>"), "修复登录按钮");
    strictEqual(normalizeGeneratedTitle('<title>"Fix login."</title>'), "Fix login");
  });

  it("none 哨兵与空内容返回 null——保留首句截断，下条消息再试", () => {
    strictEqual(normalizeGeneratedTitle("<title>none</title>"), null);
    strictEqual(normalizeGeneratedTitle("<title>NONE</title>"), null);
    strictEqual(normalizeGeneratedTitle("<title></title>"), null);
    strictEqual(normalizeGeneratedTitle("<title/>"), null);
    strictEqual(normalizeGeneratedTitle(""), null);
    strictEqual(normalizeGeneratedTitle("   "), null);
  });

  it("超长拒绝而不是截断——那是模型在答用户的话", () => {
    strictEqual(normalizeGeneratedTitle(`<title>${"x".repeat(81)}</title>`), null);
    strictEqual(normalizeGeneratedTitle(`<title>${"x".repeat(80)}</title>`), "x".repeat(80));
  });

  it("思考文本里的标记照样能提取——标记协议对 thinking 泄漏免疫", () => {
    const withThinking = "<think>用户想要修复登录按钮，标题应该是……</think>\n<title>修复登录按钮</title>";
    strictEqual(normalizeGeneratedTitle(withThinking), "修复登录按钮");
  });

  it("中文标题不因为中文标点被误伤", () => {
    deepStrictEqual(normalizeGeneratedTitle("<title>重构 API 错误处理</title>"), "重构 API 错误处理");
  });

  it("prompt 要求标记协议与 none 哨兵", () => {
    strictEqual(TITLE_SYSTEM_PROMPT.includes("<title>none</title>"), true);
    strictEqual(TITLE_SYSTEM_PROMPT.includes("</title>"), true);
  });
});
