import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { deckPagesFrom, processHeadline, processImages, processRows, stepVerb, turnOutputs } from "./process-rows.ts";
import type { ProcessStep, ToolCallUnit, ToolResultIndex } from "./tool-results.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

function call(id: string, toolName: string, input: unknown = {}): ToolCallUnit {
  return { kind: "toolCall", key: `k-${id}`, messageId: `m-${id}`, toolCallId: id, toolName, input, timestamp: 0 };
}

function done(id: string, toolName: string, extra: Partial<ToolTranscriptItem> = {}): [string, ToolTranscriptItem] {
  return [
    id,
    { id: `t-${id}`, role: "tool", toolCallId: id, toolName, input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...extra } as ToolTranscriptItem,
  ];
}

const card = (kind: string, path: string, title: string) => ({ card: { kind, path, title } });

describe("stepVerb：过程里每一步都是「动作 · 对象」，不露工具原名", () => {
  test("技能、外接工具、内置命令、文档改写、计划各有中文动作", () => {
    const skills = [{ slug: "slides", name: "slides" }];
    assert.deepEqual(stepVerb("read", { path: "/x/skills/slides/SKILL.md" }, zh.chat.stepVerb, skills), { verb: "用技能", object: "slides", raw: null });
    assert.equal(stepVerb("mcp__web-search__search", { q: "Proma" }, zh.chat.stepVerb).verb, "web-search 工具");
    assert.deepEqual(stepVerb("slides_create", { title: "新加坡" }, zh.chat.stepVerb), { verb: "新建演示文稿", object: "新加坡 · 16:9", raw: null });
    assert.deepEqual(stepVerb("edit", { path: "/n/周报.md" }, zh.chat.stepVerb), { verb: "改文档", object: "周报", raw: null });
    assert.equal(stepVerb("update_plan", { items: [{ text: "截图", status: "in_progress" }] }, zh.chat.stepVerb).object, "截图");
    assert.deepEqual(stepVerb("read", { path: "/a/b/handoff.txt" }, zh.chat.stepVerb), { verb: "读文件", object: "handoff.txt", raw: null });
  });

  test("动词表里没有的工具落「用工具」，原名放 raw 里不藏", () => {
    assert.deepEqual(stepVerb("some_new_tool", {}, en.chat.stepVerb), { verb: "Tool", object: null, raw: "some_new_tool" });
  });
});

describe("turnOutputs：一轮交给用户的东西，一份一行", () => {
  test("演示文稿按最后一次写的页数；新建后用相对路径写也认得出是同一份", () => {
    const calls = [
      call("c", "slides_create", { title: "新加坡" }),
      call("w1", "slides_write", { path: "新加坡.slides.json" }),
      call("w2", "slides_edit", { path: "新加坡.slides.json" }),
    ];
    const results: ToolResultIndex = new Map([
      done("c", "slides_create", { details: card("slides", "/w/新加坡.slides.json", "新加坡") }),
      done("w1", "slides_write", { content: [{ type: "text", text: "Wrote slide(s) 1, 2; the deck now has 2 slide(s)." }] }),
      done("w2", "slides_edit", { content: [{ type: "text", text: "Applied 1 change(s); the deck has 3 slide(s)." }] }),
    ]);
    assert.deepEqual(turnOutputs(calls, results), [{ kind: "slides", path: "/w/新加坡.slides.json", title: "新加坡", pages: 3, format: null }]);
  });

  test("PNG 是自检，不算产物；PDF 算；失败的不算", () => {
    const calls = [
      call("p", "slides_export", { format: "png" }),
      call("f", "slides_export", { format: "pdf" }),
      call("x", "doc_export", { format: "docx" }),
    ];
    const results: ToolResultIndex = new Map([
      done("p", "slides_export", { details: card("export", "/w/a.png", "a.png") }),
      done("f", "slides_export", { details: card("export", "/w/a.pdf", "a.pdf") }),
      done("x", "doc_export", { status: "error", isError: true, details: card("export", "/w/a.docx", "a.docx") } as Partial<ToolTranscriptItem>),
    ]);
    assert.deepEqual(turnOutputs(calls, results), [{ kind: "file", path: "/w/a.pdf", title: "a.pdf", pages: null, format: "PDF" }]);
  });

  test("「the deck now has N slide(s)」两种写法都认", () => {
    assert.equal(deckPagesFrom("Wrote slide(s) 1; the deck now has 7 slide(s)."), 7);
    assert.equal(deckPagesFrom("Applied 2 change(s); the deck has 4 slide(s)."), 4);
    assert.equal(deckPagesFrom("nothing"), null);
  });
});

describe("processHeadline：先说做出来的东西，再说还有几步", () => {
  const steps = (calls: ToolCallUnit[]): ProcessStep[] => calls;
  test("写了文件、做了演示文稿，剩下的步数扣掉这些", () => {
    const calls = [call("r", "read"), call("r2", "read"), call("e", "edit", { path: "a.ts" }), call("c", "slides_create"), call("w", "slides_write", { path: "/w/d.slides.json" })];
    const results: ToolResultIndex = new Map([done("c", "slides_create", { details: card("slides", "/w/d.slides.json", "d") })]);
    assert.equal(processHeadline(steps(calls), results, 1, zh.chat.headline), "写了 1 个文件、做了 1 份演示文稿，还有 2 步");
  });

  test("什么都没做出来：只说步数；改计划不算一步", () => {
    const calls = [call("r", "read"), call("p", "update_plan")];
    assert.equal(processHeadline(steps(calls), new Map(), 0, zh.chat.headline), "1 步");
  });
});

describe("processRows：平铺时说的话一行、每一步一行，思考挂在后面那一步上", () => {
  test("思考不单独成行", () => {
    const steps: ProcessStep[] = [
      { kind: "thinking", key: "t1", messageId: "m", text: "先看看", timestamp: 0 },
      call("r", "read"),
      { kind: "text", key: "s1", messageId: "m", text: "我先读一下", timestamp: 0 },
      call("b", "bash"),
    ];
    const rows = processRows(steps);
    assert.deepEqual(
      rows.map((row) => (row.kind === "say" ? `say:${row.text}` : `step:${row.call.toolName}:${row.thinking.join("|")}`)),
      ["step:read:先看看", "say:我先读一下", "step:bash:"],
    );
  });
});

describe("processImages：过程里出现过的图", () => {
  test("读图的结果里的图块、导出到盘上的 PNG", () => {
    const calls = [call("r", "read", { path: "/w/shot.png" }), call("p", "slides_export", { format: "png" })];
    const results: ToolResultIndex = new Map([
      done("r", "read", { content: [{ type: "image", data: "AAA", mimeType: "image/png" }] }),
      done("p", "slides_export", { details: card("export", "/w/p1.png", "p1.png") }),
    ]);
    const images = processImages(calls, results);
    assert.deepEqual(
      images.map((image) => (image.kind === "inline" ? `inline:${image.name}` : `file:${image.path}`)),
      ["inline:shot.png", "file:/w/p1.png"],
    );
  });
});
