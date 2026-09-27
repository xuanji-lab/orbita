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
import {
  createPdfTools,
  PDF_IMAGE_HD_WIDTH,
  PDF_IMAGE_MAX_PAGES_PER_CALL,
  PDF_IMAGE_WIDTH,
  PDF_IMAGE_WIDTH_MAX,
  PDF_IMAGE_WIDTH_MIN,
  PDF_MAX_PAGES_PER_CALL,
} from "./pdf-tools.ts";

/** 夹具里的每页正文要够长（阈值 PDF_NO_TEXT_LAYER_MIN_CHARS 以上），除非在测扫描件 */
/**
 * 每页正文的两个行。各自行宽刻意 <90 字符：MediaBox 612pt / 12pt 字体一行只容得下
 * ~94 字符，更长的单行会被 pdf.js 文本层在页宽处截断（踩过：133 字符的行只提取出
 * 前 95 个）；两行合计 >80 又越过稀疏页阈值，不会每页都误报成图表候选。
 */
const LONG_A = "The quick brown fox jumps over the lazy dog near the river bank every morning.";
const LONG_B = "The valley keeps its slow pace without answering anybody, and so does the wind.";
const PAGE_BODY = `${LONG_A}\n${LONG_B}`;

function contentStream(text: string): string {
  if (text === "") return "BT ET";
  // 多行正文：一行一个 Tm 绝对定位（Td 是相对位移，第二行会叠加到页外被文本层丢弃，
  // 踩过）——纵向步进 14pt，行宽与行高都在 MediaBox 内
  const lines = text
    .split("\n")
    .map((line, i) => `/F1 12 Tf 1 0 0 1 72 ${720 - i * 14} Tm (${line}) Tj`)
    .join("\n");
  return `BT\n${lines}\nET`;
}

/**
 * 组装一份最小合法 PDF（Catalog=1, Pages=2, Font=3, 第 i 页占对象 4+2i 与 5+2i）。
 * `encrypted` 挂一个伪标准安全处理器——/O /U 是垃圾值没关系：pdf.js 判「需要密码」
 * 发生在比对 /U 之前，伪字典足以触发 PasswordException（/Encrypt 必须挂 **trailer**，
 * 挂 Catalog 会被当不加密直接读——踩过）。
 */
