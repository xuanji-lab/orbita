import { match, doesNotMatch, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { describeProtectedData } from "./permission.ts";

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
