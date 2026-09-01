import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { CompactedRecord } from "@shared/session";
import {
  editDiffText,
  flattenRenderUnits,
  formatThinkingDuration,
  groupToolUnits,
  indexToolResults,
  parseDiffLines,
  streamingThinkingKey,
  summarizeToolResult,
  thinkingDurationText,
  thinkingPreview,
  toolCallSummary,
  toolGroupStatus,
  toolResultText,
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
    assert.equal(summarizeToolResult(running), "running");

    const failed = indexToolResults([
      toolItem({ toolCallId: "a", status: "error", isError: true }),
    ]).get("a");
    assert.equal(summarizeToolResult(failed), "failed");
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

  test("空产出说 no output，而不是显示成 0 chars", () => {
    const empty = indexToolResults([toolItem({ toolCallId: "a", content: [] })]).get("a");
    assert.equal(summarizeToolResult(empty), "no output");
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
    assert.equal(formatThinkingDuration(0), "持续了 1 秒");
    assert.equal(formatThinkingDuration(300), "持续了 1 秒");
    assert.equal(formatThinkingDuration(12_400), "持续了 12 秒");
  });

  test("满一分钟说 N 分 M 秒", () => {
    assert.equal(formatThinkingDuration(61_000), "持续了 1 分 1 秒");
    assert.equal(formatThinkingDuration(125_000), "持续了 2 分 5 秒");
  });
});

describe("thinkingDurationText", () => {
  test("active 起表但不显示；落定冻结时长，之后不再变", () => {
    assert.equal(thinkingDurationText("k1", true, 1_000), null);
    assert.equal(thinkingDurationText("k1", false, 6_400), "持续了 5 秒");
    // 再过多久都还是落定那一刻的值
    assert.equal(thinkingDurationText("k1", false, 60_000), "持续了 5 秒");
  });

  test("没赶上开始的旧会话（没见过的 key 直接落定）——量不到，不显示", () => {
    assert.equal(thinkingDurationText("k-unknown", false, 5_000), null);
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
  test("edit 且 details.patch 是非空字符串时取出来", () => {
    const item = indexToolResults([
      toolItem({
        toolCallId: "a",
        toolName: "edit",
        details: {
          diff: "+ 3 hi",
          patch: "@@ -1 +1 @@\n-hi\n+bye",
          firstChangedLine: 3,
        },
      }),
    ]).get("a");
    assert.equal(item === undefined ? null : editDiffText(item), "@@ -1 +1 @@\n-hi\n+bye");
  });

  test("details 里只有 TUI 显示格式的 diff、没有 patch——返回 null，不把显示格式当 unified 喂进渲染", () => {
    const item = indexToolResults([
      toolItem({ toolCallId: "d0", toolName: "edit", details: { diff: "+ 3 hi" } }),
    ]).get("d0");
    assert.equal(item === undefined ? null : editDiffText(item), null);
  });

  test("不是 edit、没有 details、patch 缺失或为空——都返回 null", () => {
    const bash = indexToolResults([toolItem({ toolCallId: "b" })]).get("b");
    assert.equal(bash === undefined ? null : editDiffText(bash), null);

    const noDetails = indexToolResults([
      toolItem({ toolCallId: "c", toolName: "edit" }),
    ]).get("c");
    assert.equal(noDetails === undefined ? null : editDiffText(noDetails), null);

    const emptyPatch = indexToolResults([
      toolItem({ toolCallId: "d", toolName: "edit", details: { patch: "" } }),
    ]).get("d");
    assert.equal(emptyPatch === undefined ? null : editDiffText(emptyPatch), null);
  });
});
