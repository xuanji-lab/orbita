import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { CompactedRecord, SessionRecord } from "@shared/session";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载（同 tool-results.ts 本身的纪律）
import { composeChannelPrompt } from "../../../../shared/channel.ts";
import {
  COMMAND_TIMEOUT_DEFAULT_SECONDS,
  COMMAND_TIMEOUT_FLOOR_SECONDS,
  COMMAND_TIMEOUT_HARD_MAX_SECONDS,
} from "../../../../shared/permission.ts";
import {
  answerText,
  branchAnchorEntries,
  branchAnchorIds,
  channelMarkLabel,
  delegateCard,
  handoffOutcome,
  editDiffEntries,
  editDiffStats,
  editDiffText,
  editGroupFileCount,
  fileViewFor,
  flattenRenderUnits,
  formatThinkingDuration,
  formatRunClock,
  expectedSecondsOf,
  groupToolUnits,
  rollupToolKey,
  indexToolResults,
  intraLineTokens,
  interruptedToolCallIds,
  liveTailLines,
  mergeBashNotices,
  parseBashNotices,
  parseDiffLines,
  parseEditDiff,
  parseGrepLine,
  readTaskCard,
  formatToolDuration,
  recordToolFrame,
  quietNoticeSeconds,
  SHELL_QUIET_NOTICE_MS,
  shellAutoExpand,
  tailPreviewLines,
  stripTrailingBlankLines,
  timeoutSecondsOf,
  toolStartAt,
  splitPathTail,
  streamingThinkingKey,
  mcpFailureKind,
  mcpInputSummary,
  mcpFailureLabel,
  mcpFailureLead,
  summarizeMcpResult,
  summarizeToolResult,
  summaryOfText,
  thinkingDurationText,
  thinkingPreview,
  toolCallSummary,
  toolDurationText,
  toolExpandable,
  toolGroupStatus,
  toolResultText,
  turnAssistantRecords,
  writeContent,
  writeLineCount,
  type RenderUnit,
} from "./tool-results.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

function toolItem(
  overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">,
): TranscriptItem {
  return {
    id: `item-${overrides.toolCallId}`,
    role: "tool",
    toolName: "bash",
    input: {},
    content: [],
    timestamp: 0,
    status: "complete",
    isError: false,
    ...overrides,
  } as TranscriptItem;
}

const userItem: TranscriptItem = {
  id: "u1",
  role: "user",
  content: [{ type: "text", text: "hi" }],
  timestamp: 0,
};

/** 块数组随便拼——摊平只认 block.type，字段按各块的真相写。 */
function assistantItem(id: string, blocks: unknown[]): TranscriptItem {
  return { id, role: "assistant", content: blocks, timestamp: 0 } as TranscriptItem;
}

function readCall(toolCallId: string, path: string): unknown {
  return { type: "toolCall", toolCallId, toolName: "read", input: { path } };
}

const compacted: CompactedRecord = {
  role: "compacted",
  id: "c1",
  summary: "摘要",
  tokensBefore: 1000,
  timestamp: 5,
};

/** 通道标记（子会话契约）：不是消息也不构成轮边界——渲染与锚点判定都穿过它 */
const channelMark = {
  role: "channel-mark",
  id: "k1",
  peerId: "c1",
  messageId: "m1",
  from: "child",
  kind: "question",
  timestamp: 6,
} as const;

describe("indexToolResults", () => {
  test("按 toolCallId 建索引", () => {
    const index = indexToolResults([userItem, toolItem({ toolCallId: "a" }), toolItem({ toolCallId: "b" })]);
    assert.equal(index.size, 2);
    assert.equal(index.get("a")?.toolCallId, "a");
    assert.equal(index.get("b")?.toolCallId, "b");
  });

  test("同一个 toolCallId 出现多次时以最后一条为准——终态帧在增量帧之后", () => {
    const index = indexToolResults([
      toolItem({ toolCallId: "a", status: "running", isError: false, content: [] }),
      toolItem({ toolCallId: "a", content: [{ type: "text", text: "final" }] }),
    ]);
    assert.equal(index.get("a")?.status, "complete");
    assert.deepEqual(index.get("a")?.content, [{ type: "text", text: "final" }]);
  });

  test("没有工具时是空索引，不是 undefined", () => {
    assert.equal(indexToolResults([userItem]).size, 0);
  });
});

describe("flattenRenderUnits", () => {
  test("assistant 按块拆，user 整条一个单元，tool item 不产生单元——它挂在调用行上", () => {
    const units = flattenRenderUnits([
      userItem,
      assistantItem("a1", [
        { type: "text", text: "看代码" },
        { type: "thinking", thinking: "先找入口" },
        readCall("r1", "a.ts"),
      ]),
      toolItem({ toolCallId: "r1", toolName: "read" }),
    ]);
    assert.deepEqual(
      units.map((unit) => unit.kind),
      ["user", "text", "thinking", "toolCall"],
    );
  });

  test("界碑自成单元；块的 key 是 item.id + 块下标", () => {
    const units = flattenRenderUnits([
      assistantItem("a1", [{ type: "text", text: "x" }, readCall("r1", "a.ts")]),
      compacted,
    ]);
    assert.deepEqual(
      units.map((unit) => unit.key),
      ["a1:0", "a1:1", "c1"],
    );
    assert.equal(units[2]?.kind, "compacted");
  });

  test("盘上读回的 channel-mark 记录产 channelMark 单元，key = record.id", () => {
    const units = flattenRenderUnits([channelMark]);
    assert.deepEqual(units, [
      {
        kind: "channelMark",
        key: "k1",
        mark: { peerId: "c1", messageId: "m1", from: "child", kind: "question" },
        timestamp: 6,
      },
    ]);
  });

  test("实时流里首个 text 块是信封的 user item 同样产 channelMark，不产 user 单元——两条路 key 相同", () => {
    const envelope = composeChannelPrompt(
      { id: "m1", from: "child", author: "model", kind: "question", text: "问一下", delivery: "followUp", createdAt: 6 },
      { id: "c1", title: "子会话" },
    );
    const liveItem: TranscriptItem = {
      id: "k1",
      role: "user",
      content: [{ type: "text", text: envelope }],
      timestamp: 6,
    };
    const units = flattenRenderUnits([liveItem]);
    assert.equal(units.length, 1);
    assert.equal(units[0]?.kind, "channelMark");
    // key 与盘上读回的 channel-mark 记录相同（都是这条 user item 的 id）——
    // 重载会话（从「实时信封」翻成「落盘标记」）前后 React key 不跳变
    assert.equal(units[0]?.key, "k1");
    assert.deepEqual(
      units[0]?.kind === "channelMark" ? units[0].mark : null,
      { peerId: "c1", messageId: "m1", from: "child", kind: "question" },
    );
  });

  test("普通 user 消息不受影响——首个 text 块解不出信封就照常产 user 单元", () => {
    const units = flattenRenderUnits([userItem]);
    assert.deepEqual(units, [{ kind: "user", key: "u1", item: userItem }]);
  });
});

describe("groupToolUnits", () => {
  test("跨消息相邻的同类 toolCall 合成一组——工具结果不产生单元，read→结果→read 天然相邻", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [readCall("r1", "a.ts")]),
        toolItem({ toolCallId: "r1", toolName: "read" }),
        assistantItem("a2", [readCall("r2", "b.ts")]),
        toolItem({ toolCallId: "r2", toolName: "read" }),
      ]),
    );
    assert.equal(entries.length, 1);
    const group = entries[0];
    assert.equal(group?.kind, "toolGroup");
    if (group?.kind !== "toolGroup") return;
    assert.equal(group.toolName, "read");
    assert.deepEqual(
      group.calls.map((call) => call.toolCallId),
      ["r1", "r2"],
    );
    assert.equal(group.key, "group:r1");
  });

  test("正文、思考、别的工具都断开 run——隔着东西合并等于撒谎", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [readCall("r1", "a.ts"), { type: "text", text: "中断" }, readCall("r2", "b.ts")]),
        assistantItem("a2", [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "ls" } }]),
      ]),
    );
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "toolGroup" ? `group:${entry.calls.length}` : entry.kind)),
      ["toolCall", "text", "toolCall", "toolCall"],
    );
  });

  test("单数不成组，原样放行", () => {
    const entries = groupToolUnits(flattenRenderUnits([assistantItem("a1", [readCall("r1", "a.ts")])]));
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["toolCall"],
    );
  });

  test("read SKILL.md 不参与合并——skill 使用是独立事件，并进组会把徽标吞掉", () => {
    const skills = [{ slug: "tdd", name: "TDD" }];
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [
          readCall("r1", "C:\\cfg\\skill-links\\global\\tdd\\SKILL.md"),
          readCall("r2", "a.ts"),
        ]),
      ]),
      skills,
    );
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "toolGroup" ? `group:${entry.calls.length}` : entry.kind)),
      ["toolCall", "toolCall"],
    );
  });

  test("skills 索引不认识时 SKILL.md 路径照常进组（默认参数无行为变化）", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [readCall("r1", "C:\\x\\tdd\\SKILL.md"), readCall("r2", "a.ts")]),
      ]),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "toolGroup");
  });

  test("skill read 在组员前后都不吞普通 read（前后各一个普通 read）", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [
          readCall("r0", "b.ts"),
          readCall("r1", "C:\\cfg\\tdd\\SKILL.md"),
          readCall("r2", "a.ts"),
        ]),
      ]),
      [{ slug: "tdd", name: "TDD" }],
    );
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "toolGroup" ? `group:${entry.calls.length}` : entry.kind)),
      ["toolCall", "toolCall", "toolCall"],
    );
  });
});

