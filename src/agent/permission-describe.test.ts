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

  it("点名受保护的文件；没给回落 automations.json", () => {
    match(describeProtectedData(), /\(automations\.json\)/);
    const text = describeProtectedData(["/d/automations.json", "/d/automations-archive.json", "/e/automations.json"]);
    match(text, /\(automations\.json, automations-archive\.json\)/);
  });

  it("三行：开标签、一段说明、闭标签", () => {
    equal(describeProtectedData().split("\n").length, 3);
  });
});
