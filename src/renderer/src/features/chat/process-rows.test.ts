import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { outsideFailure, allOutputs, assignImages, groupOutputs, deckPagesFrom, imagesOf, processHeadline, processRows, stepVerb, turnOutputs } from "./process-rows.ts";
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
    assert.deepEqual(turnOutputs(calls, results), [{ kind: "slides", path: "/w/新加坡.slides.json", title: "新加坡", pages: 3, format: null, detail: null }]);
  });

  test("PNG 是自检，不算产物；PDF 算；失败的不算", () => {
    const calls = [
      call("p", "slides_export", { format: "png" }),
      call("f", "slides_export", { format: "pdf" }),
      call("x", "doc_export", { format: "docx" }),
    ];
    const results: ToolResultIndex = new Map([
      done("p", "slides_export", { details: card("export", "/w/a.png", "a.png") }),
      done("f", "slides_export", { details: { card: { kind: "export", path: "/w/a.pdf", title: "a.pdf", subtitle: "PDF · 3 页" } } }),
      done("x", "doc_export", { status: "error", isError: true, details: card("export", "/w/a.docx", "a.docx") } as Partial<ToolTranscriptItem>),
    ]);
    assert.deepEqual(turnOutputs(calls, results), [{ kind: "pdf", path: "/w/a.pdf", title: "a.pdf", pages: null, format: "PDF", detail: "PDF · 3 页" }]);
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

  test("什么都没做出来：只说步数；改计划也算一步（展开后它占一行，段里的步数也数它）", () => {
    const calls = [call("r", "read"), call("p", "update_plan")];
    assert.equal(processHeadline(steps(calls), new Map(), 0, zh.chat.headline), "2 步");
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

describe("assignImages：同一张图只挂在第一次出现的那一步，每层的张数是下一层的和", () => {
  test("导出第 1 页再读回来看：图挂在导出那一步，读那一步不重复；另读一张截图照挂", () => {
    const calls = [
      call("p", "slides_export", { format: "png" }),
      call("r", "read", { path: "/w/p1.png" }),
      call("s", "read", { path: "/w/shot.png" }),
    ];
    const results: ToolResultIndex = new Map([
      done("p", "slides_export", { details: card("export", "/w/p1.png", "p1.png") }),
      done("r", "read", { content: [{ type: "image", data: "AAA", mimeType: "image/png" }] }),
      done("s", "read", { content: [{ type: "image", data: "BBB", mimeType: "image/png" }] }),
    ]);
    const byCall = assignImages(calls, results);
    assert.deepEqual([...byCall.keys()], ["p", "s"]);
    // 一段（前两步）1 张、整轮 2 张 = 每一步的张数相加
    assert.equal(imagesOf(calls.slice(0, 2), byCall).length, 1);
    assert.equal(imagesOf(calls, byCall).length, 2);
  });

  test("一次读出几页（读 PDF）按页各算一张", () => {
    const calls = [call("d", "read_pdf", { path: "/w/a.pdf" })];
    const results: ToolResultIndex = new Map([
      done("d", "read_pdf", {
        content: [
          { type: "image", data: "A", mimeType: "image/png" },
          { type: "image", data: "B", mimeType: "image/png" },
        ],
      }),
    ]);
    assert.equal(assignImages(calls, results).get("d")?.length, 2);
  });
});

describe("allOutputs：结尾这一摞产物", () => {
  test("写的 md 出文档卡；doc_open 打开过又改过的只算一份；网页排最后", () => {
    const calls = [call("o", "doc_open", { path: "周报.md" }), call("x", "doc_export", { format: "pdf" })];
    const results: ToolResultIndex = new Map([
      done("o", "doc_open", { details: card("doc", "/w/周报.md", "周报") }),
      done("x", "doc_export", { details: card("export", "/w/周报.pdf", "周报.pdf") }),
    ]);
    const outputs = allOutputs(calls, results, ["/w/周报.md", "/w/a.md"], ["/w/index.html"]);
    assert.deepEqual(
      outputs.map((output) => `${output.kind}:${output.title}`),
      ["doc:周报", "doc:a.md", "pdf:周报.pdf", "web:index.html"],
    );
  });
});

describe("groupOutputs：同一类三份以上收成一张", () => {
  test("12 个网页收成一组；演示文稿不收；两份文档不收", () => {
    const o = (kind: "slides" | "doc" | "pdf" | "web", title: string) => ({ kind, path: `/w/${title}`, title, pages: null, format: null, detail: null });
    const outputs = [o("slides", "演示"), o("doc", "a.md"), o("doc", "b.md"), ...Array.from({ length: 12 }, (_, i) => o("web", `p${i}.html`))];
    const slots = groupOutputs(outputs);
    assert.deepEqual(
      slots.map((slot) => (slot.kind === "one" ? slot.output.title : `${slot.type}×${slot.outputs.length}`)),
      ["演示", "a.md", "b.md", "web×12"],
    );
  });
});

describe("outsideFailure：留在过程外的行失败时行首是中文动作，不露工具原名", () => {
  test("装插件失败 · 路径不存在（找不到类的英文错误换成一句中文）", () => {
    assert.deepEqual(outsideFailure("install_plugin", "Plugin folder not found: /a/不存在", zh.chat.outsideFail), { head: "装插件失败", reason: "路径不存在" });
  });
  test("其它错误取第一行（截断），英文界面是英文动作", () => {
    assert.deepEqual(outsideFailure("delegate", "\n  title is required\nmore", zh.chat.outsideFail), { head: "派活失败", reason: "title is required" });
    assert.equal(outsideFailure("install_plugin", "x".repeat(200), en.chat.outsideFail)?.reason?.length, 81);
    assert.equal(outsideFailure("automation_update", "boom", en.chat.outsideFail)?.head, "Update automation failed");
  });
  test("空错误文本没有原因；不在表里的工具返回 null（照旧走通用行）", () => {
    assert.deepEqual(outsideFailure("show_plugin_board", "", zh.chat.outsideFail), { head: "放插件看板失败", reason: null });
    assert.equal(outsideFailure("bash", "exit 1", zh.chat.outsideFail), null);
  });
  test("每个留在过程外的工具都有中文与英文动作词", () => {
    for (const name of ["install_plugin", "show_plugin_board", "show_image", "delegate", "reply_subsession", "report_to_parent", "automation_create", "automation_update", "request_user_action"]) {
      assert.ok(zh.chat.outsideFail.actions[name] !== undefined && en.chat.outsideFail.actions[name] !== undefined, name);
    }
  });
});

describe("stepVerb：装插件 / 放插件看板有自己的动作词", () => {
  test("收进过程行的 show_plugin_board / install_plugin 不露工具原名", () => {
    assert.equal(stepVerb("show_plugin_board", { plugin: "p" }, zh.chat.stepVerb).verb, "放插件看板");
    assert.equal(stepVerb("install_plugin", { path: "/p" }, zh.chat.stepVerb).verb, "装插件");
    assert.equal(stepVerb("show_plugin_board", { plugin: "p" }, en.chat.stepVerb).raw, null);
  });
});

describe("导出的文件按文件类型分（不再有「导出的文件」一类）", () => {
  const exportResult = (id: string, tool: string, path: string, subtitle: string) =>
    done(id, tool, { details: { card: { kind: "export", path, title: path.split("/").pop() ?? path, subtitle } } });
  const calls = [
    call("a", "slides_export", { format: "pdf" }),
    call("b", "slides_export", { format: "pptx" }),
    call("c", "doc_export", { format: "docx" }),
    call("d", "doc_export", { format: "md" }),
  ];
  const results: ToolResultIndex = new Map([
    exportResult("a", "slides_export", "/w/d.pdf", "PDF · 3 页 · 261 KB"),
    exportResult("b", "slides_export", "/w/d.pptx", "PPTX · 3 页 · 80 KB"),
    exportResult("c", "doc_export", "/w/r.docx", "Word · 10.0 KB"),
    exportResult("d", "doc_export", "/w/r.md", "Markdown · 2 KB"),
  ]);
  test("PDF 自成一类；PPTX 并进演示文稿（类型字 PowerPoint）；Word / Markdown 并进文档", () => {
    const out = turnOutputs(calls, results);
    assert.deepEqual(
      out.map((o) => [o.kind, o.format, o.detail]),
      [
        ["pdf", "PDF", "PDF · 3 页 · 261 KB"],
        ["slides", "PowerPoint", "PowerPoint · 3 页 · 80 KB"],
        ["doc", "Word", "Word · 10.0 KB"],
        ["doc", "Markdown", "Markdown · 2 KB"],
      ],
    );
  });
  test("入参没写格式时按扩展名认", () => {
    const out = turnOutputs([call("x", "doc_export", {})], new Map([exportResult("x", "doc_export", "/w/z.docx", "Word · 1 KB")]));
    assert.deepEqual(out.map((o) => [o.kind, o.format]), [["doc", "Word"]]);
  });
  test("三份 PDF 收成「3 个 PDF」；导出的 PowerPoint 与演示文稿一样一份一张不收", () => {
    const pdf = (n: number) => ({ kind: "pdf" as const, path: `/w/${n}.pdf`, title: `${n}.pdf`, pages: null, format: "PDF", detail: null });
    const slots = groupOutputs([pdf(1), pdf(2), pdf(3), { kind: "slides", path: "/w/a.pptx", title: "a.pptx", pages: null, format: "PowerPoint", detail: null }]);
    assert.deepEqual(slots.map((s) => (s.kind === "one" ? s.output.title : `${s.type}×${s.outputs.length}`)), ["pdf×3", "a.pptx"]);
    assert.equal(zh.chat.outputGroup("pdf", 3), "3 个 PDF");
    assert.ok(!JSON.stringify(zh.chat).includes("导出的文件"));
  });
  test("折叠行一句话：导出来的单算「导出 N 个文件」，不算进做出的演示文稿 / 打开的文档", () => {
    const text = processHeadline(calls, results, 0, zh.chat.headline);
    assert.equal(text, "导出 4 个文件");
  });
});
