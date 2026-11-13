/** CitedPdfIndex：从会话 JSONL 的 cite_pdf 工具结果里收「引用过的 PDF」，增量、缓存、整份重写后作废 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CitedPdfIndex } from "./cited-pdfs.ts";

const ID = "11111111-2222-3333-4444-555555555555";
let dir = "";
let log = "";
let index: CitedPdfIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-cited-pdfs-"));
  log = join(dir, `${ID}.jsonl`);
  index = new CitedPdfIndex(() => log);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const citation = (id: string, path: string) => ({ id, path, page: 1, start: 0, end: 5, text: "原文原文" });
/** 与 session store 写出的 tool 记录同形：键序 id, role, toolCallId, toolName, input, content, details */
const toolLine = (toolName: string, details: unknown, text = "ok"): string =>
  `${JSON.stringify({
    id: "r1",
    role: "tool",
    toolCallId: "call_1",
    toolName,
    input: {},
    content: [{ type: "text", text }],
    timestamp: 1,
    details,
    status: "complete",
    isError: false,
  })}\n`;
const cite = (...citations: ReturnType<typeof citation>[]): string =>
  toolLine("cite_pdf", { pdfCitations: citations });

describe("CitedPdfIndex", () => {
  test("收 cite_pdf 的 details.pdfCitations.path，去重；日志不存在 = 空", async () => {
    assert.deepEqual(await index.paths(ID), []);
    await writeFile(
      log,
      cite(citation("c001", "/a/one.pdf"), citation("c002", "/a/one.pdf")) + cite(citation("c003", "/b/two.pdf")),
    );
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf", "/b/two.pdf"]);
  });

  test("别的工具的 details 里长得像引用的、非 PDF、坏条目、坏行都不收", async () => {
    await writeFile(
      log,
      toolLine("read_pdf", { pdfCitations: [citation("c001", "/x/forged.pdf")] }) + // 不是 cite_pdf
        cite(citation("c002", "/x/notes.txt")) + // 不是 PDF
        cite({ ...citation("c003", "/x/bad.pdf"), page: 0 }) + // 页码非法（citationsOfDetails 丢）
        '{"id":"r9","role":"tool","toolName":"cite_pdf","details":{"pdfCitations":[ 半截\n' + // 坏行
        JSON.stringify({ id: "u1", role: "user", content: [{ type: "text", text: '"pdfCitations" /x/user.pdf' }] }) +
        "\n",
    );
    assert.deepEqual(await index.paths(ID), []);
  });

  test("增量：文件变长只读新增的，旧的仍在；没变不重读", async () => {
    await writeFile(log, cite(citation("c001", "/a/one.pdf")));
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf"]);
    await appendFile(log, cite(citation("c002", "/b/two.pdf")));
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf", "/b/two.pdf"]);
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf", "/b/two.pdf"]);
  });

  test("增量遇到写了一半的行：不丢——补完那一行后下一次读到", async () => {
    const full = cite(citation("c002", "/b/two.pdf"));
    await writeFile(log, cite(citation("c001", "/a/one.pdf")) + full.slice(0, 60));
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf"]);
    await appendFile(log, full.slice(60));
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf", "/b/two.pdf"]);
  });

  test("整份被原子重写（新 inode，哪怕更长）：缓存作废重扫，旧引用不残留", async () => {
    await writeFile(log, cite(citation("c001", "/a/old.pdf")));
    assert.deepEqual(await index.paths(ID), ["/a/old.pdf"]);
    const next = join(dir, "next.tmp");
    await writeFile(next, cite(citation("c002", "/b/new1.pdf")) + cite(citation("c003", "/b/new2.pdf")) + toolLine("bash", {}, "x".repeat(200)));
    await rename(next, log);
    assert.deepEqual(await index.paths(ID), ["/b/new1.pdf", "/b/new2.pdf"]);
  });

  test("文件变短也重扫；会话删掉（forget / 文件没了）清空", async () => {
    await writeFile(log, cite(citation("c001", "/a/one.pdf")) + toolLine("bash", {}, "x".repeat(500)));
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf"]);
    await writeFile(log, cite(citation("c009", "/z/short.pdf"))); // 同 inode、更短
    assert.deepEqual(await index.paths(ID), ["/z/short.pdf"]);
    await rm(log);
    assert.deepEqual(await index.paths(ID), []);
  });

  test("并发调用排成一条链：结果一致、不重复", async () => {
    await writeFile(log, cite(citation("c001", "/a/one.pdf")));
    const [a, b, c] = await Promise.all([index.paths(ID), index.paths(ID), index.paths(ID)]);
    assert.deepEqual(a, ["/a/one.pdf"]);
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
  });

  test("大行（几 MB 的工具结果）不被解析：夹在中间也不影响收集", async () => {
    await writeFile(
      log,
      toolLine("read_pdf", {}, "页".repeat(3_000_000)) + cite(citation("c001", "/a/one.pdf")) + toolLine("bash", {}, "y".repeat(2_000_000)),
    );
    assert.deepEqual(await index.paths(ID), ["/a/one.pdf"]);
  });
});
