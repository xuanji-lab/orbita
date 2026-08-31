import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  diffLineKind,
  editDiffText,
  indexToolResults,
  isStandaloneItem,
  summarizeToolResult,
  toolCallSummary,
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

describe("isStandaloneItem", () => {
  test("tool item 不单独占一行——它挂在调用行上", () => {
    assert.equal(isStandaloneItem(toolItem({ toolCallId: "a" })), false);
  });

  test("user 与 assistant 照常占行", () => {
    assert.equal(isStandaloneItem(userItem), true);
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

describe("diffLineKind", () => {
  test("+ 增 / - 删 / 空格上下文", () => {
    assert.equal(diffLineKind("+added"), "add");
    assert.equal(diffLineKind("-removed"), "del");
    assert.equal(diffLineKind("  context"), "ctx");
    assert.equal(diffLineKind(""), "ctx");
  });

  test("@@ 块头与文件头归 meta；删空行是独立的 -，不与 --- 混淆", () => {
    assert.equal(diffLineKind("@@ -1,3 +1,4 @@"), "meta");
    assert.equal(diffLineKind("diff --git a/x b/x"), "meta");
    assert.equal(diffLineKind("--- a/x.ts"), "meta");
    assert.equal(diffLineKind("+++ b/x.ts"), "meta");
    assert.equal(diffLineKind("---"), "del");
  });
});

describe("editDiffText", () => {
  test("edit 且 details.diff 是非空字符串时取出来", () => {
    const item = indexToolResults([
      toolItem({
        toolCallId: "a",
        toolName: "edit",
        details: { diff: "+hi\n-bye", firstChangedLine: 3 },
      }),
    ]).get("a");
    assert.equal(item === undefined ? null : editDiffText(item), "+hi\n-bye");
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
