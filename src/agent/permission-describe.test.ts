import { match, doesNotMatch, deepEqual as assertDeepEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { describePermissionMode, ENABLED_BUILTIN_TOOLS } from "./permission.ts";

describe("describePermissionMode", () => {
  it("plan：只读工具直接跑，写与 shell 明确说不可用", () => {
    const text = describePermissionMode("plan");
    // 只读的四个（find/grep/ls/read）——名单与 ENABLED_BUILTIN_TOOLS 同源。
    // 以前这里断言里有一个 pi 根本没有的 `glob`（错位，2026-10-04 修）
    match(text, /Runs immediately: find, grep, ls, read\./);
    match(text, /Refused outright: bash, edit, write\./);
    // 这句是这次修的病灶：模型答应了才发现不能改
    match(text, /do not tell the user you will change anything on disk/);
    doesNotMatch(text, /Asks the user first/);
  });

  it("manual：七个全部要问，没有直接放行的", () => {
    const text = describePermissionMode("manual");
    match(text, /Asks the user first: bash, edit, find, grep, ls, read, write\./);
    doesNotMatch(text, /Runs immediately/);
    doesNotMatch(text, /Refused outright/);
  });

  it("skip：七个全部直接跑", () => {
    const text = describePermissionMode("skip");
    match(text, /Runs immediately: bash, edit, find, grep, ls, read, write\./);
    doesNotMatch(text, /Asks the user first/);
    doesNotMatch(text, /Refused outright/);
  });

  /**
   * 提示词与真实工具集必须同源：以前这段文案里的 `glob` 是 pi 根本没有的工具，
   * 模型被告知有一个存在的工具而实际没有。这条钉住「文案里的每个名字都在
   * ENABLED_BUILTIN_TOOLS 里」。
   */
  it("文案里不出现 ENABLED_BUILTIN_TOOLS 之外的内建工具名", () => {
    const text = describePermissionMode("skip");
    const listed = text
      .split("Runs immediately: ")[1]
      ?.split(".")[0]
      ?.split(", ")
      .map((name) => name.trim());
    assertDeepEqual(listed, [...ENABLED_BUILTIN_TOOLS]);
    doesNotMatch(text, /\bglob\b/);
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

describe("describePermissionMode —— 电脑使用（computer use PR4）", () => {
  it("组注册了才讲：授权、破坏性确认、预算三件事都要让模型知道", () => {
    const text = describePermissionMode("skip", ["computer_screenshot", "computer_click"]);
    match(text, /session grant/i);
    match(text, /Destructive actions/i);
    match(text, /budget of 60 actions/i);
    match(text, /90 or 20 minutes/);
    // 撤权 / 拒绝之后不许重试——这句话是模型最需要的一句
    match(text, /do not retry/i);
  });

  it("组没注册（实验开关关着）时一句都不讲：不描述不存在的工具", () => {
    doesNotMatch(describePermissionMode("skip"), /session grant/i);
    doesNotMatch(describePermissionMode("skip", ["read_task"]), /budget of/i);
  });
});
