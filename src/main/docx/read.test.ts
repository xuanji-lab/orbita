/**
 * `docx:open` 的账：能打开的包、超上限、加密包、非 zip、缺正文的坏包、hash 稳定性。
 * 夹具用 jszip 现造最小合法 docx（只要 zip 里有 word/document.xml 就算能打开——
 * 「是不是一份能渲染的文档」由 renderer 的引擎回答，这里只判主进程该判的事）。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { readDocxFile } from "./read.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-docx-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function docxBytes(body = "<w:p><w:r><w:t>hello</w:t></w:r></w:p>"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types/>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("readDocxFile", () => {
  test("正常 docx：回字节 + size + mtime + sha256", async () => {
    const path = join(dir, "a.docx");
    const bytes = await docxBytes();
    await writeFile(path, bytes);
    const result = await readDocxFile(path);
    assert.equal(result.kind, "docx");
    assert.ok(result.kind === "docx");
    assert.deepEqual([...result.data], [...bytes]);
    assert.equal(result.size, bytes.byteLength);
    assert.equal(typeof result.modifiedAt, "number");
    assert.match(result.hash, /^[0-9a-f]{64}$/);
  });

  test("同一个文件读两次 hash 相同，改一个字节 hash 变", async () => {
    const path = join(dir, "b.docx");
    await writeFile(path, await docxBytes());
    const first = await readDocxFile(path);
    const second = await readDocxFile(path);
    assert.ok(first.kind === "docx" && second.kind === "docx");
    assert.equal(first.hash, second.hash);

    await writeFile(path, await docxBytes("<w:p><w:r><w:t>HELLO</w:t></w:r></w:p>"));
    const third = await readDocxFile(path);
    assert.ok(third.kind === "docx");
    assert.notEqual(third.hash, first.hash);
  });

  test("超过上限：不读内容，回 too-large 与 limit", async () => {
    const path = join(dir, "big.docx");
    await writeFile(path, await docxBytes());
    const result = await readDocxFile(path, 8);
    assert.equal(result.kind, "too-large");
    assert.ok(result.kind === "too-large");
    assert.equal(result.limit, 8);
  });

  test("加密的 docx（OLE2 容器）：invalid + password", async () => {
    const path = join(dir, "locked.docx");
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    await writeFile(path, ole2);
    const result = await readDocxFile(path);
    assert.deepEqual(result.kind === "invalid" ? result.reason : null, "password");
  });

  test("改名成 .docx 的文本：invalid + not-docx", async () => {
    const path = join(dir, "notes.docx");
    await writeFile(path, "这不是 zip", "utf8");
    const result = await readDocxFile(path);
    assert.deepEqual(result.kind === "invalid" ? result.reason : null, "not-docx");
  });

  test("zip 但缺 word/document.xml：invalid + corrupt", async () => {
    const path = join(dir, "empty.docx");
    const zip = new JSZip();
    zip.file("readme.txt", "no document here");
    await writeFile(path, new Uint8Array(await zip.generateAsync({ type: "uint8array" })));
    const result = await readDocxFile(path);
    assert.deepEqual(result.kind === "invalid" ? result.reason : null, "corrupt");
  });

  test("半截 zip（PK 开头但截断）：invalid + corrupt", async () => {
    const path = join(dir, "truncated.docx");
    const full = await docxBytes();
    await writeFile(path, full.subarray(0, 40));
    const result = await readDocxFile(path);
    assert.deepEqual(result.kind === "invalid" ? result.reason : null, "corrupt");
  });

  test("传目录进来直接抛：调用方（ipc）本应已过白名单", async () => {
    await assert.rejects(readDocxFile(dir), /Not a file/);
  });
});

describe("readDocxFile —— 挂载前的页数粗估依据", () => {
  test("数段落与显式分页符（属性顺序无关）", async () => {
    const path = join(dir, "stats.docx");
    const body =
      '<w:p><w:r><w:t>a</w:t></w:r></w:p>' +
      '<w:p w:rsidR="00AB"><w:r><w:br w:type="page"/><w:t>b</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>c</w:t></w:r></w:p>';
    await writeFile(path, await docxBytes(body));
    const result = await readDocxFile(path);
    assert.ok(result.kind === "docx");
    assert.deepEqual(result.stats, { paragraphs: 3, pageBreaks: 1 });
  });
});

describe("readDocxFile —— 打开时文件已经不在了", () => {
  test("ENOENT 回 invalid(missing)，不抛 stat 的原始报错", async () => {
    const result = await readDocxFile(join(dir, "never-existed.docx"));
    assert.deepEqual(result, { kind: "invalid", reason: "missing", size: 0, modifiedAt: 0 });
  });
});
