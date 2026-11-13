import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { visibleTools, TOOL_CHIP_LIMIT, shortToolName } from "./mcp-tool-chips.ts";

const tools = (n: number): string[] => Array.from({ length: n }, (_, i) => `tool_${i}`);

describe("visibleTools", () => {
  test("不足 limit 个：全部显示，没有折叠", () => {
    const result = visibleTools(tools(3), 6, false);
    assert.deepEqual(result, { shown: tools(3), hidden: [] });
  });

  test("正好 limit 个：全部显示，边界不算超", () => {
    const result = visibleTools(tools(6), 6, false);
    assert.deepEqual(result, { shown: tools(6), hidden: [] });
  });

  test("超过 limit 个：前 limit 个显示，其余折进 hidden", () => {
    const result = visibleTools(tools(9), 6, false);
    assert.deepEqual(result.shown, tools(6));
    assert.deepEqual(result.hidden, ["tool_6", "tool_7", "tool_8"]);
  });

  test("展开后：即使超过 limit，全部显示，没有折叠", () => {
    const result = visibleTools(tools(9), 6, true);
    assert.deepEqual(result, { shown: tools(9), hidden: [] });
  });

  test("空列表：全部显示（空），没有折叠", () => {
    assert.deepEqual(visibleTools([], 6, false), { shown: [], hidden: [] });
  });

  test("默认限制常量与简报裁决一致", () => {
    assert.equal(TOOL_CHIP_LIMIT, 6);
  });
});

describe("shortToolName", () => {
  test("去掉 mcp__<服务>__ 前缀；对不上的原样给；前缀后没有名字的不吃成空串", () => {
    assert.equal(shortToolName("everything", "mcp__everything__echo"), "echo");
    assert.equal(shortToolName("plugin_lit_search", "mcp__plugin_lit_search__find"), "find");
    assert.equal(shortToolName("everything", "mcp__other__echo"), "mcp__other__echo");
    assert.equal(shortToolName("everything", "echo"), "echo");
    assert.equal(shortToolName("everything", "mcp__everything__"), "mcp__everything__");
  });
});
