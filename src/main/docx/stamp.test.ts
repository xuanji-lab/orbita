/**
 * 打开时的盖章（补齐 `w14:paraId`）：判据、失败降级、幂等。
 *
 * 「幂等」这一条是 N2 的命门：同一份包盖第二次必须 `alreadyComplete`、字节不变——否则每次
 * 打开都在改用户的文件（而盖章只在首次保存时才随编辑落盘，重复盖章等于给每次保存塞一份差异）。
 * 这里直接对着引擎的 `ensureParaIds` 跑一遍真包（jszip 现造的最小合法 docx），不是替身。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { ensureParaIds } from "@stll/folio-core/docx/ensureParaIds";
import { ensureParaIdStamp, needsStamp, type DocxStampReply } from "./stamp.ts";

/**
 * 最小但**完整**的 docx 包：`ensureParaIds` 要读包关系（`_rels/.rels`），只有
 * `word/document.xml` 的裸包会被它拒（"Package relationships not found"）——
 * 这正是它对「能改的包」的定义，测试照它来造。
 */
async function docxBytes(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      body +
      "</w:body></w:document>",
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

const stats = (paragraphs: number, paraIds: number) => ({ paragraphs, pageBreaks: 0, paraIds });

describe("needsStamp", () => {
  it("段落比 paraId 多就要盖；一个不缺就不碰", () => {
    assert.equal(needsStamp(stats(3, 0)), true);
    assert.equal(needsStamp(stats(3, 2)), true);
    assert.equal(needsStamp(stats(3, 3)), false);
    assert.equal(needsStamp(stats(0, 0)), false);
  });
});

describe("ensureParaIdStamp", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it("不需要盖章：原样返回，线程一次都不进", async () => {
    let called = 0;
    const result = await ensureParaIdStamp(bytes, stats(2, 2), async () => {
      called += 1;
      return { id: 1, ok: true, data: new Uint8Array(), assigned: 9, deduplicated: 0, alreadyComplete: false };
    });
    assert.equal(called, 0);
    assert.equal(result.data, bytes);
    assert.deepEqual(result.stamp, { ok: true, assigned: 0, deduplicated: 0, reason: null });
  });

  it("签名包：退回原始字节，如实回报 signed（不拦打开）", async () => {
    const result = await ensureParaIdStamp(bytes, stats(2, 0), async (): Promise<DocxStampReply> => ({
      id: 1,
      ok: false,
      reason: "signed",
      error: "signed package",
    }));
    assert.deepEqual(result.stamp, { ok: false, assigned: 0, deduplicated: 0, reason: "signed" });
    assert.equal(result.data, bytes);
  });

  it("超时：退回原始字节，reason 说 timeout", async () => {
    const result = await ensureParaIdStamp(bytes, stats(2, 0), async (): Promise<DocxStampReply> => ({
      id: 1,
      ok: false,
      reason: "failed",
      error: "timeout",
    }));
    assert.deepEqual(result.stamp, { ok: false, assigned: 0, deduplicated: 0, reason: "timeout" });
  });

  it("线程抛错：一样降级，不把异常抛给打开流程", async () => {
    const result = await ensureParaIdStamp(bytes, stats(2, 0), async () => {
      throw new Error("worker boom");
    });
    assert.deepEqual(result.stamp, { ok: false, assigned: 0, deduplicated: 0, reason: "failed" });
    assert.equal(result.data, bytes);
  });

  it("成功：换成盖章后的字节，计数与原因如实带回", async () => {
    const stamped = new Uint8Array([9, 9, 9, 9]);
    const result = await ensureParaIdStamp(bytes, stats(2, 0), async (): Promise<DocxStampReply> => ({
      id: 1,
      ok: true,
      data: stamped,
      assigned: 2,
      deduplicated: 1,
      alreadyComplete: false,
    }));
    assert.equal(result.data, stamped);
    assert.deepEqual(result.stamp, { ok: true, assigned: 2, deduplicated: 1, reason: null });
  });
});

describe("ensureParaIds（引擎）——幂等", () => {
  it("第一次补上，第二次 alreadyComplete 且字节完全一致", async () => {
    const original = await docxBytes(
      '<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>',
    );
    const first = await ensureParaIds(original);
    assert.equal(first.assigned, 2);
    assert.equal(first.alreadyComplete, false);
    assert.equal(first.mintedParaIds.length, 2);

    const second = await ensureParaIds(first.docx);
    assert.equal(second.alreadyComplete, true);
    assert.equal(second.assigned, 0);
    assert.equal(Buffer.compare(Buffer.from(second.docx), Buffer.from(first.docx)), 0);
  });
});
