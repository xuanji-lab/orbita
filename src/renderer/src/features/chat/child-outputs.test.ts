import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "../../../../shared/session.ts";
import { sessionOutputs } from "./child-outputs.ts";

const rec = (r: unknown) => r as TranscriptRecord;

describe("sessionOutputs：子会话交回的音视频只收最终回答点了名的", () => {
  const candidates = [
    { path: "/w/final.mp3", duration: 8 },
    { path: "/w/trial1.wav", duration: 15 },
  ];
  const round = (answer: string, narration: string) => [
    rec({ id: "u", role: "user", content: [{ type: "text", text: "做语音" }], timestamp: 1 }),
    rec({ id: "a1", role: "assistant", content: [{ type: "text", text: narration }, { type: "toolCall", toolCallId: "c", toolName: "bash", input: {} }], timestamp: 2 }),
    rec({ id: "t", role: "tool", toolCallId: "c", toolName: "bash", input: {}, content: [], timestamp: 3, status: "complete", isError: false }),
    rec({ id: "a2", role: "assistant", content: [{ type: "text", text: answer }], timestamp: 4 }),
    rec({ id: "f", role: "file-turn", timestamp: 5, changes: [], mediaArtifacts: candidates }),
  ];
  test("回答只点了成品：试音不出现；过程旁白里提到的试音不算", () => {
    const { outputs } = sessionOutputs(round("成品是 final.mp3。", "先做试音 trial1.wav。"));
    assert.deepEqual(outputs.map((o) => `${o.kind}:${o.title}:${o.duration}`), ["audio:final.mp3:8"]);
  });
  test("回答没点名：没有产物", () => {
    assert.deepEqual(sessionOutputs(round("做好了。", "")).outputs, []);
  });
  test("回答点了几个就收几个", () => {
    assert.deepEqual(sessionOutputs(round("final.mp3 和 trial1.wav 都在。", "")).outputs.map((o) => o.title), ["final.mp3", "trial1.wav"]);
  });
  test("每轮各自看自己的最终回答（上一轮点过名不带到下一轮）", () => {
    const second = [
      rec({ id: "u2", role: "user", content: [{ type: "text", text: "再来" }], timestamp: 6 }),
      rec({ id: "a3", role: "assistant", content: [{ type: "text", text: "没做出新的。" }], timestamp: 7 }),
      rec({ id: "f2", role: "file-turn", timestamp: 8, changes: [], mediaArtifacts: [{ path: "/w/other.mp3" }] }),
    ];
    const { outputs } = sessionOutputs([...round("成品是 final.mp3。", ""), ...second]);
    assert.deepEqual(outputs.map((o) => o.title), ["final.mp3"]);
  });
});

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