describe("rollupToolKey（折叠统计行的统计词汇）", () => {
  const skills = [{ slug: "tdd", name: "TDD" }];
  test("read SKILL.md 记作 skill、mcp__ 名记作 mcp（家族聚合）", () => {
    assert.equal(rollupToolKey("read", { path: "C:\\cfg\\tdd\\SKILL.md" }, skills), "skill");
    assert.equal(rollupToolKey("mcp__fixture__echo", {}, skills), "mcp");
  });
  test("普通工具与不认识的 SKILL.md 路径用原名", () => {
    assert.equal(rollupToolKey("bash", { command: "ls" }, skills), "bash");
    // 尾巴 <slug>/SKILL.md 命中就是 skill 使用，不看前面的路径（与 skillForReadPath 同判法）
    assert.equal(rollupToolKey("read", { path: "C:\\x\\tdd\\SKILL.md" }, skills), "skill");
    assert.equal(rollupToolKey("read", { path: "C:\\x\\nope\\SKILL.md" }, skills), "read");
    assert.equal(rollupToolKey("read", { path: "a.ts" }, []), "read");
  });

  test("正文永远独立成行，不进组——折叠只吞相邻 toolCall，正文没有折叠机制", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [
          { type: "thinking", thinking: "想想" },
          { type: "text", text: "先说两句" },
          readCall("r1", "a.ts"),
          readCall("r2", "b.ts"),
          { type: "text", text: "读完了" },
        ]),
      ]),
    );
    assert.deepEqual(
      entries.map((entry) =>
        entry.kind === "toolGroup" ? `group(${entry.calls.length})` : entry.kind,
      ),
      ["thinking", "text", "group(2)", "text"],
    );
    // 组里装的是且只是那两次调用
    const group = entries[2];
    assert.ok(group !== undefined && group.kind === "toolGroup");
    assert.deepEqual(
      group.kind === "toolGroup" ? group.calls.map((call) => call.toolCallId) : [],
      ["r1", "r2"],
    );
  });

  test("连续两次 reply_subsession 不成组——通道工具各自是独立一次通信，合并会显示成一条", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [
          { type: "toolCall", toolCallId: "s1", toolName: "reply_subsession", input: {} },
        ]),
        toolItem({ toolCallId: "s1", toolName: "reply_subsession" }),
        assistantItem("a2", [
          { type: "toolCall", toolCallId: "s2", toolName: "reply_subsession", input: {} },
        ]),
        toolItem({ toolCallId: "s2", toolName: "reply_subsession" }),
      ]),
    );
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["toolCall", "toolCall"],
    );
  });

  test("request_user_action 不成组——交接卡要一直露在外面，折进组里用户看不见", () => {
    const entries = groupToolUnits(
      flattenRenderUnits([
        assistantItem("a1", [{ type: "toolCall", toolCallId: "h1", toolName: "request_user_action", input: {} }]),
        toolItem({ toolCallId: "h1", toolName: "request_user_action" }),
        assistantItem("a2", [{ type: "toolCall", toolCallId: "h2", toolName: "request_user_action", input: {} }]),
      ]),
    );
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["toolCall", "toolCall"],
    );
  });
});

describe("handoffOutcome（交接卡的结局）", () => {
  const handoffItem = (details: unknown, status: "complete" | "running" = "complete"): ToolTranscriptItem =>
    ({
      id: "i1",
      role: "tool",
      toolCallId: "h1",
      toolName: "request_user_action",
      input: { reason: "Sign in to Scopus" },
      content: [{ type: "text", text: "…" }],
      timestamp: 1,
      status,
      isError: false,
      details,
    }) as ToolTranscriptItem;
  test("从 details.browser.handoff 取；缺席、坏值、还在等都是 null", () => {
    assert.equal(handoffOutcome(handoffItem({ browser: { tabId: "t", url: "", title: "", handoff: "done" } })), "done");
    assert.equal(handoffOutcome(handoffItem({ browser: { handoff: "cancelled" } })), "cancelled");
    assert.equal(handoffOutcome(handoffItem({ browser: { handoff: "maybe" } })), null);
    assert.equal(handoffOutcome(handoffItem({})), null);
    assert.equal(handoffOutcome(handoffItem({ browser: { handoff: "done" } }, "running")), null);
    assert.equal(handoffOutcome(undefined), null);
  });
});

describe("toolGroupStatus", () => {
  test("没有结果与 running 都算进行中，error 算失败，其余算完成", () => {
    const calls = flattenRenderUnits([
      assistantItem("a1", [readCall("r1", "a.ts"), readCall("r2", "b.ts"), readCall("r3", "c.ts")]),
    ]).filter((unit): unit is Extract<typeof unit, { kind: "toolCall" }> => unit.kind === "toolCall");
    const results = indexToolResults([
      toolItem({ toolCallId: "r2", toolName: "read", status: "error", isError: true }),
      toolItem({ toolCallId: "r3", toolName: "read" }),
    ]);
    assert.deepEqual(toolGroupStatus(calls, results), {
      total: 3,
      failed: 1,
      running: 1,
      interrupted: 0,
      done: 1,
    });
  });

  test("已中断的成员不占 running（组头不再为它呼吸），单另计入 interrupted", () => {
    const calls = flattenRenderUnits([
      assistantItem("a1", [readCall("r1", "a.ts"), readCall("r9", "x.ts")]),
    ]).filter((unit): unit is Extract<typeof unit, { kind: "toolCall" }> => unit.kind === "toolCall");
    const results = indexToolResults([toolItem({ toolCallId: "r1", toolName: "read" })]);
    const interrupted = interruptedToolCallIds(
      [said("a1", [readCall("r1", "a.ts"), readCall("r9", "x.ts")], "error")],
      results,
      false,
    );
    assert.deepEqual(toolGroupStatus(calls, results, interrupted), {
      total: 2,
      failed: 0,
      running: 0,
      interrupted: 1,
      done: 1,
    });
  });
});

describe("interruptedToolCallIds", () => {
  test("正常运行中：有 running 结果帧的调用不算中断——工具已启动，结果只是没到", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "complete")];
    const results = indexToolResults([
      toolItem({ toolCallId: "r1", toolName: "read", status: "running", isError: false, content: [] }),
    ]);
    assert.equal(interruptedToolCallIds(records, results, true).size, 0);
  });

  test("活跃轮末条的 complete 调用不算——那是「消息已完、工具即将启动」的正常窗口", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "complete")];
    assert.equal(interruptedToolCallIds(records, indexToolResults([]), true).size, 0);
  });

  test("消息以 error 收场且无结果 → 中断（参数没发完，调用从未执行）", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "error")];
    // 轮还活跃也算：error 是那条消息的终态，重试会另起 toolCallId，这个永远没有结果
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), true)], ["r1"]);
  });

  test("消息以 aborted 收场且无结果 → 中断", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "aborted")];
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), false)], ["r1"]);
  });

  test("有结果（含 error 结果）的一律不算——结果说了算", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "error")];
    const results = indexToolResults([
      toolItem({ toolCallId: "r1", toolName: "read", status: "error", isError: true }),
    ]);
    assert.equal(interruptedToolCallIds(records, results, false).size, 0);
  });

  test("后续已有消息（错误后的自动重试另起一条）→ 前一条的孤儿调用中断", () => {
    const records = [
      userItem,
      said("a1", [readCall("r1", "a.ts")], "complete"),
      said("a2", [readCall("r2", "b.ts")], "streaming"),
    ];
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), true)], ["r1"]);
  });

  test("同批工具的 tool 帧不是界碑：审批挂起时未 start 的同批调用不算中断（PR 审查意见）", () => {
    // pi 并行批次逐个 emit start → await prepareToolCall（审批闸门，等用户）→ 下一个：
    // r1 的 running 帧落下后 assistant 不再是转录末条，但 r2 还没 start、无帧——
    // 旧实现按「后面有任何新记录」判，审批卡挂多久 r2 就错多久
    const records = [
      userItem,
      said("a1", [readCall("r1", "a.ts"), readCall("r2", "b.ts")], "complete"),
      toolItem({ toolCallId: "r1", toolName: "read", status: "running", isError: false, content: [] }),
    ];
    assert.equal(interruptedToolCallIds(records, indexToolResults(records as TranscriptItem[]), true).size, 0);
  });

  test("变体：r1 已完成、r2 尚未 start——同样不算（末条只看 assistant / user）", () => {
    const records = [
      userItem,
      said("a1", [readCall("r1", "a.ts"), readCall("r2", "b.ts")], "complete"),
      toolItem({ toolCallId: "r1", toolName: "read", status: "running", isError: false, content: [] }),
      toolItem({ toolCallId: "r1", toolName: "read" }),
    ];
    assert.equal(interruptedToolCallIds(records, indexToolResults(records as TranscriptItem[]), true).size, 0);
  });

  test("后面的 user 记录是界碑（steer 注入 / 新轮）：批次该收账了，缺席即孤儿", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "complete"), { ...userItem, id: "u2" }];
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), true)], ["r1"]);
  });

  test("轮已结束（turnActive false，含重开的旧会话）：complete 无结果也是中断", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "complete")];
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), false)], ["r1"]);
  });

  test("流式中的消息不算——stopReason 尚未定，不能误杀正在长的调用", () => {
    const records = [userItem, said("a1", [readCall("r1", "a.ts")], "streaming")];
    assert.equal(interruptedToolCallIds(records, indexToolResults([]), true).size, 0);
  });

  test("非 assistant 记录与 thinking/text 块不干扰；多条孤儿都收", () => {
    const records: SessionRecord[] = [
      userItem,
      compacted,
      said("a1", [{ type: "text", text: "先说" }, readCall("r1", "a.ts")], "error"),
      channelMark,
      said("a2", [{ type: "thinking", thinking: "想" }, readCall("r2", "b.ts")], "aborted"),
    ];
    assert.deepEqual([...interruptedToolCallIds(records, indexToolResults([]), false)], ["r1", "r2"]);
  });
});

describe("thinkingPreview", () => {
  test("取最后一个非空行——流式时新的一行顶替上一行", () => {
    assert.equal(thinkingPreview("第一行\n第二行\n第三行"), "第三行");
    assert.equal(thinkingPreview("第一行\n第二行\n"), "第二行");
    assert.equal(thinkingPreview("唯一一行"), "唯一一行");
  });

  test("全空白返回空串，折叠行就不显示预览", () => {
    assert.equal(thinkingPreview(""), "");
    assert.equal(thinkingPreview(" \n  \n"), "");
  });
});

describe("streamingThinkingKey", () => {
  test("本轮进行中且末条 assistant 的最后一块是 thinking——呼吸", () => {
    const records = [
      userItem,
      assistantItem("a1", [{ type: "thinking", thinking: "正在想" }]),
    ];
    assert.equal(streamingThinkingKey(records, true), "a1:0");
  });

  test("思考不再是最后一块（模型转去出正文/调工具）——呼吸立即停", () => {
    const records = [
      assistantItem("a1", [
        { type: "thinking", thinking: "想完了" },
        { type: "text", text: "结论" },
      ]),
    ];
    assert.equal(streamingThinkingKey(records, true), null);
  });

  test("本轮未结束、末条不是 assistant（user/tool/界碑）——都不呼吸", () => {
    assert.equal(streamingThinkingKey([userItem], true), null);
    assert.equal(
      streamingThinkingKey([assistantItem("a1", [{ type: "thinking", thinking: "x" }]), compacted], true),
      null,
    );
    assert.equal(
      streamingThinkingKey([assistantItem("a1", [{ type: "thinking", thinking: "x" }])], false),
      null,
    );
  });
});

