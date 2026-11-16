/**
 * Zotero 三个工具的账：请求经 RequestBroker 落到主进程的 ZoteroService（这里直接接上，不经 Electron），
 * 读夹具库（main/zotero/test-library.ts），验给模型的文字、给界面的 details、读不了时的人话、工具描述的长度预算、权限分桶。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decidePermission } from "../shared/permission.ts";
import { readZoteroDetails, type ZoteroAgentRequest } from "../shared/zotero.ts";
import { setSnapshotRoot } from "../main/session/sqlite-readonly.ts";
import { ZoteroService } from "../main/zotero/service.ts";
import { buildTestLibrary, type TestLibrary } from "../main/zotero/test-library.ts";
import { RequestBroker } from "./request-broker.ts";
import { createZoteroTools } from "./zotero-tools.ts";

let root: string;
let lib: TestLibrary;
let tools: Map<string, ToolDefinition>;
let missing = false;
const events: Record<string, unknown>[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "orbita-zotero-tools-"));
  await setSnapshotRoot(join(root, "snapshots"));
  lib = buildTestLibrary(root);
  const service = new ZoteroService({
    locate: async () =>
      missing
        ? { found: null, tried: [join(root, "nowhere")] }
        : { found: { dir: lib.dataDir, database: lib.database, baseAttachmentPath: lib.baseDir, source: "override" }, tried: [lib.dataDir] },
  });
  const broker: RequestBroker = new RequestBroker((event) => {
    const record = event as Record<string, unknown>;
    events.push(record);
    void service.handle(record["request"] as ZoteroAgentRequest).then((outcome) => broker.resolve(record["requestId"] as string, outcome));
  });
  tools = new Map(createZoteroTools(broker, "session-1").map((tool) => [tool.name, tool]));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(name: string, params: Record<string, unknown>): Promise<{ text: string; details: unknown }> {
  const tool = tools.get(name);
  assert.ok(tool !== undefined, name);
  const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  const block = result.content[0];
  return { text: block !== undefined && block.type === "text" ? block.text : "", details: result.details };
}

describe("Zotero 工具", () => {
  test("三个工具；描述合计（含参数说明）≤ 1500 字符；描述点名 zotero 技能、说明 Zotero 不用开着", () => {
    assert.deepEqual([...tools.keys()], ["zotero_search", "zotero_item", "zotero_fulltext"]);
    let total = 0;
    for (const tool of tools.values()) {
      total += tool.description.length;
      const properties = (tool.parameters as unknown as { properties: Record<string, { description?: string }> }).properties;
      for (const property of Object.values(properties)) total += property.description?.length ?? 0;
    }
    assert.ok(total <= 1500, `工具描述合计 ${total} 字符`);
    assert.match(tools.get("zotero_search")?.description ?? "", /`zotero` skill/);
    assert.match(tools.get("zotero_search")?.description ?? "", /Zotero need not be running/);
  });

  test("权限：三个都是只读——plan 档放行", () => {
    for (const name of tools.keys()) assert.deepEqual(decidePermission("plan", name), { behavior: "allow" }, name);
  });

  test("查文献：每条一行（key · 标题 · 作者 · 年份 · 类型 · PDF），说明总数与翻页；details 列出条目", async () => {
    const { text, details } = await run("zotero_search", { query: "attention" });
    assert.match(text, /^Zotero: 1 item match "attention"; showing 1–1\./);
    assert.match(text, /1\. ATTN2345 · Attention Is All You Need · Vaswani et al\. · 2017 · conferencePaper · PDF/);
    assert.deepEqual(readZoteroDetails(details), {
      op: "search",
      total: 1,
      offset: 0,
      collection: null,
      items: [{ key: "ATTN2345", title: "Attention Is All You Need", creators: "Vaswani et al.", year: "2017" }],
    });
    const paged = await run("zotero_search", { limit: 1 });
    assert.match(paged.text, /6 items match the filters; showing 1–1\. Pass offset: 1 for more\./);
    assert.deepEqual(events.at(-1)?.["request"], { op: "search", limit: 1 });
    const none = await run("zotero_search", { query: "quantum chromodynamics" });
    assert.match(none.text, /No Zotero items match "quantum chromodynamics"/);
  });

  test("读条目：规范地址、附件给原路径并提示原样交给 read_pdf / cite_pdf；批注分页提示", async () => {
    const { text, details } = await run("zotero_item", { key: "ATTN2345" });
    assert.match(text, /URI: http:\/\/zotero\.org\/users\/1234567\/items\/ATTN2345/);
    assert.ok(text.includes(`PDFA2222 · PDF · Vaswani - 2017 - Attention Is All You Need.pdf · ${lib.pdfA}`));
    assert.match(text, /Use the PDF path as is with read_pdf \/ cite_pdf/);
    assert.match(text, /Annotations 1–30 of 35: Pass annotation_offset: 30 for more\./);
    assert.match(text, /p\.1 highlight #ffd400 · "Highlighted passage number 1/);
    assert.match(text, /Collections: .*博士论文 \/ 第二章 \(CLLB3333\)/);
    assert.deepEqual(readZoteroDetails(details), {
      op: "item",
      key: "ATTN2345",
      title: "Attention Is All You Need",
      attachments: [{ name: "Vaswani - 2017 - Attention Is All You Need.pdf", path: lib.pdfA, onDisk: true }],
      annotationTotal: 35,
      annotationOffset: 0,
      annotationShown: 30,
    });
  });

  test("读全文：区间与续读提示、PDF 路径与「引用改用 read_pdf + cite_pdf」；没有索引就如实说并给 PDF 路径", async () => {
    const { text, details } = await run("zotero_fulltext", { key: "ATTN2345", length: 200 });
    assert.match(text, /index covers 15\/15 pages\): characters 0–200 of \d+\. Pass start: 200 to continue\./);
    assert.ok(text.includes(`PDF: ${lib.pdfA}`));
    const parsed = readZoteroDetails(details);
    assert.ok(parsed?.op === "fulltext" && parsed.range?.end === 200 && parsed.path === lib.pdfA);
    const none = await run("zotero_fulltext", { key: "CHN22222" });
    assert.equal(none.text, `Zotero has no full-text index for "城市智能体的空间认知研究". Read the PDF instead: read_pdf with path ${lib.pdfB}`);
    assert.deepEqual(readZoteroDetails(none.details), { op: "fulltext", title: "城市智能体的空间认知研究", range: null, path: lib.pdfB });
  });

  test("读不了：工具失败原因就是那句人话（模型转述），不是栈", async () => {
    missing = true;
    try {
      await assert.rejects(run("zotero_search", { query: "x" }), (error: Error) => {
        assert.match(error.message, /^Zotero was not found on this computer/);
        assert.doesNotMatch(error.message, /at .*\.ts:\d+/);
        return true;
      });
    } finally {
      missing = false;
    }
  });

  test("缺 key：直接说要什么，不发请求", async () => {
    const before = events.length;
    await assert.rejects(run("zotero_item", {}), /"key" is required/);
    assert.equal(events.length, before);
  });
});

describe("readZoteroDetails：坏值判 null，不编", () => {
  test("缺字段 / 类型不对", () => {
    assert.equal(readZoteroDetails(null), null);
    assert.equal(readZoteroDetails({ zotero: { op: "search", total: "3" } }), null);
    assert.equal(readZoteroDetails({ zotero: { op: "item", key: "K" } }), null);
    assert.equal(readZoteroDetails({ zotero: { op: "other" } }), null);
  });
});