function buildPdf(pageTexts: readonly string[], encrypted = false): Buffer {
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
  const encryptObj = encrypted
    ? "<< /Filter /Standard /V 1 /R 2 /O <0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20> " +
      "/U <2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40> /P -1 >>"
    : null;
  if (encryptObj !== null) objects[6] = encryptObj;
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
  const trailerDict = encrypted
    ? `<< /Size ${size} /Root 1 0 R /Encrypt 6 0 R /ID [<aabbccddeeff00112233445566778899> <aabbccddeeff00112233445566778899>] >>`
    : `<< /Size ${size} /Root 1 0 R >>`;
  chunks.push(xref, `trailer\n${trailerDict}\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.from(chunks.join("\n"), "latin1");
}

let dir: string;
let tool: ReturnType<typeof createPdfTools>[number];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-pdf-"));
  tool = createPdfTools(dir)[0]!;
  await writeFile(join(dir, "three-pages.pdf"), buildPdf([PAGE_BODY, PAGE_BODY, PAGE_BODY]));
  await writeFile(
    join(dir, "mixed.pdf"),
    buildPdf([PAGE_BODY, PAGE_BODY, "", PAGE_BODY, "", PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY,
      PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY,
      PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY, PAGE_BODY]),
  );
  await writeFile(join(dir, "scanned.pdf"), buildPdf(["", ""]));
  await writeFile(join(dir, "plain.txt"), "just text, not a pdf");
  // header 前有垃圾（邮件系统前置字节的真实形态）——规范允许 header 落在前 1024 字节内
  await writeFile(join(dir, "junk-prefix.pdf"), Buffer.concat([Buffer.from("JUNKJUNK"), buildPdf([PAGE_BODY, PAGE_BODY])]));
  await writeFile(join(dir, "encrypted.pdf"), buildPdf([PAGE_BODY], true));
  await writeFile(join(dir, "fake-header.pdf"), Buffer.from("%PDF-1.4\nthis is not really a pdf\n"));
  // 图表文档：页 2 Figure 图注、页 3 Fig. 缩写+Table 表题、页 4 句中引用（不该进索引）。
  // 中文「图/表」模式盖不到：夹具是 Helvetica 西文字体，内容流里的中文会被 pdf.js 按
  // Latin-1 读成乱码——真实中文 PDF 走 CID 字体+ToUnicode，提取是正常中文、正则同样命中，
  // 这是手造夹具的物理边界而非工具边界
  await writeFile(
    join(dir, "figures.pdf"),
    buildPdf([
      PAGE_BODY,
      `${PAGE_BODY}\nFigure 3.2: Quarterly revenue by region`,
      `${PAGE_BODY}\nFig. 7 close-up view\nTable 2 regional summary`,
      `${PAGE_BODY}\nas shown in Figure 3 the trend continues`,
    ]),
  );
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (path: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await tool.execute("call-1", { path, ...args }, undefined, undefined, undefined as never);
  return result.content[0]!.type === "text" ? result.content[0]!.text : "";
};

/** 视觉模型的 ctx mock：ExtensionContext 只用到 model.input（visionCapable 的唯一读取面） */
const VISION_CTX = { model: { input: ["text", "image"] } } as never;

/** PNG IHDR 的宽度（字节偏移 16 起 4 字节 big-endian）——断言两档渲染宽度用 */
function pngWidth(base64: string): number {
  const bytes = Buffer.from(base64, "base64");
  return bytes.readUInt32BE(16);
}

/** 跑一轮并保留完整 content（页图模式断言 image 块用） */
const runFull = async (
  path: string,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<{ blocks: { type: string; text?: string; data?: string }[] }> => {
  const result = await tool.execute("call-1", { path, ...args }, undefined, undefined, ctx as never);
  return {
    blocks: result.content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: block.type, data: "data" in block ? String(block.data) : undefined },
    ),
  };
};

describe("read_pdf", () => {
  test("整读：≤ limit 的文件一次给全，头注报总页数与范围", async () => {
    const text = await run("three-pages.pdf");
    assert.ok(text.startsWith("[PDF with 3 pages. Showing pages 1-3 of 3.]"), text.slice(0, 80));
    assert.ok(text.includes("--- Page 1 ---"));
    assert.ok(text.includes(PAGE_BODY));
  });

  test("分页：offset/limit 按页切，余页给续读 offset", async () => {
    const text = await run("three-pages.pdf", { offset: 2, limit: 1 });
    assert.ok(text.includes("Showing pages 2-2 of 3. Use offset=3 to continue."), text.slice(0, 120));
    assert.ok(!text.includes("--- Page 1 ---"));
    assert.ok(text.includes("--- Page 2 ---"));
  });

  test("limit 封顶：超过 PDF_MAX_PAGES_PER_CALL 的请求被压到上限", async () => {
    const text = await run("mixed.pdf", { limit: 100 });
    assert.ok(
      text.includes(`Showing pages 1-${PDF_MAX_PAGES_PER_CALL} of 25. Use offset=${PDF_MAX_PAGES_PER_CALL + 1} to continue.`),
      text.slice(0, 140),
    );
  });

  test("混合文档放行：有字的页照给，空页在位注明", async () => {
    const text = await run("mixed.pdf", { offset: 3, limit: 2 });
    assert.ok(text.includes(`[page 3 has no text layer]`));
    assert.ok(text.includes(`--- Page 4 ---`));
    assert.ok(text.includes(PAGE_BODY));
  });

  test("扫描件 + 非视觉模型：无文本层仍报错（图给了也看不见）", async () => {
    await assert.rejects(run("scanned.pdf"), /no text layer/);
  });

  test("页图模式：images+视觉模型 → 文本在前、每页一图殿后（PNG base64）", async () => {
    const { blocks } = await runFull("three-pages.pdf", { images: true, limit: 2 }, VISION_CTX);
    assert.equal(blocks[0]!.type, "text");
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("Showing pages 1-2 of 3; page images follow the text."), text.slice(0, 120));
    assert.ok(text.includes("--- Page 1 ---"));
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1]!.type, "image");
    assert.equal(blocks[2]!.type, "image");
  });

  test("页图模式页数收紧：25 页文档 limit 100 → 只给前 5 页", async () => {
    const { blocks } = await runFull("mixed.pdf", { images: true, limit: 100 }, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(
      text.includes(`Showing pages 1-${PDF_IMAGE_MAX_PAGES_PER_CALL} of 25; page images follow the text`) &&
        text.includes(`Use offset=${PDF_IMAGE_MAX_PAGES_PER_CALL + 1} to continue.`),
      text.slice(0, 160),
    );
    assert.equal(blocks.length, PDF_IMAGE_MAX_PAGES_PER_CALL + 1);
  });

  test("扫描件 + 视觉模型：不报错，自动转页图", async () => {
    const { blocks } = await runFull("scanned.pdf", {}, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("Scanned PDF with no text layer"), text.slice(0, 120));
    assert.ok(text.includes("Rendered pages 1-2 as images (page 1: 2000×"), text.slice(0, 200));
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1]!.type, "image");
  });

  test("images + 非视觉模型：降级纯文本 + 省略说明（pi read 读图同款文案）", async () => {
    const { blocks } = await runFull("three-pages.pdf", { images: true }, undefined);
    assert.equal(blocks.length, 1);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("Current model does not support images"), text.slice(0, 200));
    assert.ok(text.includes("--- Page 1 ---"));
  });

  test("配合式：纯文本头注列出稀疏页（图表候选）——模型据此挑页", async () => {
    const text = await run("mixed.pdf", { limit: 3 });
    // mixed.pdf 的页 3、5 是空页（<80 字符）；其余页两行正文 ~157 字符不稀疏
    assert.ok(text.includes("Pages with little text (likely figures): 3, 5."), text.slice(0, 240));
  });

  test("图表索引：行首图注（Figure/Fig./Table）进索引报页码，句中引用不进", async () => {
    const text = await run("figures.pdf");
    const idx = text.indexOf("Figures and tables:");
    assert.ok(idx > -1, text.slice(0, 260));
    const indexLine = text.slice(idx, idx + 200);
    assert.ok(indexLine.includes("Figure 3.2 p.2"), indexLine);
    assert.ok(indexLine.includes("Figure 7 p.3"), indexLine);
    assert.ok(indexLine.includes("Table 2 p.3"), indexLine);
    // 页 4 的 "as shown in Figure 3 the trend" 是句中引用——Figure 3 不在索引里
    assert.ok(!indexLine.includes("Figure 3 "), indexLine);
  });

  test("图表索引直达：按索引页码 image_pages，渲染的正是图注所在页", async () => {
    const { blocks } = await runFull("figures.pdf", { image_pages: "2" }, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("images of pages 2 follow the text"), text.slice(0, 200));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]!.type, "image");
    // 精准转是高清档（2000px）：1080 下论文双栏里的图看不清，模型会绕路自救（会话 09a4af6c）
    assert.equal(pngWidth((blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_HD_WIDTH);
  });

  test("两档渲染宽度：批转 images:true 是 1080 浏览档，image_pages 是 2000 细看档", async () => {
    const batch = await runFull("three-pages.pdf", { images: true, limit: 1 }, VISION_CTX);
    assert.equal(pngWidth((batch.blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_WIDTH);
    const targeted = await runFull("three-pages.pdf", { image_pages: "1" }, VISION_CTX);
    assert.equal(pngWidth((targeted.blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_HD_WIDTH);
    // 扫描件自动转图同为高清档（页图即正文，读字要分辨率）
    const scanned = await runFull("scanned.pdf", {}, VISION_CTX);
    assert.equal(pngWidth((scanned.blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_HD_WIDTH);
  });

  test("width 自选：超范围钳制到 600-2000（宽窄是偏好不是错误）", async () => {
    const small = await runFull("three-pages.pdf", { image_pages: "1", width: 100 }, VISION_CTX);
    assert.equal(pngWidth((small.blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_WIDTH_MIN);
    const big = await runFull("three-pages.pdf", { image_pages: "1", width: 9999 }, VISION_CTX);
    assert.equal(pngWidth((big.blocks[1] as { data?: string }).data ?? ""), PDF_IMAGE_WIDTH_MAX);
    const mid = await runFull("three-pages.pdf", { image_pages: "1", width: 1280 }, VISION_CTX);
    assert.equal(pngWidth((mid.blocks[1] as { data?: string }).data ?? ""), 1280);
  });

  test("头注报图像素尺寸——crop 坐标的锚点（模型看到的图有多大，工具说清楚）", async () => {
    const { blocks } = await runFull("three-pages.pdf", { image_pages: "1" }, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    // 夹具页 612×792（纵横比 792/612=1.294），2000 宽渲染 → 高 ≈2588
    assert.ok(text.includes("Image sizes: page 1: 2000×"), text.slice(0, 240));
  });

  test("crop 特写（像素坐标）：区域渲染到满宽，头注注明 cropped 与输出尺寸", async () => {
    // 页图 2000×2588（头注报过）：取 x 200-1800（80% 宽）、y 259-1294（40% 高）
    const { blocks } = await runFull("three-pages.pdf", { image_pages: "1", crop: "200,259,1800,1294" }, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("(cropped to 200,259,1800,1294)"), text.slice(0, 240));
    assert.ok(text.includes("page 1 crop: 2000×1294px"), text.slice(0, 300));
    const data = (blocks[1] as { data?: string }).data ?? "";
    const bytes = Buffer.from(data, "base64");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    // 区域宽 1600px，源放大因子 2000²/1600=2500 → 输出 = 1600·k' ≈ 2000 满宽
    assert.ok(width >= 1500 && width <= 2000, `crop 输出宽 ${width}`);
    // 区域高 1035px · 同因子 → ≈1617·(1035/1600·2000/…)——按比例 ≈1294×2.5=…直接按实测窗口
    assert.ok(height > 1200 && height < 1800, `crop 输出高 ${height}`);
  });

  test("crop 校验：不配 image_pages 报错；倒序报错；x2 超页图宽报锚点说明；坏语法报形状", async () => {
    await assert.rejects(
      runFull("three-pages.pdf", { crop: "200,259,1800,1294" }, VISION_CTX),
      /crop requires image_pages/,
    );
    await assert.rejects(
      runFull("three-pages.pdf", { image_pages: "1", crop: "1800,259,200,1294" }, VISION_CTX),
      /need x1<x2 and y1<y2/,
    );
    await assert.rejects(
      runFull("three-pages.pdf", { image_pages: "1", crop: "0,0,2500,100" }, VISION_CTX),
      /beyond the page image width 2000/,
    );
    await assert.rejects(
      runFull("three-pages.pdf", { image_pages: "1", crop: "half" }, VISION_CTX),
      /is not "x1,y1,x2,y2"/,
    );
  });

  test("配合式：image_pages 精准转图——文本批不受影响，只渲染指定页", async () => {
    const { blocks } = await runFull("mixed.pdf", { image_pages: "3,5" }, VISION_CTX);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("Text of pages 1-20 of 25; images of pages 3, 5 follow the text."), text.slice(0, 160));
    assert.ok(text.includes("--- Page 1 ---"));
    // 文本批仍是 20 页上限（图不占文本预算）
    assert.ok(text.includes("--- Page 20 ---"));
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1]!.type, "image");
    assert.equal(blocks[2]!.type, "image");
  });

  test("image_pages 语法与边界：区间去重、越界报有效范围、超 5 页报上限、坏语法报形状", async () => {
    const { blocks } = await runFull("three-pages.pdf", { image_pages: "1-2, 2" }, VISION_CTX);
    assert.equal(blocks.length, 3); // "1-2, 2" 去重后 2 页图
    await assert.rejects(
      runFull("three-pages.pdf", { image_pages: "9" }, VISION_CTX),
      /Page 9 does not exist; valid pages are 1-3\./,
    );
    await assert.rejects(
      runFull("mixed.pdf", { image_pages: "1-6" }, VISION_CTX),
      /At most 5 image pages per call/,
    );
    await assert.rejects(
      runFull("three-pages.pdf", { image_pages: "page three" }, VISION_CTX),
      /is not a page number/,
    );
  });

  test("image_pages + 非视觉模型：降级纯文本 + 省略说明（同 images 的降级口径）", async () => {
    const { blocks } = await runFull("three-pages.pdf", { image_pages: "1" }, undefined);
    assert.equal(blocks.length, 1);
    const text = (blocks[0] as { text?: string }).text ?? "";
    assert.ok(text.includes("Current model does not support images"), text.slice(0, 200));
  });

  test("非 PDF 报错并指回 read 工具", async () => {
    await assert.rejects(run("plain.txt"), /Not a PDF file/);
  });

  test("垃圾前缀 PDF 放行：header 在前 1024 字节内即认（与 pdf.js 同口径）", async () => {
    const text = await run("junk-prefix.pdf");
    assert.ok(text.includes("[PDF with 2 pages."), text.slice(0, 80));
    assert.ok(text.includes(PAGE_BODY));
  });

  test("加密 PDF 报 password-protected，不当原始错误抛", async () => {
    await assert.rejects(run("encrypted.pdf"), /password-protected/);
  });

  test("解析失败的报错带文件名（裸 'Invalid PDF structure' 模型不知道坏的是哪个）", async () => {
    await assert.rejects(run("fake-header.pdf"), /Failed to parse PDF \(fake-header\.pdf\)/);
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
