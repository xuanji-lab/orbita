import { match, doesNotMatch, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { describeProtectedData } from "./permission.ts";
import { computerUseBudgetGuideline } from "./computer-network.ts";

describe("describeProtectedData（系统提示的 orbita-permission 段）", () => {
  it("只讲受保护的数据：没有档位、没有放行 / 询问 / 拒绝的工具清单", () => {
    const text = describeProtectedData();
    match(text, /^<orbita-permission>\n/);
    match(text, /\n<\/orbita-permission>$/);
    match(text, /^Immutable: task session files/m);
    doesNotMatch(text, /tool permission to/);
    doesNotMatch(text, /Runs immediately|Asks the user first|Refused outright/);
    doesNotMatch(text, /in every mode/);
  });

  it("不虚构现内核没有的自动化记录保护；说明只有三行", () => {
    const text = describeProtectedData();
    doesNotMatch(text, /automations\.json/);
    equal(text.split("\n").length, 3);
  });
});

describe("computerUseBudgetGuideline（预算段）", () => {
  it("讲清两级预算与 20 分钟线，数字与闸门同源", () => {
    const text = computerUseBudgetGuideline();
    match(text, /^<orbita-computer-use-budget>\n/);
    match(text, /\n<\/orbita-computer-use-budget>$/);
    match(text, /budget .*60/);
    match(text, /90th call/);
    match(text, /20 minutes/);
    match(text, /do not retry/i);
  });
});
