import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdit, applyTheme, applyWrite, createDeck, lintSlide, newDrawnElement, newTableElement, patchElement, themeNewElement, updateElements, unbindChanged } from "./slides-ops.ts";
import { CANVAS_SIZE, ElementError, normalizeElement, normalizeTheme, parseDeck, serializeDeck, type Deck, type SlideElement, type TextElement } from "./slides.ts";
import { footerElement } from "./slides-footer.ts";
import { buildLayout, LAYOUT_NAMES, type LayoutImage } from "./slides-layouts.ts";
import { countLines, visualLength } from "./slides-measure.ts";
import { THEME_IDS, presetTheme, resolveTheme } from "./slides-theme.ts";

const image: LayoutImage = { src: "d.assets/a.png", width: 1200, height: 1600 };

function sample(layout: (typeof LAYOUT_NAMES)[number]): Record<string, unknown> {
  switch (layout) {
    case "cover":
      return { eyebrow: "CITY STUDY", title: "新加坡：花园里的城市", subtitle: "一座小岛如何把绿色织进高密度生活", meta: "研究组 · 2026" };
    case "section":
      return { number: "02", title: "城市治理", subtitle: "规划与长期主义" };
    case "bullets":
      return { eyebrow: "01 · 概况", title: "一座城市国家", bullets: ["面积约 735 平方公里", "四种官方语言并行", "全球重要的港口"] };
    case "two-column":
      return { title: "优势与挑战", columns: [{ heading: "优势", bullets: ["规划连续", "公共住房"] }, { heading: "挑战", bullets: ["土地有限", "老龄化"] }] };
    case "image-left":
    case "image-right":
      return { title: "花园城市", bullets: ["滨海湾花园", "立体绿化"], image: "x" };
    case "image-full":
      return { title: "滨海湾的黄昏", caption: "超级树在日落后点亮", image: "x" };
    case "table":
      return { title: "官方语言", rows: [["语言", "占比"], ["英语", "48%"], ["华语", "30%"]], note: "来源：统计局" };
    case "quote":
      return { quote: "我们没有资源，所以必须把每一寸土地都用到极致。", source: "某人" };
    case "stat":
      return { title: "数字", stats: [{ value: "735", label: "平方公里" }, { value: "47%", label: "绿化率" }] };
    case "closing":
      return { title: "谢谢观看", subtitle: "欢迎提问", contact: ["a@b.org"] };
  }
}

function themed(id: string, aspect: "16:9" | "4:3" = "16:9"): Deck {
  return { ...createDeck({ title: "测试稿", aspect, theme: presetTheme(id) }), slides: [] };
}

