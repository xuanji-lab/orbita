import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { firstFont, pptxColor, buildPptx, type PptxAsset } from "./pptx.ts";
import { applyWrite, createDeck } from "../../shared/slides-ops.ts";
import { BASIC_FONTS } from "../../shared/slides-export.ts";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const asset = (width: number, height: number): PptxAsset => ({ bytes: PNG_1x1, info: { format: "png", width, height } });

function fixtureDeck() {
  return applyWrite(createDeck({ title: "花园城市新加坡" }), [
    {
      at: 1,
      notes: "封面备注",
      elements: [{ kind: "text", html: "<b>花园城市</b><br>Garden City", x: 80, y: 60, w: 700, h: 160, fontSize: 48, fontFamily: '"PingFang SC", Arial', color: "#14372e" }],
    },
    {
      at: "append",
      notes: "第二页备注",
      elements: [
        { kind: "text", html: "<ul><li>自然</li><li>Hawker</li></ul>", x: 80, y: 80, w: 500, h: 200 },
        { kind: "line", x: 100, y: 400, w: 400, h: 120, points: [[0, 120], [400, 0]], endArrow: "arrow", stroke: "#c2410c", strokeWidth: 6 },
      ],
    },
    {
      at: "append",
      elements: [
        { kind: "image", src: "d.assets/a.png", x: 700, y: 100, w: 480, h: 270, fit: "cover" },
        { kind: "image", src: "d.assets/b.png", x: 60, y: 100, w: 400, h: 400, fit: "contain" },
        { kind: "image", src: "d.assets/gone.png", x: 60, y: 520, w: 100, h: 100 },
      ],
    },
    {
      at: "append",
      elements: [
        { kind: "table", rows: [["菜", "价格"], ["海南鸡饭", "S$4.5"], ["叻沙", "S$5"]], x: 100, y: 100, w: 700, h: 240 },
        { kind: "shape", shape: "ellipse", text: "圆", x: 900, y: 100, w: 200, h: 200, fill: "#fde68a", stroke: "#92400e" },
      ],
    },
  ]).deck;
}

const assets = new Map<string, PptxAsset>([
  ["d.assets/a.png", asset(1600, 900 * 2)],
  ["d.assets/b.png", asset(1000, 500)],
]);

async function unzip(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function text(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  assert.ok(file !== null, `缺少 ${name}`);
  return file.async("string");
}

describe("pptxColor", () => {
  it("hex / rgb / 命名色 / 透明度", () => {
    assert.deepEqual(pptxColor("#abc"), { color: "AABBCC", transparency: 0 });
    assert.deepEqual(pptxColor("#112233"), { color: "112233", transparency: 0 });
    assert.deepEqual(pptxColor("rgba(255,0,0,0.5)"), { color: "FF0000", transparency: 50 });
    assert.deepEqual(pptxColor("white"), { color: "FFFFFF", transparency: 0 });
    assert.equal(pptxColor("none"), null);
    assert.equal(pptxColor("garbage"), null);
  });
  it("字体栈取第一个", () => {
    assert.equal(firstFont('"PingFang SC", Arial'), "PingFang SC");
    assert.equal(firstFont(""), "Arial");
  });
});

describe("buildPptx", () => {
  it("保留字体：页数、图、线箭头、表格、备注都在，字体保留", async () => {
    const deck = fixtureDeck();
    const buffer = await buildPptx(deck, { basicFonts: false, assets });
    writeFileSync(process.env["ORBITA_PPTX_OUT"] ?? "/tmp/orbita-slides-keep.pptx", buffer);
    const zip = await unzip(buffer);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    assert.equal(slides.length, 4);
    const s1 = await text(zip, "ppt/slides/slide1.xml");
    assert.match(s1, /typeface="PingFang SC"/);
    const s2 = await text(zip, "ppt/slides/slide2.xml");
    assert.match(s2, /<a:tailEnd type="triangle"/);
    assert.match(s2, /<a:buChar|<a:buAutoNum/);
    assert.match(s2, /flipV="1"/);
    const s3 = await text(zip, "ppt/slides/slide3.xml");
    assert.equal((s3.match(/<p:pic>/g) ?? []).length, 2);
    assert.match(s3, /gone\.png/);
    const s4 = await text(zip, "ppt/slides/slide4.xml");
    assert.match(s4, /<a:tbl>/);
    assert.match(s4, /prst="ellipse"/);
    const notes = Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
    assert.equal(notes.length >= 2, true);
  });

  it("通用字体：所有 run 的 typeface 都在保底集合里", async () => {
    const buffer = await buildPptx(fixtureDeck(), { basicFonts: true, assets });
    writeFileSync(process.env["ORBITA_PPTX_OUT_BASIC"] ?? "/tmp/orbita-slides-basic.pptx", buffer);
    const zip = await unzip(buffer);
    const faces = new Set<string>();
    for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      for (const match of (await text(zip, name)).matchAll(/<a:latin typeface="([^"]+)"/g)) faces.add(match[1] as string);
    }
    assert.ok(faces.size > 0);
    for (const face of faces) assert.ok(BASIC_FONTS.includes(face), `非保底字体：${face}`);
    assert.ok(faces.has("Microsoft YaHei") && faces.has("Arial"));
  });

  it("空演示文稿（0 页）也能导出", async () => {
    const buffer = await buildPptx({ version: 1, title: "x", aspect: "16:9", slides: [] }, { basicFonts: false, assets: new Map() });
    assert.ok(buffer.length > 1000);
  });

  it("4:3 画布按 10×7.5 英寸", async () => {
    const buffer = await buildPptx({ ...createDeck({ title: "x", aspect: "4:3" }) }, { basicFonts: false, assets: new Map() });
    const zip = await unzip(buffer);
    assert.match(await text(zip, "ppt/presentation.xml"), /<p:sldSz cx="9144000" cy="6858000"/);
  });

  it("居中的项目符号段落：标记是段落属性（algn=ctr + buChar），跟着文字居中，不是钉在框左边", async () => {
    const deck = applyWrite(createDeck({ title: "居中列表" }), [
      {
        at: 1,
        elements: [
          { kind: "text", html: "<ul><li>全年皆宜</li><li>地铁便捷</li></ul>", x: 80, y: 80, w: 800, h: 300, align: "center" },
          { kind: "text", html: "<ul><li>靠左</li></ul>", x: 80, y: 420, w: 800, h: 100, align: "left" },
        ],
      },
    ]).deck;
    const zip = await unzip(await buildPptx(deck, { basicFonts: false, assets: new Map() }));
    const xml = await text(zip, "ppt/slides/slide1.xml");
    const paragraphs = xml.match(/<a:p>.*?<\/a:p>/gs) ?? [];
    const center = paragraphs.filter((p) => /algn="ctr"/.test(p) && /<a:buChar/.test(p));
    assert.equal(center.length, 2, "两条居中列表项都带项目符号");
    const left = paragraphs.filter((p) => /algn="l"/.test(p) && /<a:buChar/.test(p));
    assert.equal(left.length, 1);
  });
});
