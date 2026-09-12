import { match, doesNotMatch } from "node:assert/strict";
import { describe, it } from "node:test";
import { describePermissionMode } from "./permission.ts";

describe("describePermissionMode", () => {
  it("plan：只读工具直接跑，写与 shell 明确说不可用", () => {
    const text = describePermissionMode("plan");
    match(text, /Runs immediately: find, glob, grep, ls, read\./);
    match(text, /Refused outright: bash, edit, write\./);
    // 这句是这次修的病灶：模型答应了才发现不能改
    match(text, /do not tell the user you will change anything on disk/);
    doesNotMatch(text, /Asks the user first/);
  });

  it("manual：八个全部要问，没有直接放行的", () => {
    const text = describePermissionMode("manual");
    match(text, /Asks the user first: bash, edit, find, glob, grep, ls, read, write\./);
    doesNotMatch(text, /Runs immediately/);
    doesNotMatch(text, /Refused outright/);
  });

  it("skip：八个全部直接跑", () => {
    const text = describePermissionMode("skip");
    match(text, /Runs immediately: bash, edit, find, glob, grep, ls, read, write\./);
    doesNotMatch(text, /Asks the user first/);
    doesNotMatch(text, /Refused outright/);
  });

  it("模式名进得去——模型要能说出自己在哪一档", () => {
    match(describePermissionMode("plan"), /tool permission to "plan"/);
  });

  // 1-2：MCP 工具进分桶——分桶由 decidePermission 算，提示词里不另立规则。
  // 顺序契约：内建在前，额外工具保持调用方传入顺序（注册表顺序），不排序
  it("MCP 工具名逃不过分桶：plan 拒、manual 问、skip 放，跟内建工具同一套算法", () => {
    const mcp = ["mcp__demo__echo", "mcp__demo__boom"];
    match(describePermissionMode("plan", mcp), /Refused outright: bash, edit, write, mcp__demo__echo, mcp__demo__boom\./);
    match(describePermissionMode("manual", mcp), /Asks the user first: .*mcp__demo__echo, mcp__demo__boom\./);
    match(describePermissionMode("skip", mcp), /Runs immediately: .*mcp__demo__echo, mcp__demo__boom\./);
  });

  it("没有额外工具时行为不变（空数组与不传等价）", () => {
    match(describePermissionMode("plan", []), /Refused outright: bash, edit, write\./);
  });
});
