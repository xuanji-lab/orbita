import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfReaderDocs } from "./docs.ts";

function fixture(): { dir: string; pdf: string; data: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orbita-pdf-docs-"));
  const pdf = join(dir, "paper.pdf");
  writeFileSync(pdf, "%PDF-1.4\n");
  return { dir, pdf, data: join(dir, "paper.pdf.annotations.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

let n = 0;
const tokens = (): string => (++n).toString(16).padStart(32, "0");

const hl = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "highlight", position: { pageIndex: 0, rects: [[1, 2, 3, 4]] }, color: "#ffd400", ...extra });

test("没有数据文件：空批注、可写、不建文件；token 对应 PDF", async () => {
  const f = fixture();
  try {
    const docs = new PdfReaderDocs(tokens);
    const opened = await docs.open(f.pdf);
    assert.deepEqual(opened.annotations, []);
    assert.equal(opened.blocked, null);
    assert.equal(opened.dataFile, "paper.pdf.annotations.json");
    assert.equal(opened.docUrl, `orbita-reader://app/doc/${opened.token}`);
    assert.equal(docs.pdfPathOf(opened.token), f.pdf);
    assert.deepEqual(readdirSync(f.dir), ["paper.pdf"]);
  } finally {
    f.done();
  }
});

test("按 id 合并保存、按 id 删除、忽略 save([])、原子写不留临时文件", async () => {
  const f = fixture();
  try {
    const docs = new PdfReaderDocs(tokens);
    const { token } = await docs.open(f.pdf);
    assert.deepEqual(await docs.save(token, []), { ok: true, count: 0 });
    assert.deepEqual(readdirSync(f.dir), ["paper.pdf"]);
    assert.deepEqual(await docs.save(token, [hl("A", { sortIndex: "00001|000002|00010" }), hl("B", { sortIndex: "00000|000001|00010" })]), { ok: true, count: 2 });
    // 改评论只传那一条：浅合并保住没传的字段
    assert.deepEqual(await docs.save(token, [{ id: "A", type: "highlight", comment: "要点" }]), { ok: true, count: 2 });
    const file = JSON.parse(readFileSync(f.data, "utf8"));
    assert.equal(file.schema, 1);
    assert.equal(file.kind, "orbita.pdf-annotations");
    assert.equal(file.pdf, "paper.pdf");
    assert.deepEqual(file.annotations.map((a: { id: string }) => a.id), ["B", "A"]);
    assert.equal(file.annotations[1].comment, "要点");
    assert.equal(file.annotations[1].color, "#ffd400");
    assert.deepEqual(await docs.remove(token, ["B"]), { ok: true, count: 1 });
    assert.deepEqual(JSON.parse(readFileSync(f.data, "utf8")).annotations.map((a: { id: string }) => a.id), ["A"]);
    assert.deepEqual(readdirSync(f.dir).sort(), ["paper.pdf", "paper.pdf.annotations.json"]);
    // 重开读回来
    const again = await new PdfReaderDocs(tokens).open(f.pdf);
    assert.deepEqual(again.annotations.map((a) => a.id), ["A"]);
  } finally {
    f.done();
  }
});

test("坏条目丢掉不连累别的；连发两次 save 排队，不互相覆盖", async () => {
  const f = fixture();
  try {
    const docs = new PdfReaderDocs(tokens);
    const { token } = await docs.open(f.pdf);
    await Promise.all([docs.save(token, [hl("A"), { id: "../x", type: "highlight" }, { id: "C", type: "script" }]), docs.save(token, [hl("B")])]);
    assert.deepEqual(JSON.parse(readFileSync(f.data, "utf8")).annotations.map((a: { id: string }) => a.id).sort(), ["A", "B"]);
  } finally {
    f.done();
  }
});

test("只认当前那一份：再开一份，旧 token 作废；close 只关自己", async () => {
  const f = fixture();
  try {
    const docs = new PdfReaderDocs(tokens);
    const first = await docs.open(f.pdf);
    const second = await docs.open(f.pdf);
    assert.equal(docs.pdfPathOf(first.token), null);
    const stale = await docs.save(first.token, [hl("A")]);
    assert.equal(stale.ok, false);
    assert.equal(stale.ok === false && stale.reason, "expired");
    docs.close(first.token);
    assert.equal(docs.pdfPathOf(second.token), f.pdf);
    docs.close(second.token);
    assert.equal(docs.pdfPathOf(second.token), null);
  } finally {
    f.done();
  }
});

test("同名文件读不懂：按只读打开，写的时候拒绝，原文件一字不动", async () => {
  const f = fixture();
  try {
    for (const [content, reason] of [
      ["{ not json", "corrupt"],
      [JSON.stringify({ kind: "something-else", annotations: [] }), "foreign"],
      [JSON.stringify({ kind: "orbita.pdf-annotations", schema: 99, annotations: [] }), "newer"],
    ] as const) {
      writeFileSync(f.data, content);
      const docs = new PdfReaderDocs(tokens);
      const opened = await docs.open(f.pdf);
      assert.equal(opened.blocked, reason);
      const result = await docs.save(opened.token, [hl("A")]);
      assert.equal(result.ok === false && result.reason, reason);
      assert.equal(readFileSync(f.data, "utf8"), content);
    }
  } finally {
    f.done();
  }
});

test("PDF 所在目录不可写：打开时报 read-only，写入回 read-only 不抛", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  try {
    chmodSync(f.dir, 0o555);
    const docs = new PdfReaderDocs(tokens);
    const opened = await docs.open(f.pdf);
    assert.equal(opened.blocked, "read-only");
    const result = await docs.save(opened.token, [hl("A")]);
    assert.equal(result.ok === false && result.reason, "read-only");
  } finally {
    chmodSync(f.dir, 0o755);
    f.done();
  }
});

test("快速连开两次：按领号先后定谁是当前，后做完的旧请求抢不走", async () => {
  const f = fixture();
  try {
    const docs = new PdfReaderDocs(tokens);
    const first = docs.begin();
    const second = docs.begin();
    // 后发的先做完、先发的后做完（白名单 / 产物核对的 await 顺序不保证）
    const newer = await docs.open(f.pdf, second);
    const older = await docs.open(f.pdf, first);
    assert.equal(docs.pdfPathOf(newer.token), f.pdf);
    assert.equal(docs.pdfPathOf(older.token), null);
    // 旧的那次被调用方关掉（组件已卸载）也不影响当前那份
    docs.close(older.token);
    assert.equal(docs.pdfPathOf(newer.token), f.pdf);
  } finally {
    f.done();
  }
});