describe("主题 token", () => {
  it("$token 解析成具体值落盘并记绑定；写错的 token 报 ElementError", () => {
    const deck = themed("forest");
    const element = normalizeElement({ kind: "text", html: "x", color: "$accent", fontSize: "$title", fontFamily: "$heading" }, { canvas: CANVAS_SIZE["16:9"], theme: deck.theme }) as TextElement;
    const theme = resolveTheme(deck.theme);
    assert.equal(element.color, theme.palette.accent);
    assert.equal(element.fontSize, theme.scale.title);
    assert.equal(element.fontFamily, theme.fonts.heading);
    assert.deepEqual(element.bind, { color: "accent", fontSize: "title", fontFamily: "heading" });
    assert.throws(() => normalizeElement({ kind: "text", html: "x", color: "$nope" }, { canvas: CANVAS_SIZE["16:9"], theme: deck.theme }), ElementError);
    assert.throws(() => normalizeElement({ kind: "text", html: "x", fontSize: "$accent" }, { canvas: CANVAS_SIZE["16:9"], theme: deck.theme }), ElementError);
  });

  it("换主题：绑定项整份跟着变，手改过的值保持不变（Q2）", () => {
    let deck = themed("forest");
    deck = applyWrite(deck, [{ layout: "bullets", slots: sample("bullets") }]).deck;
    const slide = deck.slides[0]!;
    const title = slide.elements.find((e): e is TextElement => e.kind === "text" && e.fontFamily !== undefined)!;
    // 用户把标题手改成红色（patch 具体色 = 拆掉 color 绑定）
    deck = applyEdit(deck, [{ op: "patch", slide: 1, id: title.id, patch: { color: "#ff0000" } }]).deck;
    const next = applyTheme(deck, presetTheme("ink"));
    const after = next.slides[0]!;
    const inkTheme = resolveTheme(presetTheme("ink"));
    const afterTitle = after.elements.find((e) => e.id === title.id) as TextElement;
    assert.equal(afterTitle.color, "#ff0000", "手改的颜色保持");
    assert.equal(afterTitle.bind?.color, undefined);
    assert.equal(afterTitle.fontSize, inkTheme.scale.title, "没手改的字号跟主题走");
    assert.equal(afterTitle.fontFamily, inkTheme.fonts.heading);
    assert.equal(after.background, inkTheme.palette.bg, "页背景跟着变");
    const body = after.elements.find((e): e is TextElement => e.kind === "text" && e.html.includes("<li>"))!;
    assert.equal(body.color, inkTheme.palette.ink);
    assert.equal(next.theme?.id, "ink");
  });

  it("编辑器改字号 / 颜色（updateElements）也拆绑定；只动位置不拆", () => {
    let deck = applyWrite(themed("mono"), [{ layout: "bullets", slots: sample("bullets") }]).deck;
    const body = deck.slides[0]!.elements.find((e): e is TextElement => e.kind === "text" && e.html.includes("<li>"))!;
    deck = updateElements(deck, deck.slides[0]!.id, (e) => ({ ...e, x: e.x + 10 }), new Set([body.id]));
    assert.ok((deck.slides[0]!.elements.find((e) => e.id === body.id) as TextElement).bind?.fontSize !== undefined);
    deck = updateElements(deck, deck.slides[0]!.id, (e) => ({ ...(e as TextElement), fontSize: 40 }), new Set([body.id]));
    const edited = deck.slides[0]!.elements.find((e) => e.id === body.id) as TextElement;
    assert.equal(edited.bind?.fontSize, undefined);
    assert.equal(edited.bind?.color, "ink");
    assert.equal(applyTheme(deck, presetTheme("night")).slides[0]!.elements.find((e) => e.id === body.id)!.id, body.id);
    assert.equal((applyTheme(deck, presetTheme("night")).slides[0]!.elements.find((e) => e.id === body.id) as TextElement).fontSize, 40);
    assert.equal(unbindChanged(body, body), body);
  });

  it("patch 里写 $token 重新绑定；文件往返（serialize → parse）保留绑定与具体值", () => {
    let deck = applyWrite(themed("warm"), [{ layout: "bullets", slots: sample("bullets") }]).deck;
    const body = deck.slides[0]!.elements.find((e): e is TextElement => e.kind === "text" && e.html.includes("<li>"))!;
    deck = applyEdit(deck, [{ op: "patch", slide: 1, id: body.id, patch: { color: "#123456" } }]).deck;
    deck = applyEdit(deck, [{ op: "patch", slide: 1, id: body.id, patch: { color: "$accent" } }]).deck;
    const reloaded = parseDeck(serializeDeck(deck)).deck;
    const again = reloaded.slides[0]!.elements.find((e) => e.id === body.id) as TextElement;
    assert.equal(again.bind?.color, "accent");
    assert.equal(again.color, resolveTheme(deck.theme).palette.accent);
    assert.deepEqual(reloaded, deck);
  });

  it("主题规整：字符串 id、局部覆盖、老三字段写法", () => {
    assert.equal(normalizeTheme("Night")?.id, "night");
    assert.equal(normalizeTheme("nope"), undefined);
    const custom = normalizeTheme({ id: "mono", palette: { accent: "#0a7c3a" } });
    assert.equal(custom?.palette?.accent, "#0a7c3a");
    assert.equal(custom?.palette?.bg, "#ffffff");
    assert.equal(custom?.background, "#ffffff", "旧字段由色板派生");
    assert.deepEqual(normalizeTheme({ color: "#111111", background: "#fafafa" }), { color: "#111111", background: "#fafafa" });
  });
});

describe("用户新建的元素也跟主题", () => {
  it("带色板的文稿里新建文字 / 形状 / 表格 / 线绑定主题，换主题后颜色跟着变；老文稿保持原样", () => {
    const deck = themed("night");
    const box = { x: 10, y: 10, w: 100, h: 60 };
    const text = themeNewElement(deck, newDrawnElement("text", box, "#000000", true)) as TextElement;
    assert.equal(text.bind?.color, "ink");
    assert.equal(text.color, resolveTheme(deck.theme).palette.ink);
    const table = newTableElement(deck);
    assert.equal(table.kind === "table" && table.bind?.headerFill, "accent");
    const withText = { ...deck, slides: [{ id: "s", elements: [text] }] };
    const after = applyTheme(withText, presetTheme("ink")).slides[0]!.elements[0] as TextElement;
    assert.equal(after.color, resolveTheme(presetTheme("ink")).palette.ink);
    const legacy = createDeck({ title: "老稿" });
    const plain = newDrawnElement("text", box, "#111111", true);
    assert.equal(themeNewElement(legacy, plain), plain);
  });
});

