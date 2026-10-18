/**
 * 工具选型段 + 非编程能力引导的契约（2026-10-18）。
 *
 * 两件事：
 *   1. 文案锚定——默认通道（grep / find / read 不走 bash）、bash 只跑真命令、
 *      「有能力而用户可能不知道时主动说一句」，字面漂了就失败；
 *   2. **进入拼装**——runtime.ts 顶层有副作用（没有 parentPort 就 exit），测试 import
 *      不了它，所以直接读源码，钉住这两段真的在 `before_agent_start` 的 systemPrompt
 *      数组里（只导出常量、没人拼进提示词等于没写）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROACTIVE_CAPABILITY_GUIDELINE, TOOL_SELECTION_GUIDELINE } from "./tool-selection-guideline.ts";

describe("工具选型段", () => {
  test("两类默认通道都在：搜内容用 grep、读文件用 read，且明确不要走 bash", () => {
    assert.match(TOOL_SELECTION_GUIDELINE, /grep tool to search file contents/);
    assert.match(TOOL_SELECTION_GUIDELINE, /read tool to read files/);
    assert.match(TOOL_SELECTION_GUIDELINE, /not grep\/rg via bash/);
  });

  test("找文件用 find、bash 只跑真命令（构建/测试/git/包管理）", () => {
    assert.match(TOOL_SELECTION_GUIDELINE, /find tool to\s+locate files/);
    assert.match(TOOL_SELECTION_GUIDELINE, /Reserve bash\/powershell for real commands/);
    assert.match(TOOL_SELECTION_GUIDELINE, /builds, tests, git, package managers/);
  });
});

describe("非编程能力引导", () => {
  test("有相关能力而用户可能不知道时主动说一句，不默默略过", () => {
    assert.match(PROACTIVE_CAPABILITY_GUIDELINE, /capability you have would help/);
    assert.match(PROACTIVE_CAPABILITY_GUIDELINE, /say so in one sentence/);
    assert.match(PROACTIVE_CAPABILITY_GUIDELINE, /staying silent/);
  });
});

describe("进入拼装", () => {
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

  test("两段都从模块 import 进 runtime", () => {
    assert.match(
      source,
      /import \{[^}]*TOOL_SELECTION_GUIDELINE[^}]*\} from "\.\/tool-selection-guideline\.ts"/,
    );
    assert.match(source, /PROACTIVE_CAPABILITY_GUIDELINE/);
  });

  test("两段都在 before_agent_start 的 systemPrompt 数组里（指出了常量却没拼进提示词）", () => {
    const start = source.indexOf("systemPrompt: [");
    const end = source.indexOf('.filter((part) => part !== "")', start);
    assert.ok(start >= 0 && end > start, "找不到 before_agent_start 的 systemPrompt 数组");
    const assembled = source.slice(start, end);
    assert.ok(assembled.includes("TOOL_SELECTION_GUIDELINE"), "工具选型段没进数组");
    assert.ok(assembled.includes("PROACTIVE_CAPABILITY_GUIDELINE"), "非编程能力引导没进数组");
  });
});
