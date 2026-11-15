import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRange, PDF_READER_CSP, respondReader, type ReaderReply } from "./respond.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orbita-reader-respond-"));
  const buildDir = join(root, "build");
  const hostDir = join(root, "host");
  mkdirSync(join(buildDir, "app", "pdf", "web"), { recursive: true });
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(buildDir, "app", "reader.html"), "<html><head><title>Zotero Reader</title><script defer src=\"reader.js\"></script></head><body></body></html>");
  writeFileSync(join(buildDir, "app", "reader.js"), "window.createReader=1");
  writeFileSync(join(buildDir, "app", "pdf", "web", "viewer.html"), "<html></html>");
  writeFileSync(join(buildDir, "manifest.json"), "{}");
  writeFileSync(join(hostDir, "orbita-host.js"), "host()");
  writeFileSync(join(hostDir, "orbita-host.css"), "body{}");
  const pdf = join(root, "secret", "paper.pdf");
  mkdirSync(join(root, "secret"));
  writeFileSync(pdf, "0123456789");
  writeFileSync(join(root, "secret", "other.txt"), "nope");
  const deps = { buildDir, hostDir, pdfPathOf: (token: string) => (token === TOKEN ? pdf : null) };
  return { root, deps, done: () => rmSync(root, { recursive: true, force: true }) };
}

const go = (url: string, deps: Parameters<typeof respondReader>[3], method = "GET", range: string | null = null) =>
  respondReader(`orbita-reader://app${url}`, method, range, deps);

const fileOf = (reply: ReaderReply) => ("file" in reply ? reply.file : null);

test("入口页插桥脚本、换掉标题里的品牌名，带严格 CSP", async () => {
  const f = fixture();
  try {
    const reply = await go("/reader.html", f.deps);
    assert.equal(reply.status, 200);
    const body = "body" in reply ? String(reply.body) : "";
    assert.match(body, /<script defer src="orbita-host\.js"><\/script><\/head>/);
    assert.match(body, /<title>PDF<\/title>/);
    assert.doesNotMatch(body, /Zotero/);
    assert.equal(reply.headers["content-security-policy"], PDF_READER_CSP);
    assert.match(PDF_READER_CSP, /default-src 'none'/);
  } finally {
    f.done();
  }
});

test("只给得出阅读器产物、桥脚本与当前 PDF；路径穿越与别的文件一律 404", async () => {
  const f = fixture();
  try {
    assert.equal(fileOf(await go("/reader.js", f.deps))?.path, join(f.deps.buildDir, "app", "reader.js"));
    assert.equal(fileOf(await go("/pdf/web/viewer.html", f.deps))?.path, join(f.deps.buildDir, "app", "pdf", "web", "viewer.html"));
    assert.equal(fileOf(await go("/orbita-host.js", f.deps))?.path, join(f.deps.hostDir, "orbita-host.js"));
    for (const bad of [
      "/../manifest.json",
      "/%2e%2e/manifest.json",
      "/%2e%2e/%2e%2e/secret/other.txt",
      "/..%2f..%2fsecret%2fother.txt",
      "/pdf/..%5c..%5cmanifest.json",
      "/nothing.js",
      "/doc/ffffffffffffffffffffffffffffffff",
      "/doc/../secret/paper.pdf",
      "/doc/" + TOKEN + "/../x",
    ]) {
      const reply = await go(bad, f.deps);
      assert.ok(reply.status === 404 || reply.status === 400, `${bad} → ${reply.status}`);
    }
    assert.equal((await respondReader("orbita-reader://evil/reader.html", "GET", null, f.deps)).status, 404);
    assert.equal((await go("/reader.html", f.deps, "POST")).status, 405);
  } finally {
    f.done();
  }
});

test("当前 PDF 支持 Range：整份 200、单段 206、越界 416、HEAD 不带正文", async () => {
  const f = fixture();
  try {
    const whole = await go(`/doc/${TOKEN}`, f.deps);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(whole.headers["content-length"], "10");
    assert.deepEqual(fileOf(whole), { path: join(f.root, "secret", "paper.pdf"), start: 0, end: 9 });
    const part = await go(`/doc/${TOKEN}`, f.deps, "GET", "bytes=2-5");
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], "bytes 2-5/10");
    assert.equal(part.headers["content-length"], "4");
    assert.deepEqual(fileOf(part), { path: join(f.root, "secret", "paper.pdf"), start: 2, end: 5 });
    const tail = await go(`/doc/${TOKEN}`, f.deps, "GET", "bytes=-3");
    assert.equal(tail.headers["content-range"], "bytes 7-9/10");
    assert.equal((await go(`/doc/${TOKEN}`, f.deps, "GET", "bytes=10-")).status, 416);
    const head = await go(`/doc/${TOKEN}`, f.deps, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(fileOf(head), null);
    assert.equal(readFileSync(join(f.root, "secret", "paper.pdf"), "utf8"), "0123456789");
  } finally {
    f.done();
  }
});

test("parseRange 的边界", () => {
  assert.equal(parseRange(null, 10), null);
  assert.equal(parseRange("bytes=0-1,4-5", 10), null);
  assert.equal(parseRange("items=0-1", 10), null);
  assert.deepEqual(parseRange("bytes=0-", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=5-100", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=-100", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=6-3", 10), "unsatisfiable");
});