describe("版式", () => {
  for (const id of THEME_IDS) {
    for (const aspect of ["16:9", "4:3"] as const) {
      it(`${id} · ${aspect}：全部版式都能落成合法元素，字号不小于 body，文字元素不出画布`, () => {
        const theme = resolveTheme(presetTheme(id));
        const canvas = CANVAS_SIZE[aspect];
        let deck = themed(id, aspect);
        for (const layout of LAYOUT_NAMES) {
          const images = { image };
          const out = applyWrite(deck, [{ layout, slots: sample(layout), images }]);
          deck = out.deck;
          const page = deck.slides.length;
          assert.deepEqual(out.warnings, [], `${layout}: ${out.warnings.join(" | ")}`);
          assert.deepEqual(lintSlide(deck, page), [], `${layout} lint`);
          const slide = deck.slides[page - 1]!;
          assert.equal(slide.layout, layout);
          for (const el of slide.elements) {
            if (el.kind === "text") {
              const isCaption = el.bind?.fontSize === "caption";
              assert.ok(isCaption || el.fontSize >= theme.scale.body, `${layout}: 文字 ${el.fontSize} < body ${theme.scale.body}`);
              assert.ok(el.x >= 0 && el.x + el.w <= canvas.w + 1 && el.y >= 0 && el.y + el.h <= canvas.h + 1, `${layout}: 文字元素出画布 ${el.x},${el.y},${el.w},${el.h}`);
            }
          }
        }
      });
    }
  }

  it("工具描述里的上限会出 warning：标题太长、条目太多、条目太长", () => {
    const out = applyWrite(themed("ink"), [
      { layout: "bullets", slots: { title: "这是一个非常非常非常长的标题，远远超过十六个字", bullets: ["一", "二", "三", "四", "五", "六", "七", "八"] } },
      { layout: "bullets", slots: { title: "短标题", bullets: ["这一条要点写得特别特别特别特别特别特别长，超过二十个字"] } },
    ]);
    const text = out.warnings.join("\n");
    assert.match(text, /title is \d+ characters long/);
    assert.match(text, /8 bullets/);
    assert.match(text, /bullet 1 is \d+ characters/);
  });

  it("标题装不下沿字号阶梯退（绑定到更小的 token），正文装不下不缩字、给拆页警告", () => {
    const longTitle = "关于城市绿化与高密度居住之间长期关系的一些想法与总结，以及对未来二十年的几点判断";
    const built = buildLayout({ layout: "cover", slots: { title: longTitle }, aspect: "16:9", theme: presetTheme("ink") }, "slide 1");
    const title = built.elements.find((e) => e["fontFamily"] === "$heading")!;
    assert.ok(["$title", "$h2"].includes(title["fontSize"] as string), `封面标题退档：${String(title["fontSize"])}`);
    const many = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条要点写得比较长，需要折成两行才放得下它`);
    const body = buildLayout({ layout: "two-column", slots: { title: "对比", columns: [{ heading: "甲", bullets: many }, { heading: "乙", bullets: many }] }, aspect: "4:3", theme: presetTheme("ink") }, "slide 2");
    assert.match(body.warnings.join("\n"), /never shrunk below the theme's body size/);
    for (const el of body.elements) if (el["kind"] === "text" && el["html"] !== undefined) assert.notEqual(el["fontSize"], "$caption-tiny");
  });

  it("缺必填槽位 / 版式与 elements 并给 / 未知版式 → 报错；未知槽位 → 警告", () => {
    assert.throws(() => applyWrite(themed("ink"), [{ layout: "bullets", slots: { bullets: ["a"] } }]), /missing required slot "title"/);
    assert.throws(() => applyWrite(themed("ink"), [{ layout: "bullets", slots: sample("bullets"), elements: [] }]), /either layout/);
    assert.throws(() => applyWrite(themed("ink"), [{ layout: "poster", slots: {} }]), /unknown layout/);
    assert.throws(() => applyWrite(themed("ink"), [{ layout: "table", slots: { title: "x" } }]), /needs slots.rows/);
    const warned = applyWrite(themed("ink"), [{ layout: "bullets", slots: { ...sample("bullets"), colour: "red" } }]);
    assert.match(warned.warnings.join("\n"), /ignored unknown slot\(s\) colour/);
  });

  it("没有主题的老文稿第一次写版式页时补默认主题；缺图时画占位并警告", () => {
    const legacy = { ...createDeck({ title: "老稿" }), slides: [] };
    assert.equal(legacy.theme, undefined);
    const out = applyWrite(legacy, [{ layout: "image-right", slots: { title: "图文", bullets: ["a"], image: "x" } }]);
    assert.equal(out.deck.theme?.id, "ink");
    assert.match(out.warnings.join("\n"), /no picture was given/);
  });

  it("只改备注不丢版式名；整页换成手写元素则版式名作废", () => {
    let deck = applyWrite(themed("ink"), [{ layout: "bullets", slots: sample("bullets") }]).deck;
    deck = applyWrite(deck, [{ at: 1, notes: "讲稿" }]).deck;
    assert.equal(deck.slides[0]!.layout, "bullets");
    assert.equal(deck.slides[0]!.bind?.background, "bg");
    deck = applyWrite(deck, [{ at: 1, elements: [{ kind: "text", html: "手写" }] }]).deck;
    assert.equal(deck.slides[0]!.layout, undefined);
  });
});

describe("stat 版式", () => {
  it("几个大数字用同一个字号（取装得下的最小档），4:3 窄列里「600万」不被裁", () => {
    const built = buildLayout({ layout: "stat", slots: { title: "数字", stats: [{ value: "735", label: "a" }, { value: "47%", label: "b" }, { value: "600万", label: "c" }] }, aspect: "4:3", theme: presetTheme("forest") }, "slide 1");
    const sizes = built.elements.filter((e) => e["fontFamily"] === "$heading" && e["fontSize"] !== "$title" ? true : e["fontFamily"] === "$heading").map((e) => e["fontSize"]);
    // 第一个 heading 字体的是页标题（$title），其后三个数字同字号
    const valueSizes = sizes.slice(1);
    assert.equal(valueSizes.length, 3);
    assert.equal(new Set(valueSizes).size, 1, `大数字字号不一致：${valueSizes.join(",")}`);
  });
});

describe("体检：自由元素不许比 body 小、不许压页脚", () => {
  it("带主题的文稿里手加的 16px 来源行、压在页脚上的字都会被指出；脚注 caption 档与版式生成的不报", () => {
    let deck = applyWrite(themed("academic"), [{ layout: "stat", slots: sample("stat") }]).deck;
    assert.deepEqual(lintSlide(deck, 1), []);
    deck = applyEdit(deck, [
      { op: "add", slide: 1, element: { kind: "text", html: "数据来源：IMF", x: 340, y: 640, w: 600, h: 40, fontSize: 16 } },
      { op: "add", slide: 1, element: { kind: "text", html: "脚注", x: 96, y: 580, w: 600, h: 30, fontSize: "$caption" } },
    ]).deck;
    const issues = lintSlide(deck, 1);
    assert.equal(issues.filter((i) => /smaller than the theme's body size/.test(i)).length, 1);
    assert.equal(issues.filter((i) => /overlaps the page footer/.test(i)).length, 1);
  });
});

describe("页脚", () => {
  it("带色板的文稿每页画「标题 · 页码」，封面 / 结尾 / 满版图不画，左图版式放右下；老文稿不画", () => {
    let deck = themed("academic");
    deck = applyWrite(deck, ["cover", "bullets", "image-left", "image-full", "closing"].map((layout) => ({ layout, slots: sample(layout as (typeof LAYOUT_NAMES)[number]), images: { image } }))).deck;
    const feet = deck.slides.map((slide, i) => footerElement(deck, slide, i));
    assert.equal(feet[0], null);
    assert.match(feet[1]!.html, /测试稿\s+·\s+2/);
    assert.equal(feet[2]!.align, "right");
    assert.equal(feet[3], null);
    assert.equal(feet[4], null);
    const legacy = { ...createDeck({ title: "老稿" }), slides: [{ id: "s", elements: [] }] };
    assert.equal(footerElement(legacy, legacy.slides[0]!, 0), null);
    assert.equal(footerElement({ ...deck, theme: { ...deck.theme!, footer: false } }, deck.slides[1]!, 1), null);
  });
});

describe("文字估算（keep-all 标题折行）", () => {
  it("标题档（≥36px）只在标点处断行：长从句整段挪到下一行再硬断", () => {
    const quote = "我们没有资源，所以必须把每一寸土地都用到极致。";
    assert.equal(countLines(quote, 76, 1032), 3);
    assert.equal(countLines(quote, 28, 1032), 1, "正文档任意处可断");
    assert.ok(visualLength("Singapore") < 6);
  });
});

describe("元素类型守卫", () => {
  it("patchElement 不能改 kind / id", () => {
    const deck = applyWrite(themed("ink"), [{ layout: "bullets", slots: sample("bullets") }]).deck;
    const el: SlideElement = deck.slides[0]!.elements[0]!;
    assert.throws(() => patchElement(deck, el, { kind: "image" }), /不能改/);
  });
});
