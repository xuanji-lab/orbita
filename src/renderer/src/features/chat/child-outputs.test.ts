import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "../../../../shared/session.ts";
import { sessionOutputs } from "./child-outputs.ts";

const rec = (r: unknown) => r as TranscriptRecord;

describe("sessionOutputs：子会话整条记录做出来的东西", () => {
  test("演示文稿、写的文档与网页、旁路网页算产物；别的改过的文件只计数", () => {
    const records = [
      rec({ id: "u", role: "user", content: [{ type: "text", text: "做汇报" }], timestamp: 1 }),
      rec({ id: "a", role: "assistant", content: [{ type: "toolCall", toolCallId: "c", toolName: "slides_create", input: { title: "汇报" } }], timestamp: 2 }),
      rec({ id: "t", role: "tool", toolCallId: "c", toolName: "slides_create", input: {}, content: [], timestamp: 3, status: "complete", isError: false, details: { card: { kind: "slides", path: "/w/汇报.slides.json", title: "汇报" } } }),
      rec({
        id: "f",
        role: "file-turn",
        timestamp: 4,
        changes: [
          { path: "/w/report.md", added: 3, removed: 0 },
          { path: "/w/summary.html", added: 9, removed: 0 },
          { path: "/w/src/util.ts", added: 1, removed: 1 },
        ],
        webArtifacts: ["/w/chart.svg"],
      }),
    ];
    const { outputs, edited } = sessionOutputs(records);
    assert.deepEqual(
      outputs.map((output) => `${output.kind}:${output.title}`),
      ["slides:汇报", "doc:report.md", "web:summary.html", "web:chart.svg"],
    );
    assert.deepEqual(edited, ["/w/src/util.ts"]);
  });
});
