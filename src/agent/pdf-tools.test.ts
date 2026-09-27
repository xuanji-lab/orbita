/**
 * read_pdf 的账：准入（魔数）、提取（unpdf 文本层）、分页（按页 offset/limit）、
 * 报错口径（扫描件/加密/非 PDF 如实上屏）。夹具是测试内组装的最小合法 PDF——
 * xref 偏移按字节现算，无需预置二进制文件；空页内容流没有 Tj，提取出来是空串，
 * 正好当扫描件夹具。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPdfTools, PDF_MAX_PAGES_PER_CALL } from "./pdf-tools.ts";

/** 夹具里的每页正文要够长（阈值 PDF_NO_TEXT_LAYER_MIN_CHARS 以上），除非在测扫描件 */
const LONG_LINE = "The quick brown fox jumps over the lazy dog near the river bank every morning.";

function contentStream(text: string): string {
  if (text === "") return "BT ET";
  return `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
}

/** 组装一份最小合法 PDF（Catalog=1, Pages=2, Font=3, 第 i 页占对象 4+2i 与 5+2i） */
function buildPdf(pageTexts: readonly string[]): Buffer {
  const kids = pageTexts.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objects: (string | { stream: string })[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pageTexts.length; i++) {
    objects[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objects[5 + 2 * i] = { stream: contentStream(pageTexts[i]!) };
  }
  const chunks = ["%PDF-1.4"];
  const offsets: number[] = [];
  for (let num = 1; num < objects.length; num++) {
    const body = objects[num];
    if (body === undefined) throw new Error(`fixture object ${num} missing`);
    offsets[num] = Buffer.byteLength(chunks.join("\n"), "latin1");
    chunks.push(
      typeof body === "string"
        ? `${num} 0 obj\n${body}\nendobj`
        : `${num} 0 obj\n<< /Length ${Buffer.byteLength(body.stream, "latin1")} >>\nstream\n${body.stream}\nendstream\nendobj`,
    );
  }
  const xrefStart = Buffer.byteLength(chunks.join("\n"), "latin1");
  const size = objects.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num++) {
    xref += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref, `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.from(chunks.join("\n"), "latin1");
}

let dir: string;
let tool: ReturnType<typeof createPdfTools>[number];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-pdf-"));
  tool = createPdfTools(dir)[0]!;
  await writeFile(join(dir, "three-pages.pdf"), buildPdf([LONG_LINE, LONG_LINE, LONG_LINE]));
  await writeFile(
    join(dir, "mixed.pdf"),
    buildPdf([LONG_LINE, LONG_LINE, "", LONG_LINE, "", LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE,
      LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE,
      LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE, LONG_LINE]),
  );
  await writeFile(join(dir, "scanned.pdf"), buildPdf(["", ""]));
  await writeFile(join(dir, "plain.txt"), "just text, not a pdf");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (path: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await tool.execute("call-1", { path, ...args }, undefined, undefined, undefined as never);
  return result.content[0]!.type === "text" ? result.content[0]!.text : "";
};

describe("read_pdf", () => {
  test("整读：≤ limit 的文件一次给全，头注报总页数与范围", async () => {
    const text = await run("three-pages.pdf");
    assert.ok(text.startsWith("[PDF with 3 pages. Showing pages 1-3 of 3.]"), text.slice(0, 80));
    assert.ok(text.includes("--- Page 1 ---"));
    assert.ok(text.includes(LONG_LINE));
  });

  test("分页：offset/limit 按页切，余页给续读 offset", async () => {
    const text = await run("three-pages.pdf", { offset: 2, limit: 1 });
    assert.ok(text.includes("Showing pages 2-2 of 3. Use offset=3 to continue.]"), text.slice(0, 120));
    assert.ok(!text.includes("--- Page 1 ---"));
    assert.ok(text.includes("--- Page 2 ---"));
  });

  test("limit 封顶：超过 PDF_MAX_PAGES_PER_CALL 的请求被压到上限", async () => {
    const text = await run("mixed.pdf", { limit: 100 });
    assert.ok(
      text.includes(`Showing pages 1-${PDF_MAX_PAGES_PER_CALL} of 25. Use offset=${PDF_MAX_PAGES_PER_CALL + 1} to continue.]`),
      text.slice(0, 140),
    );
  });

  test("混合文档放行：有字的页照给，空页在位注明", async () => {
    const text = await run("mixed.pdf", { offset: 3, limit: 2 });
    assert.ok(text.includes(`[page 3 has no text layer]`));
    assert.ok(text.includes(`--- Page 4 ---`));
    assert.ok(text.includes(LONG_LINE));
  });

  test("扫描件（无文本层）报错，不当空文件放行", async () => {
    await assert.rejects(run("scanned.pdf"), /no text layer/);
  });

  test("非 PDF 报错并指回 read 工具", async () => {
    await assert.rejects(run("plain.txt"), /Not a PDF file/);
  });

  test("offset 越界报错，报总页数", async () => {
    await assert.rejects(run("three-pages.pdf", { offset: 99 }), /beyond the last page \(3 pages total\)/);
  });

  test("文件不存在：readFile 的原始错误穿透（ENOENT 即路径写错的真相）", async () => {
    await assert.rejects(run(join(dir, "missing.pdf")), /ENOENT/);
  });

  test("pi 的 read 工具对 PDF 返回指路文案而非乱码（patch 守护）", async () => {
    const readTool = createReadToolDefinition(dir);
    const result = await readTool.execute(
      "call-2",
      { path: join(dir, "three-pages.pdf") },
      undefined,
      undefined,
      undefined as never,
    );
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.ok(text.includes("read_pdf"), text.slice(0, 120));
    assert.ok(!text.includes("%PDF-"), text.slice(0, 120));
  });
});
