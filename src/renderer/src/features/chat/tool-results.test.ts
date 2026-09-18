import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { CompactedRecord, SessionRecord } from "@shared/session";
import {
  answerText,
  branchAnchorEntries,
  branchAnchorIds,
  editDiffEntries,
  editDiffStats,
  editDiffText,
  editGroupFileCount,
  fileViewFor,
  flattenRenderUnits,
  formatThinkingDuration,
  groupToolUnits,
  indexToolResults,
  intraLineTokens,
  liveTailLines,
  parseDiffLines,
  parseEditDiff,
  parseGrepLine,
  readTaskCard,
  formatToolDuration,
  recordToolFrame,
  splitPathTail,
  streamingThinkingKey,
  mcpFailureKind,
  mcpInputSummary,
  mcpFailureLabel,
  mcpFailureLead,
  summarizeMcpResult,
  summarizeToolResult,
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
    assert.deepEqual(toolGroupStatus(calls, results), { total: 3, failed: 1, running: 1, done: 1 });
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
    assert.equal(summarizeToolResult(undefined), null);
  });

  test("状态优先用文字表达，不靠颜色", () => {
    const running = indexToolResults([
      toolItem({ toolCallId: "a", status: "running", isError: false }),
    ]).get("a");
    assert.equal(summarizeToolResult(running), "Running");

    const failed = indexToolResults([
      toolItem({ toolCallId: "a", status: "error", isError: true }),
    ]).get("a");
    assert.equal(summarizeToolResult(failed), "Failed");
  });

  test("多行数行数，单行数字符数", () => {
    const multi = indexToolResults([
      toolItem({ toolCallId: "a", content: [{ type: "text", text: "1\n2\n3" }] }),
    ]).get("a");
    assert.equal(summarizeToolResult(multi), "3 lines");

    const single = indexToolResults([
      toolItem({ toolCallId: "a", content: [{ type: "text", text: "hello" }] }),
    ]).get("a");
    assert.equal(summarizeToolResult(single), "5 chars");
  });

  test("空产出说无输出，而不是显示成 0 字符", () => {
    const empty = indexToolResults([toolItem({ toolCallId: "a", content: [] })]).get("a");
    assert.equal(summarizeToolResult(empty), "No output");
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
    assert.equal(item === undefined ? "" : toolResultText(item), "line 1\nline 2");
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
    assert.equal(item === undefined ? "" : toolResultText(item), "[image image/png]");
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
    assert.equal(formatThinkingDuration(0), "1s");
    assert.equal(formatThinkingDuration(300), "1s");
    assert.equal(formatThinkingDuration(12_400), "12s");
  });

  test("满一分钟「1m 05s」，秒两位补零", () => {
    assert.equal(formatThinkingDuration(60_000), "1m 00s");
    assert.equal(formatThinkingDuration(61_000), "1m 01s");
    assert.equal(formatThinkingDuration(125_000), "2m 05s");
  });
});

describe("thinkingDurationText", () => {
  test("active 起表但不显示；落定冻结时长，之后不再变", () => {
    assert.equal(thinkingDurationText("k1", true, 1_000), null);
    assert.equal(thinkingDurationText("k1", false, 6_400), "5s");
    // 再过多久都还是落定那一刻的值
    assert.equal(thinkingDurationText("k1", false, 60_000), "5s");
  });

  test("没赶上开始的旧会话（没见过的 key 直接落定）——量不到，不显示", () => {
    assert.equal(thinkingDurationText("k-unknown", false, 5_000), null);
  });
});

describe("recordToolFrame / toolDurationText", () => {
  test("running 帧记起点、终态帧记终点；增量帧重复到达不覆盖", () => {
    assert.equal(toolDurationText("t1"), null);
    recordToolFrame(toolItem({ toolCallId: "t1", status: "running", timestamp: 1_000 }));
    // 后到的 running 帧不改起点（adapter 的增量 item_updated 也是 running 态）
    recordToolFrame(toolItem({ toolCallId: "t1", status: "running", timestamp: 9_000 }));
    assert.equal(toolDurationText("t1"), null, "进行中不显示");
    recordToolFrame(toolItem({ toolCallId: "t1", timestamp: 13_300 }));
    assert.equal(toolDurationText("t1"), "12.3s");
    // 重复终态帧不改终点
    recordToolFrame(toolItem({ toolCallId: "t1", timestamp: 99_000 }));
    assert.equal(toolDurationText("t1"), "12.3s");
  });

  test("旧会话只有终态帧（没见过 running）——量不到，返回 null", () => {
    recordToolFrame(toolItem({ toolCallId: "t2", timestamp: 5_000 }));
    assert.equal(toolDurationText("t2"), null);
  });

  test("非 tool 记录不记（user/assistant 帧直接忽略）", () => {
    recordToolFrame(userItem);
    assert.equal(toolDurationText("item-undefined"), null);
  });
});

describe("formatToolDuration", () => {
  test("不足一分钟带一位小数；满一分钟「1m 04s」且秒两位补零", () => {
    assert.equal(formatToolDuration(80), "0.1s");
    assert.equal(formatToolDuration(12_340), "12.3s");
    assert.equal(formatToolDuration(59_940), "59.9s");
    assert.equal(formatToolDuration(61_000), "1m 01s");
    assert.equal(formatToolDuration(125_000), "2m 05s");
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
    assert.equal(summarizeMcpResult(mcpItem("complete", [{ type: "text", text: "echo: hello" }])), "11 chars");
    assert.equal(
      summarizeMcpResult(
        mcpItem("complete", [
          { type: "text", text: "echo: hi" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ]),
      ),
      "1 image · 8 chars",
    );
  });

  test("业务失败 = Failed（server 的话在正文里）", () => {
    const failed = mcpItem("error", [{ type: "text", text: "炸了" }]);
    assert.equal(summarizeMcpResult(failed), "Failed");
    assert.equal(mcpFailureKind(failed), "business");
    assert.equal(mcpFailureLead(failed), "The server reported an error.");
  });

  test("超时与不可达分得开：Timed out / Unreachable，各自的展开首行", () => {
    const timedOut = mcpItem("error", [{ type: "text", text: "mcp__demo__echo 调用超时" }]);
    assert.equal(mcpFailureKind(timedOut), "timedOut");
    assert.equal(mcpFailureLabel(timedOut), "Timed out");
    assert.match(mcpFailureLead(timedOut), /Timed out/);
    const gone = mcpItem("error", [
      { type: "text", text: 'mcp__demo__echo: server "demo" is not connected (it may have been removed by a reload)' },
    ]);
    assert.equal(mcpFailureKind(gone), "unreachable");
    assert.equal(mcpFailureLabel(gone), "Unreachable");
    assert.match(mcpFailureLead(gone), /no response from the server/i);
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
