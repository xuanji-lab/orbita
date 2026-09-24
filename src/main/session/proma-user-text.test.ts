import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "../../shared/session.ts";
import {
  decodePromaMentions,
  promaUserTextMap,
  promaUserTexts,
  stripPromaEnvelope,
  withUserTexts,
} from "./proma-user-text.ts";

/** Proma buildDynamicContext 的真实形状（agent-prompt-builder.ts），外加用户原文 */
const ENVELOPED = [
  "**当前时间: Thursday, September 24, 2026 at 09:32 PM GMT+8**",
  "<workspace_state>\n项目: 默认工作区\nMCP 服务器:\n- miyo (stdio, 已启用): /Users/me/.miyo/bin/miyo mcp\n</workspace_state>",
  "<working_directory>/Users/me/.proma-dev/agent-workspaces/default/workspace-files</working_directory>",
  "我认同。<quoted_context source=\"agent-history\">原因有两个</quoted_context>\n还有个原因",
].join("\n\n");

describe("stripPromaEnvelope", () => {
  test("剥掉开头的时间 / workspace_state / working_directory，留下原文（quoted_context 原样）", () => {
    assert.equal(stripPromaEnvelope(ENVELOPED), "我认同。<quoted_context source=\"agent-history\">原因有两个</quoted_context>\n还有个原因");
  });

  test("跨会话召回块、浏览器 / Vault 上下文也剥", () => {
    const text = "<跨会话历史召回 说明=\"…\">\n1. [07/25] 旧回答\n</跨会话历史召回>\n\n<user_browser_context>\n- URL: x\n</user_browser_context>\n\n问题";
    assert.equal(stripPromaEnvelope(text), "问题");
  });

  test("skill 展开块折回 /skill:名字，再接原文", () => {
    const text = "<skill name=\"meeting-capture\" location=\"/x/SKILL.md\">\n整份 SKILL.md\n</skill>\n\n**当前时间: Friday**\n\n整理今天的会";
    assert.equal(stripPromaEnvelope(text), "/skill:meeting-capture 整理今天的会");
    assert.equal(stripPromaEnvelope("<skill name=\"a\">x</skill>\n\n<skill name=\"b\">y</skill>\n\n"), "/skill:a /skill:b");
  });

  test("只剥开头：原文中间出现同名标签是用户自己写的，不动；没有信封原样返回", () => {
    const text = "看看这段：\n\n<working_directory>/x</working_directory>\n\n是什么";
    assert.equal(stripPromaEnvelope(text), text);
    assert.equal(stripPromaEnvelope("hi"), "hi");
  });
});

describe("decodePromaMentions", () => {
  test("@file:%2F… 解码成 @/…；坏编码原样保留", () => {
    assert.equal(
      decodePromaMentions("@file:%2FUsers%2Fme%2Fplan.html 这个计划"),
      "@/Users/me/plan.html 这个计划",
    );
    assert.equal(decodePromaMentions("@file:%E0%A4%A 坏的"), "@file:%E0%A4%A 坏的");
  });
});

describe("promaUserTexts", () => {
  test("只收主对话里有文本的用户行：工具结果行、子代理行、assistant 行都不算", () => {
    const log = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "第一句" }] }, parent_tool_use_id: null },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "答" }] }, parent_tool_use_id: null },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }, parent_tool_use_id: null },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "子代理里的" }] }, parent_tool_use_id: "toolu_1" },
      { type: "user", message: { role: "user", content: "第二句（字符串形态）" }, parent_tool_use_id: null },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    assert.deepEqual(promaUserTexts(log), ["第一句", "第二句（字符串形态）"]);
  });
});

function userEntry(id: string, content: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-24T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  } as SessionEntry;
}

describe("promaUserTextMap", () => {
  const entries = [userEntry("u1", [{ type: "text", text: ENVELOPED }]), userEntry("u2", "**当前时间: x**\n\n@file:%2Fa%2Fb.md 读一下")];

  test("界面日志条数对得上：按顺序取原文，并解码 @file", () => {
    const map = promaUserTextMap(entries, ["我认同。", "@file:%2Fa%2Fb.md 读一下"]);
    assert.equal(map.get("u1"), "我认同。");
    assert.equal(map.get("u2"), "@/a/b.md 读一下");
  });

  test("没有界面日志或条数对不上：逐条按格式剥", () => {
    for (const texts of [null, ["只有一条"]]) {
      const map = promaUserTextMap(entries, texts);
      assert.equal(map.get("u2"), "@/a/b.md 读一下");
      assert.match(map.get("u1") ?? "", /^我认同。/);
    }
  });
});

describe("withUserTexts", () => {
  test("第一个 text 块换成原文、其余 text 块去掉、图片留在原位；map 里没有的记录不动", () => {
    const records: SessionRecord[] = [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "拼过的前缀" },
          { type: "text", text: "第二段" },
        ],
        timestamp: 1,
      },
      { id: "u2", role: "user", content: [{ type: "text", text: "不在 map 里" }], timestamp: 2 },
    ];
    const out = withUserTexts(records, new Map([["u1", "原文"]]));
    assert.deepEqual(out[0], {
      id: "u1",
      role: "user",
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "原文" },
      ],
      timestamp: 1,
    });
    assert.equal(out[1], records[1]);
  });
});
