import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import { createSlidesTools } from "./slides-tools.ts";
import { parseDeck } from "../shared/slides.ts";
import { readCommandCard, readOpenPanel } from "../shared/builtin-command.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dir: string;
let outside: string;
const sent: Record<string, unknown>[] = [];
let tools: Record<string, ToolDefinition>;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-slides-tools-"));
  outside = await mkdtemp(join(tmpdir(), "orbita-slides-tools-out-"));
  const broker = new RequestBroker((event) => {
    sent.push(event as Record<string, unknown>);
    const requestId = (event as { requestId: string }).requestId;
    queueMicrotask(() => broker.resolve(requestId, { ok: true, path: join(dir, "x.pdf"), bytes: 2048, pages: 3 }));
  });
  const list = createSlidesTools(broker, "s1", { cwd: dir, writeRoots: [dir], workspaceId: "w1" });
  tools = Object.fromEntries(list.map((tool) => [tool.name, tool]));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function run(name: string, params: Record<string, unknown>) {
  const tool = tools[name] as ToolDefinition;
  const result = await tool.execute("t1", params as never, undefined, undefined, undefined as never);
  const first = result.content[0];
  return { text: first !== undefined && first.type === "text" ? first.text : "", details: result.details as unknown };
}

describe("slides tools", () => {
  it("六个工具齐全，描述里有 schema 说明", () => {
    assert.deepEqual(Object.keys(tools).sort(), ["slides_create", "slides_edit", "slides_export", "slides_insert_image", "slides_read", "slides_write"]);
    assert.match(tools["slides_write"]?.description ?? "", /1280×720/);
  });

  it("create：落盘 0 页、details 带 openPanel(force) 与 card", async () => {
    const out = await run("slides_create", { title: "花园城市新加坡", aspect: "16:9" });
    const path = join(dir, "花园城市新加坡.slides.json");
    assert.deepEqual(parseDeck(await readFile(path, "utf8")).deck.slides, []);
    assert.deepEqual(readOpenPanel(out.details), { kind: "slides", path, force: true });
    assert.equal(readCommandCard(out.details)?.title, "花园城市新加坡");
    // 重名加序号
    await run("slides_create", { title: "花园城市新加坡" });
    assert.ok((await readdir(dir)).includes("花园城市新加坡 2.slides.json"));
  });

  it("create 拒绝工作区外与非 .slides.json", async () => {
    await assert.rejects(() => run("slides_create", { title: "x", path: join(outside, "a.slides.json") }), /inside the workspace/);
    await assert.rejects(() => run("slides_create", { title: "x", path: "a.json" }), /\.slides\.json/);
    await assert.rejects(() => run("slides_create", { title: "x", path: "../escape.slides.json" }), /inside the workspace/);
  });

  it("write：五页一次写入，页数对，非 force 的 openPanel", async () => {
    const path = "花园城市新加坡.slides.json";
    const out = await run("slides_write", {
      path,
      slides: [1, 2, 3, 4, 5].map((n) => ({ at: n, elements: [{ kind: "text", html: `第${n}页`, x: 80, y: 80, w: 600, h: 80 }], notes: `备注${n}` })),
    });
    assert.match(out.text, /now has 5 slide/);
    assert.equal(readOpenPanel(out.details)?.force, undefined);
    const deck = parseDeck(await readFile(join(dir, path), "utf8")).deck;
    assert.equal(deck.slides.length, 5);
    assert.equal(deck.slides[2]?.notes, "备注3");
  });

  it("write：坏元素报错带位置，文件不变", async () => {
    const path = join(dir, "花园城市新加坡.slides.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(() => run("slides_write", { path, slides: [{ at: 1, elements: [{ kind: "image", src: "../../x.png" }] }] }), /slides\[0\]\.elements\[0\]/);
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("write：箭头与表格写入后 read 读得回", async () => {
    const path = "花园城市新加坡.slides.json";
    await run("slides_write", {
      path,
      slides: [
        { at: 2, elements: [{ kind: "line", x: 100, y: 300, w: 400, h: 1, points: [[0, 0], [400, 0]], endArrow: "arrow" }] },
        { at: 4, elements: [{ kind: "table", rows: [["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]], x: 100, y: 100, w: 600, h: 300 }] },
      ],
    });
    const read = await run("slides_read", { path });
    assert.match(read.text, /endArrow=arrow/);
    assert.match(read.text, /table id=\S+ .* 3×3/);
    const one = await run("slides_read", { path, slide: 2 });
    assert.ok(!one.text.includes("Slide 1"));
  });

  it("edit：改标题、加页后 move，id 不存在给人话", async () => {
    const path = "花园城市新加坡.slides.json";
    const deck = parseDeck(await readFile(join(dir, path), "utf8")).deck;
    const id = deck.slides[0]?.elements[0]?.id as string;
    await run("slides_edit", { path, ops: [{ op: "patch", slide: 1, id, patch: { html: "城市长在花园里" } }] });
    assert.match((await run("slides_read", { path, slide: 1 })).text, /城市长在花园里/);
    await assert.rejects(() => run("slides_edit", { path, ops: [{ op: "delete", slide: 1, id: "nope" }] }), /没有元素 nope/);
    await assert.rejects(() => run("slides_edit", { path, ops: [{ op: "frobnicate" }] }), /unknown op/);
    await run("slides_write", { path, slides: [{ elements: [{ kind: "text", html: "结语" }] }] });
    assert.match((await run("slides_read", { path })).text, /6 slide/);
  });

  it("insert_image：复制进 assets、加元素；非图片 / 找不到 / 页号越界报错", async () => {
    const path = "花园城市新加坡.slides.json";
    await writeFile(join(dir, "hawker.png"), PNG);
    const out = await run("slides_insert_image", { path, slide: 3, image_path: "hawker.png" });
    assert.match(out.text, /花园城市新加坡\.assets\/hawker\.png/);
    assert.ok((await readdir(join(dir, "花园城市新加坡.assets"))).includes("hawker.png"));
    const deck = parseDeck(await readFile(join(dir, path), "utf8")).deck;
    const img = deck.slides[2]?.elements.find((e) => e.kind === "image");
    assert.equal(img?.kind === "image" && img.src, "花园城市新加坡.assets/hawker.png");
    await writeFile(join(dir, "fake.png"), "not an image, just text, long enough to pass");
    await assert.rejects(() => run("slides_insert_image", { path, slide: 3, image_path: "fake.png" }), /Not a supported image/);
    await assert.rejects(() => run("slides_insert_image", { path, slide: 3, image_path: "nope.png" }), /not found/);
    await assert.rejects(() => run("slides_insert_image", { path, slide: 99, image_path: "hawker.png" }), /没有第 99 页/);
  });

  it("write 引用不存在的图 → 体检里提醒", async () => {
    const out = await run("slides_write", { path: "花园城市新加坡.slides.json", slides: [{ at: 1, elements: [{ kind: "image", src: "x.assets/none.png" }] }] });
    assert.match(out.text, /does not exist/);
  });

  it("export：走 broker，带 workspaceId，返回卡片", async () => {
    sent.length = 0;
    const out = await run("slides_export", { path: "花园城市新加坡.slides.json", format: "pdf" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["type"], "slidesRequest");
    assert.equal(sent[0]?.["workspaceId"], "w1");
    assert.match(out.text, /Exported pdf/);
    assert.equal(readCommandCard(out.details)?.kind, "export");
    await assert.rejects(() => run("slides_export", { path: "花园城市新加坡.slides.json", format: "docx" }), /format/);
  });

  it("不存在的演示文稿给出指向 slides_create 的提示", async () => {
    await assert.rejects(() => run("slides_read", { path: "nope.slides.json" }), /slides_create/);
  });
});