describe("summarizeToolResult", () => {
  test("还没有结果时不显示摘要", () => {
    assert.equal(summarizeToolResult(undefined, en), null);
  });

  test("状态优先用文字表达，不靠颜色", () => {
    const running = indexToolResults([
      toolItem({ toolCallId: "a", status: "running", isError: false }),
    ]).get("a");
    assert.equal(summarizeToolResult(running, en), "Running");

    const failed = indexToolResults([
      toolItem({ toolCallId: "a", status: "error", isError: true }),
    ]).get("a");
    assert.equal(summarizeToolResult(failed, en), "Failed");
  });

  test("多行数行数，单行数字符数", () => {
    const multi = indexToolResults([
      toolItem({ toolCallId: "a", content: [{ type: "text", text: "1\n2\n3" }] }),
    ]).get("a");
    assert.equal(summarizeToolResult(multi, en), "3 lines");

    const single = indexToolResults([
      toolItem({ toolCallId: "a", content: [{ type: "text", text: "hello" }] }),
    ]).get("a");
    assert.equal(summarizeToolResult(single, en), "5 chars");
  });

  test("空产出说无输出，而不是显示成 0 字符", () => {
    const empty = indexToolResults([toolItem({ toolCallId: "a", content: [] })]).get("a");
    assert.equal(summarizeToolResult(empty, en), "No output");
  });
});

describe("toolResultText", () => {
  test("多个文本块按行拼接", () => {
    const item = indexToolResults([
      toolItem({
        toolCallId: "a",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      }),
    ]).get("a");
    assert.equal(item === undefined ? "" : toolResultText(item, en), "line 1\nline 2");
  });

  test("answerText —— 复制按钮拷的正文：只取 text 块，thinking 与 toolCall 不进", () => {
    const record = assistantItem("a1", [
      { type: "text", text: "第一段。" },
      { type: "thinking", thinking: "先想想" },
      readCall("t1", "src/a.ts"),
      { type: "text", text: "第二段。" },
    ]);
    assert.equal(answerText([record]), "第一段。\n\n第二段。");
  });

  test("answerText —— 一轮多条记录（pi 每次 toolCall 切一条）：全部 text 块按序拼，不只拿末条", () => {
    const turn = [
      assistantItem("a1", [{ type: "text", text: "我接下来要跑命令。" }, readCall("t1", "x")]),
      assistantItem("a2", [{ type: "text", text: "跑完了，输出 hello。" }]),
    ];
    assert.equal(answerText(turn), "我接下来要跑命令。\n\n跑完了，输出 hello。");
  });

  test("answerText —— 非 assistant 跳过、空数组、空 content、空白 text 块都不占段", () => {
    assert.equal(answerText([userItem]), "");
    assert.equal(answerText([]), "");
    assert.equal(answerText([assistantItem("a2", [])]), "");
    assert.equal(
      answerText([assistantItem("a3", [{ type: "text", text: "  " }, { type: "text", text: "有字" }])]),
      "有字",
    );
  });

  test("turnAssistantRecords —— 锚点所在轮的全部 assistant 记录，user / 界碑是轮边界", () => {
    const records: SessionRecord[] = [
      userItem,
      assistantItem("a0", [{ type: "text", text: "上一轮" }]),
      { ...userItem, id: "u2" },
      assistantItem("a1", [{ type: "text", text: "这轮第一句" }, readCall("t1", "x")]),
      { id: "r1", role: "tool", toolCallId: "t1", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false } as TranscriptItem,
      assistantItem("a2", [{ type: "text", text: "这轮第二句" }]),
    ];
    assert.deepEqual(
      turnAssistantRecords(records, "a2").map((r) => r.id),
      ["a1", "a2"],
    );
    // 锚点在上一轮：只拿上一轮的
    assert.deepEqual(turnAssistantRecords(records, "a0").map((r) => r.id), ["a0"]);
    // 界碑也是边界
    assert.deepEqual(
      turnAssistantRecords([...records.slice(0, 2), compacted, ...records.slice(3)], "a2").map((r) => r.id),
      ["a1", "a2"],
    );
    // 锚点不存在：空
    assert.deepEqual(turnAssistantRecords(records, "nope"), []);
  });

  test("图片标记它存在，不丢掉也不假装能渲染", () => {
    const item = indexToolResults([
      toolItem({
        toolCallId: "a",
        content: [{ type: "image", data: "base64…", mimeType: "image/png" }],
      }),
    ]).get("a");
    assert.equal(item === undefined ? "" : toolResultText(item, en), "[image image/png]");
  });
});

describe("toolCallSummary", () => {
  test("bash 摘要取 command，路径类工具取 path", () => {
    assert.equal(toolCallSummary("bash", { command: "git status" }), "git status");
    assert.equal(
      toolCallSummary("powershell", { command: "Get-ChildItem" }),
      "Get-ChildItem",
      "powershell 是 pi 0.84.3 的独立工具（bash 的 PowerShell 壳）",
    );
    assert.equal(toolCallSummary("edit", { path: "src/app.ts", edits: [] }), "src/app.ts");
    assert.equal(toolCallSummary("write", { path: "notes.md", content: "…" }), "notes.md");
    assert.equal(toolCallSummary("read", { path: "a.ts", offset: 2 }), "a.ts");
  });

  test("搜索类取 pattern，带了具体目录才一起显示", () => {
    assert.equal(toolCallSummary("grep", { pattern: "TODO" }), "TODO");
    assert.equal(toolCallSummary("grep", { pattern: "TODO", path: "." }), "TODO");
    assert.equal(toolCallSummary("find", { pattern: "*.ts", path: "src" }), "*.ts in src");
  });

  test("ls 不带路径就是当前目录", () => {
    assert.equal(toolCallSummary("ls", {}), ".");
    assert.equal(toolCallSummary("ls", { path: "src" }), "src");
  });

  test("缺字段、非字符串、非对象、不认识的工具——一律 null，不编造", () => {
    assert.equal(toolCallSummary("bash", {}), null);
    assert.equal(toolCallSummary("bash", { command: 42 }), null);
    assert.equal(toolCallSummary("bash", "git status"), null);
    assert.equal(toolCallSummary("bash", null), null);
    assert.equal(toolCallSummary("mystery", { path: "x" }), null);
  });
});

describe("formatThinkingDuration", () => {
  test("不足 1 秒按 1 秒，秒数取整", () => {
    assert.equal(formatThinkingDuration(0, en), "1s");
    assert.equal(formatThinkingDuration(300, en), "1s");
    assert.equal(formatThinkingDuration(12_400, en), "12s");
  });

  test("满一分钟「1m 05s」，秒两位补零", () => {
    assert.equal(formatThinkingDuration(60_000, en), "1m 00s");
    assert.equal(formatThinkingDuration(61_000, en), "1m 01s");
    assert.equal(formatThinkingDuration(125_000, en), "2m 05s");
  });
});

describe("thinkingDurationText", () => {
  test("active 起表但不显示；落定冻结时长，之后不再变", () => {
    assert.equal(thinkingDurationText("k1", true, en, 1_000), null);
    assert.equal(thinkingDurationText("k1", false, en, 6_400), "5s");
    // 再过多久都还是落定那一刻的值
    assert.equal(thinkingDurationText("k1", false, en, 60_000), "5s");
  });

  test("没赶上开始的旧会话（没见过的 key 直接落定）——量不到，不显示", () => {
    assert.equal(thinkingDurationText("k-unknown", false, en, 5_000), null);
  });
});

describe("recordToolFrame / toolDurationText", () => {
  test("running 帧记起点、终态帧记终点；增量帧重复到达不覆盖", () => {
    assert.equal(toolDurationText("t1", en), null);
    recordToolFrame(toolItem({ toolCallId: "t1", status: "running", timestamp: 1_000 }));
    // 后到的 running 帧不改起点（adapter 的增量 item_updated 也是 running 态）
    recordToolFrame(toolItem({ toolCallId: "t1", status: "running", timestamp: 9_000 }));
    assert.equal(toolDurationText("t1", en), null, "进行中不显示");
    recordToolFrame(toolItem({ toolCallId: "t1", timestamp: 13_300 }));
    assert.equal(toolDurationText("t1", en), "12.3s");
    // 重复终态帧不改终点
    recordToolFrame(toolItem({ toolCallId: "t1", timestamp: 99_000 }));
    assert.equal(toolDurationText("t1", en), "12.3s");
  });

  test("旧会话只有终态帧（没见过 running）——量不到，返回 null", () => {
    recordToolFrame(toolItem({ toolCallId: "t2", timestamp: 5_000 }));
    assert.equal(toolDurationText("t2", en), null);
  });

  test("非 tool 记录不记（user/assistant 帧直接忽略）", () => {
    recordToolFrame(userItem);
    assert.equal(toolDurationText("item-undefined", en), null);
  });
});

describe("formatToolDuration", () => {
  test("不足一分钟带一位小数；满一分钟「1m 04s」且秒两位补零", () => {
    assert.equal(formatToolDuration(80, en), "0.1s");
    assert.equal(formatToolDuration(12_340, en), "12.3s");
    assert.equal(formatToolDuration(59_940, en), "59.9s");
    assert.equal(formatToolDuration(61_000, en), "1m 01s");
    assert.equal(formatToolDuration(125_000, en), "2m 05s");
  });
});

describe("parseDiffLines", () => {
  const DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-old2",
    "+new2",
    "+extra",
    " line3",
  ].join("\n");

  test("路径与增删统计来自文件头，diff --git 行不进 rows", () => {
    const parsed = parseDiffLines(DIFF);
    assert.equal(parsed.path, "src/app.ts");
    assert.equal(parsed.added, 2);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.rows[0]?.text, "@@ -1,3 +1,4 @@");
    assert.ok(parsed.rows.every((row) => !row.text.startsWith("diff --git")));
  });

  test("行号双计数器：ctx 双进、del 只有旧行号、add 只有新行号", () => {
    const rows = parseDiffLines(DIFF).rows.slice(1);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text]),
      [
        ["ctx", 1, 1, "line1"],
        ["del", 2, null, "old2"],
        ["add", null, 2, "new2"],
        ["add", null, 3, "extra"],
        ["ctx", 3, 4, "line3"],
      ],
    );
  });

  test("多个 hunk 各自从自己的 @@ 头起算", () => {
    const parsed = parseDiffLines("@@ -10 +10 @@\n ctx\n@@ -20,2 +20,2 @@\n a\n-b\n+c");
    const rows = parsed.rows;
    assert.equal(rows[0]?.text, "@@ -10 +10 @@");
    assert.deepEqual([rows[1]?.oldLine, rows[1]?.newLine], [10, 10]);
    assert.equal(rows[2]?.text, "@@ -20,2 +20,2 @@");
    assert.deepEqual([rows[3]?.oldLine, rows[3]?.newLine], [20, 20]);
    assert.deepEqual([rows[4]?.oldLine, rows[4]?.newLine], [21, null]);
    assert.deepEqual([rows[5]?.oldLine, rows[5]?.newLine], [null, 21]);
  });

  test("进了 hunk 的 --- x 是「删掉一行 -- x」，不是文件头", () => {
    const parsed = parseDiffLines("@@ -1,2 +1 @@\n ctx\n--- --flag");
    const last = parsed.rows[parsed.rows.length - 1];
    assert.deepEqual([last?.kind, last?.oldLine, last?.text], ["del", 2, "-- --flag"]);
  });

  test("\\ No newline 是标记不是行，不推进行号", () => {
    const parsed = parseDiffLines("@@ -1 +1 @@\n+tail\n\\ No newline at end of file");
    const last = parsed.rows[parsed.rows.length - 1];
    assert.equal(last?.kind, "meta");
    assert.equal(parsed.added, 1);
  });

  test("+++ 是 /dev/null（删光文件）时路径退回 --- 那边", () => {
    const parsed = parseDiffLines("--- a/gone.ts\n+++ /dev/null\n@@ -1 +0 @@\n-only");
    assert.equal(parsed.path, "gone.ts");
    assert.equal(parsed.removed, 1);
  });

  test("pi 的 details.patch 真身：createTwoFilesPatch 的文件头不带 a//b/ 前缀", () => {
    const parsed = parseDiffLines(
      ["--- src/app.ts", "+++ src/app.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"),
    );
    assert.equal(parsed.path, "src/app.ts");
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.added, 1);
  });
});

