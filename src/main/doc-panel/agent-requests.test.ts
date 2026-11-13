import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRoot } from "../../shared/files.ts";
import { applyDocRequest, defaultDocOut } from "./agent-requests.ts";

let dir = "";
let outside = "";
let roots: FileRoot[] = [];
const printPdf = async (html: string): Promise<Uint8Array> => Buffer.from(`%PDF-fake ${html.length}`);

before(async () => {
  // macOS 的临时目录是软链（/var → /private/var）：用真实路径，才与主进程返回的 realpath 同形
  dir = await realpath(await mkdtemp(join(tmpdir(), "doc-req-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "doc-out-")));
  roots = [{ kind: "workspace", label: "ws", path: dir, exists: true }];
  await mkdir(join(dir, "周报"), { recursive: true });
  await writeFile(join(dir, "周报", "w.md"), "# 周报\n\n见 [[页|别名]] ==亮==\n\n> [!tip] 提示\n> 内容\n");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("agent 的 doc_export 请求", () => {
  it("默认输出在文档旁边：docx / pdf / 通用 md；md 不覆盖原文", async () => {
    const doc = join(dir, "周报", "w.md");
    assert.equal(defaultDocOut(doc, "md"), join(dir, "周报", "w 副本.md"));
    assert.equal(defaultDocOut(doc, "md-plain"), join(dir, "周报", "w (通用).md"));
    const docx = await applyDocRequest({ roots, printPdf }, { path: doc, format: "docx" });
    assert.ok(docx.ok && docx.path === join(dir, "周报", "w.docx") && docx.bytes > 1000);
    const pdf = await applyDocRequest({ roots, printPdf }, { path: doc, format: "pdf" });
    assert.ok(pdf.ok);
    assert.match(await readFile(join(dir, "周报", "w.pdf"), "utf8"), /^%PDF-fake/);
    const plain = await applyDocRequest({ roots, printPdf }, { path: doc, format: "md-plain" });
    assert.ok(plain.ok);
    const text = await readFile(join(dir, "周报", "w (通用).md"), "utf8");
    assert.equal(/\[\[|==|> \[!/.test(text), false, text);
    assert.match(text, /别名/);
  });

  it("拒绝：输出在工作区外、扩展名不符、覆盖文档本身、文档在根外、不是文档", async () => {
    const doc = join(dir, "周报", "w.md");
    const escape = await applyDocRequest({ roots, printPdf }, { path: doc, format: "docx", out: join(outside, "x.docx") });
    assert.ok(!escape.ok && /不在工作区内/.test(escape.error));
    const up = await applyDocRequest({ roots, printPdf }, { path: doc, format: "docx", out: "../../../tmp/x.docx" });
    assert.ok(!up.ok);
    const ext = await applyDocRequest({ roots, printPdf }, { path: doc, format: "docx", out: "x.pdf" });
    assert.ok(!ext.ok && /\.docx/.test(ext.error));
    const self = await applyDocRequest({ roots, printPdf }, { path: doc, format: "md", out: doc });
    assert.ok(!self.ok && /覆盖/.test(self.error));
    await writeFile(join(outside, "o.md"), "x");
    const ext2 = await applyDocRequest({ roots, printPdf }, { path: join(outside, "o.md"), format: "md" });
    assert.ok(!ext2.ok);
    await writeFile(join(dir, "a.png"), "x");
    const notDoc = await applyDocRequest({ roots, printPdf }, { path: join(dir, "a.png"), format: "md" });
    assert.ok(!notDoc.ok && /只能打开文档/.test(notDoc.error));
  });
});
