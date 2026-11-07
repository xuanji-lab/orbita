import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { eastAsianFont, firstFont, fontSegments, pptxColor, buildPptx, type PptxAsset } from "./pptx.ts";
import { applyEdit, applyWrite, createDeck } from "../../shared/slides-ops.ts";
import { FONT_SANS, FONT_SERIF, presetTheme } from "../../shared/slides-theme.ts";
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

describe("东亚字体：中文不只拿到拉丁字体", () => {
  it("eastAsianFont：取字体栈里第一个东亚字体；栈里没有就 PingFang SC", () => {
    assert.equal(eastAsianFont(FONT_SANS), "PingFang SC");
    assert.equal(eastAsianFont(FONT_SERIF), "Songti SC");
    assert.equal(eastAsianFont('"Helvetica Neue", Arial, sans-serif'), "PingFang SC");
    assert.equal(eastAsianFont('Arial, "Microsoft YaHei"'), "Microsoft YaHei");
  });

  it("fontSegments：保留字体版按字符切开（中文用东亚字体，其余用拉丁字体）；通用字体版整段一个保底字体", () => {
    assert.deepEqual(fontSegments("你好 Hello，世界 2026", FONT_SANS, false), [
      { text: "你好", fontFace: "PingFang SC" },
      { text: " Hello", fontFace: "Helvetica Neue" },
      { text: "，世界", fontFace: "PingFang SC" },
      { text: " 2026", fontFace: "Helvetica Neue" },
    ]);
    assert.deepEqual(fontSegments("Hello", FONT_SANS, false), [{ text: "Hello", fontFace: "Helvetica Neue" }]);
    assert.deepEqual(fontSegments("你好 Hello", FONT_SANS, true), [{ text: "你好 Hello", fontFace: "Microsoft YaHei" }]);
  });

  it("保留字体版的 pptx：含中文的 run 的 latin / ea 都是东亚字体，拉丁 run 仍是 Helvetica Neue；每个 run 都写了 a:ea；表格与形状文字同样", async () => {
    const deck = applyWrite(createDeck({ title: "t" }), [
      {
        at: 1,
        elements: [
          { kind: "text", html: "你好 Hello，世界", x: 0, y: 0, w: 400, h: 80, fontSize: 30, fontFamily: FONT_SANS },
          { kind: "table", rows: [["语言 Lang", "x"]], x: 0, y: 100, w: 300, h: 60 },
          { kind: "shape", shape: "rect", text: "圆 a", x: 0, y: 200, w: 100, h: 50 },
        ],
      },
    ]).deck;
    const keep = await text(await unzip(await buildPptx(deck, { basicFonts: false, assets: new Map() })), "ppt/slides/slide1.xml");
    const pairs = [...keep.matchAll(/<a:latin typeface="([^"]+)"[^>]*\/><a:ea typeface="([^"]+)"/g)].map((m) => `${m[1]}/${m[2]}`);
    assert.ok(pairs.length >= 8);
    // 每个 run 的 ea 与 latin 同源：没有「中文 run 只拿到 Helvetica Neue」
    assert.ok(pairs.every((pair) => pair.split("/")[0] === pair.split("/")[1]));
    assert.ok(pairs.includes("PingFang SC/PingFang SC"));
    assert.ok(pairs.includes("Helvetica Neue/Helvetica Neue"));
    // 含中文字符的 run 不能是 Helvetica Neue
    for (const run of keep.matchAll(/<a:r>(.*?)<\/a:r>/gs)) {
      const body = run[1] as string;
      if (/[\u4e00-\u9fff]/.test(body)) assert.doesNotMatch(body, /typeface="Helvetica Neue"/);
    }
    const basic = await text(await unzip(await buildPptx(deck, { basicFonts: true, assets: new Map() })), "ppt/slides/slide1.xml");
    const eas = new Set([...basic.matchAll(/<a:ea typeface="([^"]+)"/g)].map((m) => m[1] as string));
    for (const face of eas) assert.ok(BASIC_FONTS.includes(face), `通用字体版的 ea 不是保底字体：${face}`);
    assert.ok(eas.has("Microsoft YaHei"));
  });
});

describe("4:3 的 pptx 读回与画布一致", () => {
  it("版式页从 16:9 切到 4:3 后导出：每个形状都在 10×7.5 英寸的页内，位置宽度与画布元素一一对上", async () => {
    let deck = createDeck({ title: "切画幅", theme: presetTheme("night") });
    const slots: Record<string, Record<string, unknown>> = {
      bullets: { title: "概况", bullets: ["面积约 735 平方公里", "四种官方语言并行"] },
      "two-column": { title: "对比", columns: [{ heading: "甲", bullets: ["a", "b"] }, { heading: "乙", bullets: ["c", "d"] }] },
      table: { title: "语言", rows: [["语言", "占比"], ["英语", "48%"]] },
      stat: { title: "数字", stats: [{ value: "735", label: "平方公里" }, { value: "47%", label: "绿化率" }, { value: "600万", label: "人口" }] },
    };
    for (const [layout, slot] of Object.entries(slots)) deck = applyWrite(deck, [{ layout: layout as "bullets", slots: slot }]).deck;
    deck = applyEdit(deck, [{ op: "set_deck", aspect: "4:3" }]).deck;
    const zip = await unzip(await buildPptx(deck, { basicFonts: false, assets: new Map() }));
    const PAGE_W = 9144000;
    const emu = (px: number): number => Math.round((px / 96) * 914400);
    for (let n = 1; n <= deck.slides.length; n += 1) {
      const xml = await text(zip, `ppt/slides/slide${n}.xml`);
      const boxes = [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => ({ x: Number(m[1]), w: Number(m[3]) }));
      assert.ok(boxes.length > 0);
      for (const box of boxes) assert.ok(box.x >= 0 && box.x + box.w <= PAGE_W + 1000, `第 ${n} 页形状伸出页面：x=${box.x} w=${box.w}`);
      // 画布上的文字 / 形状元素的 x、w 都能在 pptx 里找到（±1 EMU 级取整）
      for (const el of deck.slides[n - 1]!.elements.filter((e) => e.kind === "text" || e.kind === "shape")) {
        const hit = boxes.some((box) => Math.abs(box.x - emu(el.x)) <= 2000 && Math.abs(box.w - emu(el.w)) <= 2000);
        assert.ok(hit, `第 ${n} 页 ${el.kind} x=${el.x} w=${el.w} 在 pptx 里找不到`);
      }
    }
  });
});