describe("editDiffText", () => {
  test("edit 且 details.diff 是非空字符串时取出来（pi 的显示格式）", () => {
    const item = indexToolResults([
      toolItem({
        toolCallId: "a",
        toolName: "edit",
        details: {
          diff: "-1 9876\n+1 hello",
          patch: "@@ -1 +1 @@\n-9876\n+hello",
          firstChangedLine: 1,
        },
      }),
    ]).get("a");
    assert.equal(item === undefined ? null : editDiffText(item), "-1 9876\n+1 hello");
  });

  test("details 里只有 patch、没有 diff——返回 null（展开退回原文展示）", () => {
    const item = indexToolResults([
      toolItem({ toolCallId: "d0", toolName: "edit", details: { patch: "@@ -1 +1 @@\n-a\n+b" } }),
    ]).get("d0");
    assert.equal(item === undefined ? null : editDiffText(item), null);
  });

  test("不是 edit、没有 details、diff 缺失或为空——都返回 null", () => {
    const bash = indexToolResults([toolItem({ toolCallId: "b" })]).get("b");
    assert.equal(bash === undefined ? null : editDiffText(bash), null);

    const noDetails = indexToolResults([
      toolItem({ toolCallId: "c", toolName: "edit" }),
    ]).get("c");
    assert.equal(noDetails === undefined ? null : editDiffText(noDetails), null);

    const emptyDiff = indexToolResults([
      toolItem({ toolCallId: "d", toolName: "edit", details: { diff: "" } }),
    ]).get("d");
    assert.equal(emptyDiff === undefined ? null : editDiffText(emptyDiff), null);
  });
});

describe("editDiffStats", () => {
  const patch = "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra";

  test("从 patch 解析增删统计", () => {
    const item = indexToolResults([
      toolItem({ toolCallId: "s1", toolName: "edit", details: { patch } }),
    ]).get("s1");
    assert.deepEqual(item === undefined ? null : editDiffStats(item), { added: 2, removed: 1 });
  });

  test("没有 patch 的（非 edit / details 缺失 / 只有 diff）——返回 null", () => {
    const bash = indexToolResults([toolItem({ toolCallId: "s2" })]).get("s2");
    assert.equal(bash === undefined ? null : editDiffStats(bash), null);

    const onlyDiff = indexToolResults([
      toolItem({ toolCallId: "s3", toolName: "edit", details: { diff: "-1 a\n+1 b" } }),
    ]).get("s3");
    assert.equal(onlyDiff === undefined ? null : editDiffStats(onlyDiff), null);
  });
});

describe("parseEditDiff", () => {
  // fixture 由 pi 0.84.3 的 generateDiffString 真实产出（2026-09-01 核对）
  test("单行修改：删带旧行号、增带新行号，没有头行", () => {
    const rows = parseEditDiff("-1 const oldValue = compute(x);\n+1 const newValue = compute(y);");
    assert.deepEqual(rows, [
      { kind: "del", lineNum: "1", text: "const oldValue = compute(x);" },
      { kind: "add", lineNum: "1", text: "const newValue = compute(y);" },
    ]);
  });

  test("长文件跳段：上下文 + 改动 + 「...」跳行", () => {
    const rows = parseEditDiff(
      [
        "  1 line 1",
        "  2 line 2",
        "  3 line 3",
        "- 4 line 4",
        "+ 4 LINE-FOUR",
        "  5 line 5",
        "  6 line 6",
        "  7 line 7",
        "  8 line 8",
        "    ...",
      ].join("\n"),
    );
    assert.equal(rows.length, 10);
    assert.deepEqual(
      rows.slice(0, 5).map((row) => [row.kind, row.lineNum]),
      [
        ["ctx", "1"],
        ["ctx", "2"],
        ["ctx", "3"],
        ["del", "4"],
        ["add", "4"],
      ],
    );
    const skip = rows[9];
    assert.ok(skip !== undefined && skip.kind === "ctx" && skip.text.includes("..."));
  });

  test("解析不了的行按 ctx 原样保留，不炸", () => {
    const rows = parseEditDiff("random junk\n+1 ok");
    assert.deepEqual(rows[0], { kind: "ctx", lineNum: "", text: "random junk" });
    assert.deepEqual(rows[1], { kind: "add", lineNum: "1", text: "ok" });
  });
});

describe("editDiffEntries", () => {
  test("相邻的 1 删 + 1 增 → 单行修改对，带词级 token", () => {
    const entries = editDiffEntries(
      parseEditDiff("-1 const oldValue = compute(x);\n+1 const newValue = compute(y);"),
    );
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry !== undefined && entry.kind === "pair");
    assert.equal(entry.tokens.removed.map((t) => t.text).join(""), "const oldValue = compute(x);");
    assert.equal(entry.tokens.added.map((t) => t.text).join(""), "const newValue = compute(y);");
    assert.ok(entry.tokens.removed.some((t) => t.changed));
  });

  test("多删多增不算单行修改，逐行渲染", () => {
    const entries = editDiffEntries(parseEditDiff("-1 a\n-2 b\n+1 A\n+2 B"));
    assert.equal(entries.length, 4);
    assert.ok(entries.every((e) => e.kind === "row"));
  });

  test("删与增之间隔着上下文 → 不配对", () => {
    const entries = editDiffEntries(parseEditDiff("-1 a\n 2 c\n+2 A"));
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => e.kind === "row"));
  });
});

describe("intraLineTokens", () => {
  test("拼接保真；完全相同的行全 unchanged", () => {
    const same = intraLineTokens("const a = 1;", "const a = 1;");
    assert.ok(same.removed.length > 0 && same.removed.every((t) => !t.changed));

    const tokens = intraLineTokens("const oldValue = compute(x);", "const newValue = compute(y);");
    assert.equal(tokens.removed.map((t) => t.text).join(""), "const oldValue = compute(x);");
    assert.equal(tokens.added.map((t) => t.text).join(""), "const newValue = compute(y);");
  });

  test("行首空白不算改动——缩进不被高亮（pi 同款规则）", () => {
    const tokens = intraLineTokens("  if (old) {", "  if (new) {");
    assert.ok(tokens.removed.some((t) => t.changed));
    for (const token of [...tokens.removed, ...tokens.added]) {
      if (token.changed) {
        assert.ok(!/^\s/.test(token.text), `changed token 不应带行首空白: ${JSON.stringify(token.text)}`);
      }
    }
  });
});

describe("editGroupFileCount", () => {
  function editCall(toolCallId: string, path: string | null): unknown {
    return {
      type: "toolCall",
      toolCallId,
      toolName: "edit",
      input: path === null ? {} : { path },
    };
  }

  function callUnits(records: readonly TranscriptItem[]) {
    return flattenRenderUnits(records).filter(
      (unit): unit is Extract<RenderUnit, { kind: "toolCall" }> => unit.kind === "toolCall",
    );
  }

  test("按 path 去重：同一文件两处编辑算一个文件", () => {
    const records: readonly TranscriptItem[] = [
      assistantItem("a1", [editCall("e1", "src/app.ts"), editCall("e2", "src/app.ts"), editCall("e3", "src/util.ts")]),
      toolItem({ toolCallId: "e1", toolName: "edit", details: { patch: "@@ -1 +1 @@\n-a\n+b" } }),
      toolItem({ toolCallId: "e2", toolName: "edit", details: { patch: "@@ -2 +2 @@\n-b\n+c" } }),
      toolItem({ toolCallId: "e3", toolName: "edit", details: { patch: "@@ -1 +1 @@\n-x\n+y" } }),
    ];
    assert.equal(editGroupFileCount(callUnits(records), indexToolResults(records)), 2);
  });

  test("失败与进行中的成员不计入（改成才算改）；一个都没有时返回 null", () => {
    const none: readonly TranscriptItem[] = [
      assistantItem("a1", [editCall("f1", "a.ts"), editCall("f2", "b.ts")]),
      toolItem({ toolCallId: "f1", toolName: "edit", status: "error" }),
      toolItem({ toolCallId: "f2", toolName: "edit", status: "running" }),
    ];
    assert.equal(editGroupFileCount(callUnits(none), indexToolResults(none)), null);

    const one: readonly TranscriptItem[] = [
      assistantItem("a1", [editCall("f3", "b.ts")]),
      toolItem({ toolCallId: "f3", toolName: "edit", details: { patch: "@@ -1 +1 @@\n-x\n+y" } }),
    ];
    assert.equal(editGroupFileCount(callUnits(one), indexToolResults(one)), 1);
  });

  test("input 里没有 path 的落定成员跳过，不炸", () => {
    const records: readonly TranscriptItem[] = [
      assistantItem("a1", [editCall("g1", null)]),
      toolItem({ toolCallId: "g1", toolName: "edit" }),
    ];
    assert.equal(editGroupFileCount(callUnits(records), indexToolResults(records)), null);
  });
});

describe("writeContent / writeLineCount", () => {
  test("正文在入参 content 里（pi 的 write 结果只有一行统计）", () => {
    assert.equal(writeContent({ path: "a.ts", content: "const a = 1;\n" }), "const a = 1;\n");
  });

  test("缺字段、非字符串、空串返回 null", () => {
    assert.equal(writeContent({ path: "a.ts" }), null);
    assert.equal(writeContent({ path: "a.ts", content: 42 }), null);
    assert.equal(writeContent({ path: "a.ts", content: "" }), null);
    assert.equal(writeContent(null), null);
  });

  test("行数去尾部空行（pi 的 trimTrailingEmptyLines）", () => {
    assert.equal(writeLineCount({ content: "a\nb\n" }), 2);
    assert.equal(writeLineCount({ content: "a\nb\n\n\n" }), 2);
    assert.equal(writeLineCount({ content: "single" }), 1);
  });

  test("没有正文返回 null", () => {
    assert.equal(writeLineCount({}), null);
    assert.equal(writeLineCount({ content: "" }), null);
  });
});

