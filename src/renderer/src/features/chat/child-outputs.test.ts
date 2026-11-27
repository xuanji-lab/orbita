import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "../../../../shared/session.ts";
import { childRunSettled, sessionOutputs } from "./child-outputs.ts";

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
      rec({ id: "a2", role: "assistant", content: [{ type: "text", text: "做好了：汇报在 report.md，页面是 summary.html，图是 chart.svg。" }], timestamp: 3.5 }),
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

describe("子会话交回的文档 / 网页同样只收最终回答点了名的，且只认已收尾的记录", () => {
  const user = rec({ id: "u", role: "user", content: [{ type: "text", text: "写报告" }], timestamp: 1 });
  const report = rec({ id: "t", role: "tool", toolCallId: "c", toolName: "report_to_parent", input: {}, content: [], timestamp: 2, status: "complete", isError: false });
  const finalText = (text: string) => rec({ id: "a", role: "assistant", content: [{ type: "text", text }], timestamp: 3 });
  const ledger = rec({
    id: "f",
    role: "file-turn",
    timestamp: 4,
    changes: [{ path: "/w/notes.md", added: 5, removed: 0 }, { path: "/w/tmp.md", added: 1, removed: 0 }, { path: "/w/page.html", added: 9, removed: 0 }],
  });
  test("交回那一刻文件账还没落盘：没收尾、没有文档 / 网页产物；落盘后收尾、点名的出现，没点名的只算「改过」", () => {
    const early = [user, report];
    assert.equal(childRunSettled(early, -1), false);
    assert.deepEqual(sessionOutputs(early).outputs, []);
    const settled = [user, report, finalText("笔记在 notes.md，页面是 page.html。"), ledger];
    assert.equal(childRunSettled(settled, early.length), true);
    const out = sessionOutputs(settled);
    assert.deepEqual(out.outputs.map((o) => `${o.kind}:${o.title}`), ["doc:notes.md", "web:page.html"]);
    assert.deepEqual(out.edited, ["/w/tmp.md"]);
  });
  test("最终回答只是顺带提到「那个文档」没点文件名：不出卡", () => {
    const out = sessionOutputs([user, report, finalText("文档和页面都改好了。"), ledger]);
    assert.deepEqual(out.outputs, []);
    assert.deepEqual(out.edited.sort(), ["/w/notes.md", "/w/page.html", "/w/tmp.md"]);
  });
});

describe("childRunSettled：交回时子会话的轮还没收尾，要等它的文件账", () => {
  const toolDone = rec({ id: "t", role: "tool", toolCallId: "c", toolName: "report_to_parent", input: {}, content: [], timestamp: 3, status: "complete", isError: false });
  const finalText = rec({ id: "a", role: "assistant", content: [{ type: "text", text: "完成" }], timestamp: 4 });
  const fileTurn = rec({ id: "f", role: "file-turn", timestamp: 5, changes: [], mediaArtifacts: [{ path: "/w/a.mp3" }] });
  test("最后一条是 file-turn：收尾了", () => assert.equal(childRunSettled([toolDone, finalText, fileTurn], -1), true));
  test("最后一条是工具结果（交回刚落账）：没收尾", () => assert.equal(childRunSettled([toolDone], -1), false));
  test("最后一条是正文但条数还在变：没收尾；两次读到同样条数：收尾了（这一轮没改文件）", () => {
    assert.equal(childRunSettled([toolDone, finalText], -1), false);
    assert.equal(childRunSettled([toolDone, finalText], 1), false);
    assert.equal(childRunSettled([toolDone, finalText], 2), true);
  });
  test("error / aborted 已是终局：即使留着 toolCall 也不继续轮询", () => {
    for (const status of ["error", "aborted"]) {
      const ended = rec({
        id: `a-${status}`,
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "dead", toolName: "bash", input: {} }],
        timestamp: 6,
        status,
      });
      assert.equal(childRunSettled([toolDone, ended], -1), true);
    }
  });
  test("空记录：没收尾", () => assert.equal(childRunSettled([], -1), false));
});
