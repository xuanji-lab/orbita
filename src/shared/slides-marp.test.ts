import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectMarpImages, marpToDeck } from "./slides-marp.ts";
import { richTextToPlain } from "./slides.ts";

const md = `---
marp: true
---
# 花园城市

- 自然
- **美食**

---
## 小贩中心

| 菜 | 价格 |
|---|---|
| 鸡饭 | 4.5 |

![hawker](hawker.png)

---
::: columns
左栏文字
+++
右栏文字
:::
`;

describe("marpToDeck", () => {
  const images = new Map([["hawker.png", { src: "d.assets/hawker.png", width: 800, height: 600 }]]);
  const deck = marpToDeck(md, "T", images);

  it("三页：标题 / 列表 / 表格 / 图片 / 并排栏都成元素", () => {
    assert.equal(deck.slides.length, 3);
    const s1 = deck.slides[0]?.elements ?? [];
    assert.equal(s1[0]?.kind === "text" && richTextToPlain(s1[0].html), "花园城市");
    const list = s1[1];
    assert.ok(list?.kind === "text" && list.html.includes("<ul>") && list.html.includes("<b>美食</b>"));
    const s2 = deck.slides[1]?.elements ?? [];
    assert.ok(s2.some((e) => e.kind === "table" && e.rows[1]?.[0] === "鸡饭"));
    const img = s2.find((e) => e.kind === "image");
    assert.ok(img?.kind === "image" && img.src === "d.assets/hawker.png" && img.x > 600, "有图的页：图放右侧");
    const s3 = deck.slides[2]?.elements ?? [];
    assert.equal(s3.length, 2);
    assert.ok(s3[1] !== undefined && s3[0] !== undefined && s3[1].x > s3[0].x);
  });

  it("找不到的图留一行说明，不悄悄丢", () => {
    const missing = marpToDeck("# a\n\n![x](nope.png)", "T");
    assert.ok(missing.slides[0]?.elements.some((e) => e.kind === "text" && richTextToPlain(e.html).includes("nope.png")));
  });

  it("collectMarpImages 只收本地图片", () => {
    assert.deepEqual(collectMarpImages("![a](x.png)\n![b](https://e.com/y.png)\n![c](data:image/png;base64,AA)"), ["x.png"]);
  });

  it("空文稿也给一页空白", () => {
    assert.equal(marpToDeck("", "T").slides.length, 1);
  });
});