describe("fileViewFor", () => {
  /** indexToolResults 的 get 天然把类型收窄到 ToolTranscriptItem（editDiffText 用例同款） */
  const result = (overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">) =>
    indexToolResults([toolItem(overrides)]).get(overrides.toolCallId);
  const ok = result({
    toolCallId: "w1",
    toolName: "write",
    content: [{ type: "text", text: "Successfully wrote 12 bytes to a.ts" }],
  });

  test("write 成功：视图用入参正文，起始行 1", () => {
    assert.equal(ok === undefined ? null : fileViewFor("write", { path: "a.ts", content: "const a = 1;" }, ok)?.text, "const a = 1;");
  });

  test("write 失败：不显示正文（展开退回错误文本）", () => {
    const failed = result({
      toolCallId: "w2",
      toolName: "write",
      status: "error",
      content: [{ type: "text", text: "EACCES" }],
    });
    assert.equal(failed === undefined ? null : fileViewFor("write", { path: "a.ts", content: "x" }, failed), null);
  });

  test("write 入参没有正文：null（空文件/坏调用退回原文展示）", () => {
    assert.equal(ok === undefined ? null : fileViewFor("write", { path: "a.ts" }, ok), null);
  });

  test("其它工具不适用（bash 读写两者皆非）", () => {
    const bash = result({
      toolCallId: "b1",
      toolName: "bash",
      content: [{ type: "text", text: "out" }],
    });
    assert.equal(bash === undefined ? null : fileViewFor("bash", { command: "ls" }, bash), null);
  });
});

describe("fileViewFor · read 分支", () => {
  const result = (overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">) =>
    indexToolResults([toolItem(overrides)]).get(overrides.toolCallId);
  const read = (content: { type: "text"; text: string }[]) =>
    result({ toolCallId: "r1", toolName: "read", content });

  test("read 成功：视图用读到的原文，起始行 1", () => {
    const item = read([{ type: "text", text: "line1\nline2" }]);
    assert.deepEqual(item === undefined ? null : fileViewFor("read", { path: "a.ts" }, item), {
      text: "line1\nline2",
      startLine: 1,
    });
  });

  test("带 offset 读中段：行号从 offset 起（pi 的 offset 是 1-indexed）", () => {
    const item = read([{ type: "text", text: "mid1\nmid2" }]);
    assert.equal(
      item === undefined ? null : fileViewFor("read", { path: "a.ts", offset: 41 }, item)?.startLine,
      41,
    );
  });

  test("offset 非法（0、负数、非整数、非数字）退回 1", () => {
    for (const offset of [0, -3, 2.5, "x"]) {
      const item = read([{ type: "text", text: "a" }]);
      assert.equal(
        item === undefined ? null : fileViewFor("read", { path: "a.ts", offset }, item)?.startLine,
        1,
        `offset=${String(offset)} 应退回 1`,
      );
    }
  });

  test("图片读取不进文件视图；空结果也是 null", () => {
    const image = result({
      toolCallId: "r2",
      toolName: "read",
      content: [
        { type: "text", text: "Read image file [image/png]..." },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
    });
    assert.equal(image === undefined ? null : fileViewFor("read", { path: "a.png" }, image), null);

    const empty = result({ toolCallId: "r3", toolName: "read", content: [] });
    assert.equal(empty === undefined ? null : fileViewFor("read", { path: "a.ts" }, empty), null);
  });

  test("read 失败：null（展开退回错误文本）", () => {
    const failed = result({
      toolCallId: "r4",
      toolName: "read",
      status: "error",
      content: [{ type: "text", text: "ENOENT" }],
    });
    assert.equal(failed === undefined ? null : fileViewFor("read", { path: "a.ts" }, failed), null);
  });
});

describe("parseGrepLine", () => {
  test("匹配行 `path:N: 正文`", () => {
    assert.deepEqual(parseGrepLine("src/app.ts:42: const x = 1;"), {
      kind: "match",
      path: "src/app.ts",
      lineNum: "42",
      text: "const x = 1;",
    });
  });

  test("上下文行 `path-N- 正文`", () => {
    assert.deepEqual(parseGrepLine("src/app.ts-41- // 前一行"), {
      kind: "context",
      path: "src/app.ts",
      lineNum: "41",
      text: "// 前一行",
    });
  });

  test("带空格与反斜杠的路径也认（惰性前缀在第一个行号定界符处断开）", () => {
    const spaced = parseGrepLine("reference project/x.ts:7: hi");
    assert.ok(spaced !== null);
    assert.equal(spaced.path, "reference project/x.ts");
    const win = parseGrepLine("src\\app.ts:7: hi");
    assert.ok(win !== null);
    assert.equal(win.path, "src\\app.ts");
  });

  test("正文里再出现冒号数字不干扰（惰性匹配取第一个定界符）", () => {
    const hit = parseGrepLine("a.ts:1: foo:2: bar");
    assert.ok(hit !== null);
    assert.equal(hit.text, "foo:2: bar");
  });

  test("尾注、No matches found、空行——不解析，返回 null", () => {
    assert.equal(parseGrepLine("[Truncated: 100 matches limit, 50KB limit]"), null);
    assert.equal(parseGrepLine("No matches found"), null);
    assert.equal(parseGrepLine(""), null);
  });
});

describe("splitPathTail", () => {
  test("目录前缀与文件名分离（正反斜杠都认）", () => {
    assert.deepEqual(splitPathTail("src/renderer/src/App.tsx"), {
      dir: "src/renderer/src/",
      name: "App.tsx",
    });
    assert.deepEqual(splitPathTail("src\\renderer\\App.tsx"), {
      dir: "src\\renderer\\",
      name: "App.tsx",
    });
  });

  test("无分隔符的裸名（ls 条目）整个是文件名", () => {
    assert.deepEqual(splitPathTail("package.json"), { dir: "", name: "package.json" });
  });

  test("ls 目录条目的尾分隔符不拆出空名", () => {
    assert.deepEqual(splitPathTail("docs/"), { dir: "", name: "docs/" });
  });
});

describe("toolExpandable", () => {
  test("没有结果帧不可展开", () => {
    assert.equal(toolExpandable(undefined, "bash"), false);
  });

  test("跑完与失败都可展开", () => {
    const done = indexToolResults([toolItem({ toolCallId: "a", status: "complete" })]).get("a");
    assert.equal(toolExpandable(done, "read"), true);

    const failed = indexToolResults([
      toolItem({ toolCallId: "a", status: "error", isError: true }),
    ]).get("a");
    assert.equal(toolExpandable(failed, "bash"), true);
  });

  test("跑着的只有 shell 可展开——其余工具开了只是空盒子", () => {
    const running = (toolName: string): ToolTranscriptItem => {
      const item = indexToolResults([
        toolItem({ toolCallId: "a", toolName, status: "running", content: [] }),
      ]).get("a");
      if (item === undefined) throw new Error("unreachable");
      return item;
    };
    assert.equal(toolExpandable(running("bash"), "bash"), true);
    assert.equal(toolExpandable(running("powershell"), "powershell"), true);
    assert.equal(toolExpandable(running("read"), "read"), false);
    assert.equal(toolExpandable(running("grep"), "grep"), false);
  });
});

describe("liveTailLines", () => {
  test("不超过上限原样返回", () => {
    assert.equal(liveTailLines("1\n2\n3"), "1\n2\n3");
    assert.equal(liveTailLines(""), "");
  });

  test("超过上限只留尾部（默认 200 行封顶）", () => {
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i}`);
    assert.equal(liveTailLines(lines.join("\n")), lines.slice(5).join("\n"));
  });

  test("上限可调", () => {
    assert.equal(liveTailLines("1\n2\n3\n4", 2), "3\n4");
  });
});

// ── C-2：分支锚点 ──

/** 终态 assistant 记录（分支判定要读 status，公共工厂不带它） */
function said(id: string, blocks: unknown[], status = "complete"): TranscriptItem {
  return { id, role: "assistant", content: blocks, timestamp: 0, status } as TranscriptItem;
}

describe("branchAnchorIds", () => {
  test("每轮的最终输出是锚点；轮中中间回答被后面的顶替", () => {
    const records = [
      userItem,
      said("a1", [{ type: "text", text: "先看看" }, readCall("r1", "a.ts")]),
      toolItem({ toolCallId: "r1", toolName: "read" }),
      said("a2", [{ type: "text", text: "再看一个" }, readCall("r2", "b.ts")]),
      toolItem({ toolCallId: "r2", toolName: "read" }),
      said("a3", [{ type: "text", text: "结论" }]),
      { ...userItem, id: "u2" },
      said("a4", [{ type: "text", text: "第二轮回答" }]),
    ];
    const anchors = branchAnchorIds(records, indexToolResults(records as TranscriptItem[]));
    // a1 / a2 是轮中回答（后面还有 a3），a3 是第一轮末尾，a4 是第二轮末尾
    assert.deepEqual([...anchors], ["a3", "a4"]);
  });

  test("轮以界碑或转录末尾收尾同样确认锚点", () => {
    const withBoundary = [userItem, said("a1", [{ type: "text", text: "答" }]), compacted];
    assert.deepEqual(
      [...branchAnchorIds(withBoundary, indexToolResults([]))],
      ["a1"],
    );
  });

  test("通道标记是轮边界（子会话 2026-09-23 不变量修正）：像 user 一样确认候选并开新段", () => {
    // 标记落在末尾：末尾确认照旧（与界碑收尾同一结果）
    const withMark = [userItem, said("a1", [{ type: "text", text: "答" }]), channelMark];
    assert.deepEqual([...branchAnchorIds(withMark, indexToolResults([]))], ["a1"]);
    // 标记落在两答之间：它是轮边界，把前一个回答确认成它那一段的锚点，
    // 后一个回答另起一段——两个都锚，不再是「后者顶替前者」（旧语义已废弃）
    const midMark = [
      userItem,
      said("a1", [{ type: "text", text: "先说" }]),
      channelMark,
      said("a2", [{ type: "text", text: "结论" }]),
    ];
    assert.deepEqual([...branchAnchorIds(midMark, indexToolResults([]))], ["a1", "a2"]);
  });

  test("流式中的消息不是锚点；纯工具轮（无正文）没有锚点", () => {
    const records = [
      userItem,
      said("a1", [{ type: "text", text: "半截" }], "streaming"),
      { ...userItem, id: "u2" },
      said("a2", [readCall("r1", "a.ts")]),
      toolItem({ toolCallId: "r1", toolName: "read" }),
    ];
    assert.equal(branchAnchorIds(records, indexToolResults(records as TranscriptItem[])).size, 0);
  });

  test("turnActive：末尾候选不确认——工具刚落定、下条回答未生的窗口里不出复制/分支行", () => {
    // 场景即 2026-09-28 用户报告：assistant（带 toolCall）已终态、工具结果已落定、
    // 下一条回答还没开始生成，转录到这里结束——末尾确认会把半轮钉成锚点
    const records = [
      userItem,
      said("a1", [{ type: "text", text: "第一轮答" }]),
      { ...userItem, id: "u2" }, // 轮边界：a1 在这里被确认（历史锚点）
      said("a2", [{ type: "text", text: "先看看" }, readCall("r2", "b.ts")]),
      toolItem({ toolCallId: "r2", toolName: "read" }),
    ];
    // 轮活跃：末尾的 a2 不确认，边界确认的 a1 照旧是锚点
    assert.deepEqual(
      [...branchAnchorIds(records, indexToolResults(records as TranscriptItem[]), true)],
      ["a1"],
    );
    // 轮落定（phase 回 idle）：末尾确认照旧，a2 也成锚点
    assert.deepEqual(
      [...branchAnchorIds(records, indexToolResults(records as TranscriptItem[]), false)],
      ["a1", "a2"],
    );
    // 活跃轮里已经出现流式中的下一条回答：它本身不是锚点，末尾确认跳过也不复活前面
    const withStreaming = [
      userItem,
      said("a1", [{ type: "text", text: "先看看" }, readCall("r1", "a.ts")]),
      toolItem({ toolCallId: "r1", toolName: "read" }),
      said("a2", [{ type: "text", text: "生成中" }], "streaming"),
    ];
    assert.equal(branchAnchorIds(withStreaming, indexToolResults(withStreaming as TranscriptItem[]), true).size, 0);
  });

  test("工具没落定（跑着 / 没有结果帧）不锚——有调用没结果的上下文切出去是畸形的", () => {
    const records = [
      userItem,
      said("a1", [{ type: "text", text: "跑着" }, readCall("r1", "a.ts")]),
      toolItem({ toolCallId: "r1", toolName: "read", status: "running" }),
    ];
    assert.equal(branchAnchorIds(records, indexToolResults(records as TranscriptItem[])).size, 0);

    // 连结果帧都没有（abort 掐在执行前）同样不锚
    const noResult = [userItem, said("a1", [{ type: "text", text: "调了没回" }, readCall("r9", "x.ts")])];
    assert.equal(branchAnchorIds(noResult, indexToolResults([])).size, 0);
  });

  test("被打断但带正文、且工具都有完结记录的回答可锚", () => {
    const records = [
      userItem,
      said("a1", [{ type: "text", text: "说到一半" }], "aborted"),
    ];
    assert.deepEqual([...branchAnchorIds(records, indexToolResults([]))], ["a1"]);
  });

  test("正文是纯空白不算「最终输出」", () => {
    const records = [userItem, said("a1", [{ type: "text", text: "   " }])];
    assert.equal(branchAnchorIds(records, indexToolResults([])).size, 0);
  });
});

describe("branchAnchorEntries", () => {
  test("锚点消息最后一个单元所在的 entry：独立单元与跨消息分组都归末成员", () => {
    const records = [
      userItem,
      said("a1", [readCall("r1", "a.ts")]),
      toolItem({ toolCallId: "r1", toolName: "read" }),
      // a2 与 a1 跨消息相邻同类——合成一个组，末成员是 a2
      said("a2", [readCall("r2", "b.ts")]),
      toolItem({ toolCallId: "r2", toolName: "read" }),
      said("a3", [{ type: "text", text: "结论" }]),
    ];
    const entries = groupToolUnits(flattenRenderUnits(records));
    const anchors = new Set(["a2", "a3"]);
    const rows = branchAnchorEntries(anchors, entries);
    // entries = [user, group(r1,r2), text(a3)]；a2 的最后单元在组里 → 组后；a3 → 自己后面
    assert.deepEqual([...rows.entries()].sort((x, y) => x[0] - y[0]), [
      [1, "a2"],
      [2, "a3"],
    ]);
  });

  test("同一条锚点消息占多个 entry 时取最后一个", () => {
    const records = [
      userItem,
      said("a1", [
        { type: "thinking", thinking: "想想" },
        { type: "text", text: "结论" },
      ]),
    ];
    const entries = groupToolUnits(flattenRenderUnits(records));
    const rows = branchAnchorEntries(new Set(["a1"]), entries);
    assert.deepEqual([...rows.entries()], [[2, "a1"]]);
  });
});

// ── 4-5：MCP 工具卡的摘要与失败分型 ──

/** 4-5 用：MCP 工具记录（复用上面的 toolItem，只换名与终态） */
const mcpItem = (
  status: "complete" | "error",
  content: ToolTranscriptItem["content"],
  toolCallId = "c1",
): ToolTranscriptItem =>
  status === "error"
    ? {
        id: `item-${toolCallId}`,
        role: "tool",
        toolCallId,
        toolName: "mcp__demo__echo",
        input: {},
        content,
        timestamp: 0,
        status: "error",
        isError: true,
      }
    : {
        id: `item-${toolCallId}`,
        role: "tool",
        toolCallId,
        toolName: "mcp__demo__echo",
        input: {},
        content,
        timestamp: 0,
        status: "complete",
        isError: false,
      };

describe("summarizeMcpResult / mcpFailureKind（4-5）", () => {
  test("成功：纯文本说 chars，含图说 images · chars（规格原文量词）", () => {
    assert.equal(summarizeMcpResult(mcpItem("complete", [{ type: "text", text: "echo: hello" }]), en), "11 chars");
    assert.equal(
      summarizeMcpResult(
        mcpItem("complete", [
          { type: "text", text: "echo: hi" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ]), en,
      ),
      "1 image · 8 chars",
    );
  });

  test("业务失败 = Failed（server 的话在正文里）", () => {
    const failed = mcpItem("error", [{ type: "text", text: "炸了" }]);
    assert.equal(summarizeMcpResult(failed, en), "Failed");
    assert.equal(mcpFailureKind(failed), "business");
    assert.equal(mcpFailureLead(failed, en), "The server reported an error.");
  });

  test("超时与不可达分得开：Timed out / Unreachable，各自的展开首行", () => {
    const timedOut = mcpItem("error", [{ type: "text", text: "mcp__demo__echo 调用超时" }]);
    assert.equal(mcpFailureKind(timedOut), "timedOut");
    assert.equal(mcpFailureLabel(timedOut, en), "Timed out");
    assert.match(mcpFailureLead(timedOut, en), /Timed out/);
    const gone = mcpItem("error", [
      { type: "text", text: 'mcp__demo__echo: server "demo" is not connected (it may have been removed by a reload)' },
    ]);
    assert.equal(mcpFailureKind(gone), "unreachable");
    assert.equal(mcpFailureLabel(gone, en), "Unreachable");
    assert.match(mcpFailureLead(gone, en), /no response from the server/i);
  });
});

describe("mcpInputSummary（4-5）", () => {
  test("对象收成一行并截断；空对象与 null 不出摘要", () => {
    assert.equal(mcpInputSummary({ text: "卡片验证" }), '{"text":"卡片验证"}');
    assert.equal(mcpInputSummary({ text: "x".repeat(60) })?.endsWith("…"), true);
    assert.equal(mcpInputSummary({}), null);
    assert.equal(mcpInputSummary(null), null);
  });
});

describe("readTaskCard（B-1）", () => {
  // 协议把 status 与 isError 绑成变体，patch 只收 complete 变体的字段；running 走第二参
  const toolItem = (
    patch: Partial<Extract<ToolTranscriptItem, { status: "complete" }>> = {},
    status: "complete" | "running" = "complete",
  ): ToolTranscriptItem => ({
    id: "i1",
    role: "tool",
    toolCallId: "c1",
    toolName: "read_task",
    input: { task: "demo" },
    content: [{ type: "text", text: "Task \"Demo\"…" }],
    timestamp: 1,
    status,
    isError: false,
    ...patch,
  });

  test("终态帧的 details.readTask 逐字段校验后原样带回", () => {
    const card = readTaskCard(
      toolItem({ details: { readTask: { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 4 } } }),
    );
    assert.deepEqual(card, { sessionId: "t-1", title: "Demo", mode: "briefing", roundCount: 4 });
  });

  test("rounds 模式带 rounds 回显；空标题给占位", () => {
    const card = readTaskCard(
      toolItem({ details: { readTask: { sessionId: "t-1", title: "", mode: "rounds", rounds: "2-5", roundCount: 6 } } }),
    );
    assert.deepEqual(card, {
      sessionId: "t-1",
      title: "(untitled)",
      mode: "rounds",
      rounds: "2-5",
      roundCount: 6,
    });
  });

  test("坏值判 null：running 帧、缺 details、缺字段、坏 mode、空 sessionId 都不给卡", () => {
    assert.equal(readTaskCard(undefined), null);
    assert.equal(readTaskCard(toolItem({}, "running")), null);
    assert.equal(readTaskCard(toolItem({ details: undefined })), null);
    assert.equal(readTaskCard(toolItem({ details: { other: 1 } })), null);
    assert.equal(readTaskCard(toolItem({ details: { readTask: { title: "x", mode: "briefing", roundCount: 1 } } })), null);
    assert.equal(readTaskCard(toolItem({ details: { readTask: { sessionId: "t", title: "x", mode: "weird", roundCount: 1 } } })), null);
    assert.equal(readTaskCard(toolItem({ details: { readTask: { sessionId: "t", title: "x", mode: "briefing", roundCount: "many" } } })), null);
  });
});

describe("toolCallSummary —— read_task（B-1）", () => {
  test("行首参数摘要显示引用本身", () => {
    assert.equal(toolCallSummary("read_task", { task: "fix sidebar", rounds: "1" }), "fix sidebar");
    assert.equal(toolCallSummary("read_task", {}), null);
  });
});

describe("toolCallSummary —— 受管浏览器", () => {
  test("browser_navigate 摘要是 url；读取类没有入参摘要", () => {
    assert.equal(toolCallSummary("browser_navigate", { url: "scopus.com" }), "scopus.com");
    assert.equal(toolCallSummary("browser_extract", { offset: 100 }), null);
    assert.equal(toolCallSummary("browser_screenshot", {}), null);
  });

  test("交互类摘要是模型给的 element 人话；缺了退回 ref / 坐标；按键说键名、滚动说方向", () => {
    assert.equal(toolCallSummary("browser_click", { element: "Search button", ref: "e3" }), "Search button");
    assert.equal(toolCallSummary("browser_click", { ref: "e3" }), "e3");
    assert.equal(toolCallSummary("browser_click", { x: 120, y: 48 }), "120, 48");
    assert.equal(toolCallSummary("browser_type", { element: "Search box", text: "llm" }), "Search box");
    assert.equal(toolCallSummary("browser_press", { key: "Enter" }), "Enter");
    assert.equal(toolCallSummary("browser_scroll", { direction: "down" }), "down");
  });

  test("诊断工具摘要：控制台说级别、网络说地址与状态范围", () => {
    assert.equal(toolCallSummary("browser_console_messages", { level: "error" }), "error");
    assert.equal(toolCallSummary("browser_console_messages", {}), null);
    assert.equal(toolCallSummary("browser_network_requests", { url: "api" }), "api");
    assert.equal(toolCallSummary("browser_network_requests", { url: "api", statusMin: 400, statusMax: 499 }), "api (status 400–499)");
    assert.equal(toolCallSummary("browser_network_requests", { statusMin: 500 }), "status 500–…");
    assert.equal(toolCallSummary("browser_network_requests", { statusMax: 499 }), "status …–499");
    assert.equal(toolCallSummary("browser_network_requests", {}), null);
  });

  test("browser_wait_for 摘要是等的东西；两个都给了用 or 连起来", () => {
    assert.equal(toolCallSummary("browser_wait_for", { selector: "#results", timeoutMs: 8000 }), "#results");
    assert.equal(toolCallSummary("browser_wait_for", { text: "3 results" }), '"3 results"');
    assert.equal(toolCallSummary("browser_wait_for", { selector: "#results", text: "3 results" }), '#results or "3 results"');
    assert.equal(toolCallSummary("browser_wait_for", { timeoutMs: 8000 }), null);
  });
});

describe("toolCallSummary —— delegate（子会话 PR4a）", () => {
  test("派出卡任务预览复用同一条摘要（同 read_task 的 task 字段）", () => {
    assert.equal(toolCallSummary("delegate", { title: "x", task: "审查分支 3" }), "审查分支 3");
    assert.equal(toolCallSummary("delegate", { title: "x" }), null);
  });
});

describe("toolCallSummary —— 自我配置工具", () => {
  test("create_skill 摘要取 name，缺席退回 slug", () => {
    assert.equal(toolCallSummary("create_skill", { slug: "tdd", name: "TDD 流程", body: "..." }), "TDD 流程");
    assert.equal(toolCallSummary("create_skill", { slug: "tdd" }), "tdd");
    assert.equal(toolCallSummary("create_skill", {}), null);
  });
  test("add_mcp_server 摘要取 server 名", () => {
    assert.equal(toolCallSummary("add_mcp_server", { name: "search", server: { command: "npx" } }), "search");
    assert.equal(toolCallSummary("add_mcp_server", {}), null);
  });
});


describe("delegateCard（子会话 PR4a）", () => {
  const toolItem = (
    patch: Partial<Extract<ToolTranscriptItem, { status: "complete" }>> = {},
    status: "complete" | "running" = "complete",
  ): ToolTranscriptItem => ({
    id: "i1",
    role: "tool",
    toolCallId: "c1",
    toolName: "delegate",
    input: { title: "审查分支 3", task: "审查 f67bd28" },
    content: [{ type: "text", text: "Sub-session started…" }],
    timestamp: 1,
    status,
    isError: false,
    ...patch,
  });
  // 不显式标注 DelegateCard：details 字段要求结构满足 JsonValue（索引签名），
  // 具名接口的变量没有索引签名，赋值会被拒——保持推断出的字面量类型即可
  const validCard = {
    childId: "child-1",
    title: "审查分支 3",
    modelId: "glm-5.3",
    thinkingLevel: "medium" as const,
    workbench: "/workbenches/child-1",
  };

  test("终态帧的 details.delegate 逐字段校验后原样带回", () => {
    const card = delegateCard(toolItem({ details: { delegate: validCard } }));
    assert.deepEqual(card, validCard);
  });

  test("坏值判 null：running 帧、缺 details、缺字段、坏思考档、空 childId 都不给卡", () => {
    assert.equal(delegateCard(undefined), null);
    assert.equal(delegateCard(toolItem({}, "running")), null);
    assert.equal(delegateCard(toolItem({ details: undefined })), null);
    assert.equal(delegateCard(toolItem({ details: { other: 1 } })), null);
    assert.equal(
      delegateCard(toolItem({ details: { delegate: { ...validCard, childId: "" } } })),
      null,
    );
    assert.equal(
      delegateCard(toolItem({ details: { delegate: { ...validCard, title: "" } } })),
      null,
    );
    assert.equal(
      delegateCard(toolItem({ details: { delegate: { ...validCard, modelId: "" } } })),
      null,
    );
    assert.equal(
      delegateCard(toolItem({ details: { delegate: { ...validCard, workbench: "" } } })),
      null,
    );
    assert.equal(
      delegateCard(toolItem({ details: { delegate: { ...validCard, thinkingLevel: "extreme" } } })),
      null,
    );
  });
});

describe("channelMarkLabel（子会话 PR4a）", () => {
  test("本会话是父（ownSide parent，mark.from child）：question/progress/done/failed 各自的文案与 tone", () => {
    const parentSide = (kind: "question" | "progress" | "done" | "failed") =>
      channelMarkLabel({ from: "child", kind }, "parent", "审查 session/star", en);
    assert.deepEqual(parentSide("question"), {
      text: "审查 session/star asked",
      tone: "question",
    });
    assert.deepEqual(parentSide("progress"), {
      text: "审查 session/star · progress",
      tone: "neutral",
    });
    assert.deepEqual(parentSide("done"), {
      text: "审查 session/star done",
      tone: "done",
    });
    assert.deepEqual(parentSide("failed"), {
      text: "审查 session/star failed",
      tone: "failed",
    });
  });

  test("本会话是子（ownSide child，mark.from parent）：task/reply 的文案与 tone", () => {
    assert.deepEqual(channelMarkLabel({ from: "parent", kind: "task" }, "child", "审查栈", en), {
      text: "task from 审查栈",
      tone: "neutral",
    });
    assert.deepEqual(channelMarkLabel({ from: "parent", kind: "reply" }, "child", "审查栈", en), {
      text: "reply from 审查栈",
      tone: "reply",
    });
  });

  test("其余组合（理论上不出现）兜底成 <peer> · <kind>，tone 中性", () => {
    assert.deepEqual(channelMarkLabel({ from: "parent", kind: "task" }, "parent", "谁", en), {
      text: "谁 · task",
      tone: "neutral",
    });
    assert.deepEqual(channelMarkLabel({ from: "child", kind: "question" }, "child", "谁", en), {
      text: "谁 · question",
      tone: "neutral",
    });
  });
});

describe("时长与结果摘要 —— 中文（小学作业）", () => {
  test("工具时长：不足一分钟带小数秒，满一分钟分秒", () => {
    assert.equal(formatToolDuration(12_345, zh), "12.3 秒");
    assert.equal(formatToolDuration(64_000, zh), "1 分 04 秒");
    assert.equal(formatThinkingDuration(400, zh), "1 秒");
  });
});

// ── 运行中 shell 的可见性：expected_seconds / 运行时钟 / 自动展开 / 活尾 ──

describe("expectedSecondsOf / timeoutSecondsOf", () => {
  test("合法数字照收；额外字段不挤占 command 的读取", () => {
    assert.equal(expectedSecondsOf({ command: "sleep 40", timeout: 600, expected_seconds: 40 }), 40);
    assert.equal(timeoutSecondsOf({ command: "x", timeout: 600, expected_seconds: 40 }), 600);
  });
  test("timeout 套闸门同一条规则：不填补默认上限、比下限小抬到下限、填大尊重、超天花板夹住、非法不修", () => {
    assert.equal(timeoutSecondsOf({ command: "x", timeout: 60 }), COMMAND_TIMEOUT_FLOOR_SECONDS, "模型填 60，实际跑在下限上，显示也得说下限");
    assert.equal(timeoutSecondsOf({ command: "x", timeout: 900 }), 900);
    // 行为变更（2026-10-25）：不填不再是「无上限」，闸门会补 1800；界面继续说 null 就是撒谎
    assert.equal(timeoutSecondsOf({ command: "x" }), COMMAND_TIMEOUT_DEFAULT_SECONDS, "不填 = 跑在默认上限上");
    // 命令自述的时长（sleep N / timeout N …）：闸门把它换算成 min(N+60, HARD_MAX)，
    // 界面必须用同一个函数，否则显示 30:00、实际跑 34:20（界面撒谎）。
    assert.equal(timeoutSecondsOf({ command: "sleep 2000" }), 2060, "自述 2000 秒 → 2060（含 60 秒收尾余量）");
    assert.equal(timeoutSecondsOf({ command: "sleep 7200" }), COMMAND_TIMEOUT_HARD_MAX_SECONDS, "超过天花板 → 封顶，不做绕过上限的后门");
    assert.equal(timeoutSecondsOf({ command: "sleep 2000", timeout: 900 }), 900, "模型显式声明优先，自述时长不覆盖它");
    assert.equal(timeoutSecondsOf({ command: "bash -c 'sleep 2000'" }), COMMAND_TIMEOUT_DEFAULT_SECONDS, "被包一层就退回默认：认不出来不猜");
    assert.equal(timeoutSecondsOf({ command: "x", timeout: 99999 }), COMMAND_TIMEOUT_HARD_MAX_SECONDS, "超过天花板实际只跑 3600");
    assert.equal(timeoutSecondsOf({ command: "x", timeout: -5 }), null);
    assert.equal(timeoutSecondsOf({ command: "x", timeout: "600" }), null, "字符串数字不猜");
  });
  test("expected_seconds 不套下限——它是估计不是超时，估计 3 秒是合法的", () => {
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: 3 }), 3);
  });
  test("坏值判 null：缺失、零、负数、NaN、字符串数字、超一天", () => {
    assert.equal(expectedSecondsOf({ command: "x" }), null);
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: 0 }), null);
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: -5 }), null);
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: Number.NaN }), null);
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: "40" }), null, "字符串数字不猜");
    assert.equal(expectedSecondsOf({ command: "x", expected_seconds: 100_000 }), null);
    assert.equal(expectedSecondsOf(null), null);
    assert.equal(expectedSecondsOf("sleep 40"), null);
  });
  test("整数与浮点都收（预计 1.5 秒也是认真的估计）", () => {
    assert.equal(expectedSecondsOf({ expected_seconds: 1.5 }), 1.5);
  });
});

describe("quietNoticeSeconds（运行中 shell 的「无输出」标注）", () => {
  test("阈值：20 秒起报，正好卡在阈值上也算", () => {
    assert.equal(SHELL_QUIET_NOTICE_MS, 20_000);
    assert.equal(quietNoticeSeconds(20_000, 0, 0), 20);
    assert.equal(quietNoticeSeconds(19_999, 0, 0), null);
  });
  test("以最后一帧输出为准，输出帧之后重新计时", () => {
    assert.equal(quietNoticeSeconds(30_000, 5_000, 0), 25);
    assert.equal(quietNoticeSeconds(24_000, 5_000, 0), null, "距最后一帧才 19 秒，不报");
  });
  test("还没有输出帧时退回起跑时刻", () => {
    assert.equal(quietNoticeSeconds(25_000, null, 0), 25);
  });
  test("两个起点都没有（旧会话重开）→ 不显示，不猜时长", () => {
    assert.equal(quietNoticeSeconds(90_000, null, null), null);
    assert.equal(quietNoticeSeconds(Number.NaN, 0, 0), null);
  });
});

describe("formatRunClock", () => {
  test("m:ss，秒两位补零，分钟不限位；负数归零", () => {
    assert.equal(formatRunClock(0), "0:00");
    assert.equal(formatRunClock(45_000), "0:45");
    assert.equal(formatRunClock(60_000), "1:00");
    assert.equal(formatRunClock(723_000), "12:03");
    assert.equal(formatRunClock(4_335_000), "72:15", "超一小时继续涨分钟，不进位小时");
    assert.equal(formatRunClock(-3_000), "0:00");
  });
});

describe("shellAutoExpand", () => {
  test("expected 达阈值：开跑就展（elapsed 未知也展）", () => {
    assert.equal(shellAutoExpand(10, null), true);
    assert.equal(shellAutoExpand(120, 0), true);
  });
  test("expected 没给或没达：等已运行时长达阈值", () => {
    assert.equal(shellAutoExpand(null, 9_999), false);
    assert.equal(shellAutoExpand(null, 10_000), true);
    assert.equal(shellAutoExpand(5, 9_999), false, "预计 5 秒的快命令不打扰");
    assert.equal(shellAutoExpand(5, 10_000), true, "但真跑了 10 秒还是展");
  });
  test("两个信号都没有（旧会话重开、没记到起点）：不展", () => {
    assert.equal(shellAutoExpand(null, null), false);
  });
});

describe("tailPreviewLines", () => {
  test("取末尾非空行，跳过尾部空行，按原顺序返回", () => {
    assert.deepEqual(tailPreviewLines("a\nb\nc\n\n"), ["b", "c"]);
    assert.deepEqual(tailPreviewLines("only"), ["only"]);
    assert.deepEqual(tailPreviewLines(""), []);
    assert.deepEqual(tailPreviewLines("\n\n"), []);
  });
  test("行数多于 keep 只留最后 keep 行；长行截断带省略号", () => {
    assert.deepEqual(tailPreviewLines("1\n2\n3\n4", 2), ["3", "4"]);
    const long = "x".repeat(200);
    const preview = tailPreviewLines(long)[0];
    assert.ok(preview !== undefined && preview.endsWith("…") && preview.length < 200);
  });
});

describe("stripTrailingBlankLines", () => {
  test("shell 输出尾部的换行不再多出一行空白（套框后框底离文字一整行，2026-10-12 返工）", () => {
    assert.equal(stripTrailingBlankLines("Auto-merging a.ts\nAuto-merging b.ts\n"), "Auto-merging a.ts\nAuto-merging b.ts");
    assert.equal(stripTrailingBlankLines("a\n\n\n"), "a");
  });

  test("只剥尾部：中间的空行是内容结构，保留", () => {
    assert.equal(stripTrailingBlankLines("a\n\nb\n"), "a\n\nb");
  });

  test("全空 / 空串退化为空串，不报错", () => {
    assert.equal(stripTrailingBlankLines(""), "");
    assert.equal(stripTrailingBlankLines("\n\n"), "");
  });

  test("没有尾部空行时原样返回", () => {
    assert.equal(stripTrailingBlankLines("a\nb"), "a\nb");
  });
});

describe("toolStartAt", () => {
  test("跑着的条目给起点（end 为 null）；落定后不再给（运行时钟退场）", () => {
    recordToolFrame(toolItem({ toolCallId: "clock-1", status: "running", timestamp: 1_000 }));
    assert.equal(toolStartAt("clock-1"), 1_000);
    recordToolFrame(toolItem({ toolCallId: "clock-1", timestamp: 4_000 }));
    assert.equal(toolStartAt("clock-1"), null, "落定后运行时钟该退场");
    assert.equal(toolStartAt("clock-unknown"), null);
  });
});

describe("中断的 bash 不进运行态（PR 168 交汇）", () => {
  test("孤儿 bash 判入中断集，且无任何 running 帧——计时无从起", () => {
    const bashCall = {
      type: "toolCall",
      toolCallId: "b9",
      toolName: "bash",
      input: { command: "sleep 60", expected_seconds: 60 },
    };
    const records = [userItem, said("a1", [bashCall], "error")];
    const results = indexToolResults([]);
    // 纯函数面一：无结果帧 + error 收场 → 已中断（组件里 active = !interrupted && …
    // 据此为 false，shellActive 继承——不计时、不活尾、不自动展开，状态词走「已中断」；
    // “PR 168”指 fix/interrupted-tool-call 那一刀）
    assert.deepEqual([...interruptedToolCallIds(records, results, true)], ["b9"]);
    // 纯函数面二：从未启动就没有起点——即使 expected_seconds 很大，计时也无从显示
    assert.equal(toolStartAt("b9"), null);
  });
});

describe("运行时钟文案（en / zh）", () => {
  test("上限与预计的字典键在两种语言下都成句", () => {
    assert.equal(en.chat.limitLabel("10:00"), "limit 10:00");
    assert.equal(zh.chat.limitLabel("10:00"), "上限 10:00");
    assert.equal(en.chat.expectedAbout("40s"), "expected ~40s");
    assert.equal(zh.chat.expectedAbout("40 秒"), "预计约 40 秒");
    assert.equal(en.chat.slowerThanExpected, "slower than expected");
    assert.equal(zh.chat.slowerThanExpected, "比预计慢");
  });
});

describe("bash 通知行：解析（[orbita] kind=…）", () => {
  test("四种 kind 各解析成结构化对象，正文只剩命令自己的输出", () => {
    const text = [
      "build started",
      "[orbita] kind=stalled quiet=92s sampled=61s cpu_delta=3ms | No output for 92s.",
      "[orbita] kind=extended from=600s to=1200s count=1 max=2 | Deadline extended.",
      "[orbita] kind=descendants pid=105624 | A descendant is still running.",
      "[orbita] kind=cap seconds=1800 progress=yes | Killed at the limit.",
    ].join("\n");
    const parsed = parseBashNotices(text);
    assert.deepEqual(parsed.notices, [
      { kind: "stalled", quiet: 92, sampled: 61, cpuDelta: 3 },
      { kind: "extended", from: 600, to: 1200, count: 1, max: 2 },
      { kind: "descendants", pid: 105624 },
      { kind: "cap", seconds: 1800, declared: undefined, progress: true },
    ]);
    assert.equal(parsed.body, "build started");
  });

  test("cap 的 declared=no 解析成布尔假，不认识的值整行留在正文", () => {
    const declared = parseBashNotices("[orbita] kind=cap seconds=1800 declared=no | …");
    assert.deepEqual(declared.notices, [{ kind: "cap", seconds: 1800, declared: false, progress: undefined }]);
    const badValue = "[orbita] kind=cap seconds=1800 declared=maybe | …";
    assert.deepEqual(parseBashNotices(badValue), { notices: [], body: badValue }, "值不合格 → 原样保留");
  });

  test("未知 kind、坏掉的格式行原样留在正文里（宁可显示原文，不静默吞掉）", () => {
    const text = [
      "out",
      "[orbita] kind=future-thing foo=1 | unknown",
      "[orbita] no kind here",
      "[orbita] kind=stalled quiet=92 | missing unit",
      "[orbita] kind=stalled quiet=92s unexpected=1 | extra key",
      "tail",
    ].join("\n");
    const parsed = parseBashNotices(text);
    assert.deepEqual(parsed.notices, []);
    assert.equal(parsed.body, text, "一条都没命中时正文一个字节都不动");
  });

  test("CRLF：行首照样锚定，剥掉之后不留空坡", () => {
    const text = "out\r\n\r\n[orbita] kind=extended from=1s to=2s count=1 max=5 | x\r\nmore\r\n";
    const parsed = parseBashNotices(text);
    assert.deepEqual(parsed.notices, [{ kind: "extended", from: 1, to: 2, count: 1, max: 5 }]);
    assert.equal(parsed.body, "out\nmore\n");
  });

  test("只认行首：命令自己输出里的 [orbita] 字样不被误伤（含句中与缩进）", () => {
    const text = ["echoed [orbita] kind=cap seconds=1 progress=yes | x", "  [orbita] kind=cap | x"].join("\n");
    assert.deepEqual(parseBashNotices(text), { notices: [], body: text });
  });

  test("多条通知之间的空行收拢成一行，首尾空白行去掉", () => {
    const text = [
      "",
      "[orbita] kind=stalled quiet=30s sampled=60s cpu_delta=0ms | a",
      "",
      "",
      "[orbita] kind=extended from=1s to=2s count=1 max=2 | b",
      "",
    ].join("\n");
    const parsed = parseBashNotices(text);
    assert.equal(parsed.notices.length, 2);
    assert.equal(parsed.body, "");
  });
});

describe("bash 通知行：折叠行的量词", () => {
  test("行数 / 字数算在解析后的正文上，通知行不计；只剩通知时是「没有输出」", () => {
    const parsed = parseBashNotices(
      "[orbita] kind=stalled quiet=30s sampled=60s cpu_delta=0ms | x" +
        "\nout\nerr\n",
    );
    assert.equal(summaryOfText(parsed.body, zh), zh.chat.lines(2));
    const silent = parseBashNotices("[orbita] kind=stalled quiet=30s sampled=60s cpu_delta=0ms | x\n");
    assert.equal(summaryOfText(silent.body, en), en.chat.noOutputShort);
  });
});

describe("bash 通知行：合并（一个工具行最多一条次行、最多一条 cap）", () => {
  test("留了进程 + 疑似停滞 → 一条次行，进程事实在前、静默作补充", () => {
    const view = mergeBashNotices([
      { kind: "stalled", quiet: 200, sampled: 61 },
      { kind: "descendants", pid: 20488 },
    ]);
    assert.deepEqual(view.process, { pid: 20488, stalled: { quiet: 200, sampled: 61, cpuDelta: undefined } });
  });

  test("cap 两条合成一条：seconds 取带 progress 的那条（那才是被杀那一刻的真实期限）", () => {
    const view = mergeBashNotices([
      { kind: "cap", seconds: 1800, declared: false },
      { kind: "cap", seconds: 1740, progress: true },
    ]);
    assert.deepEqual(view.cap, { seconds: 1740, progress: true, declared: false });
  });

  test("只有 declared 那条（powershell 超时）也能用；重复 extended 取最远的那次", () => {
    const view = mergeBashNotices([
      { kind: "cap", seconds: 3600, declared: true },
      { kind: "extended", from: 600, to: 1200, count: 1, max: 2 },
      { kind: "extended", from: 1200, to: 1800, count: 2, max: 2 },
    ]);
    assert.deepEqual(view.cap, { seconds: 3600, progress: undefined, declared: true });
    assert.deepEqual(view.extended, { to: 1800, count: 2, max: 2 });
  });

  test("没有通知时三个槽位都是 null", () => {
    assert.deepEqual(mergeBashNotices([]), { extended: null, process: null, cap: null });
  });
});
