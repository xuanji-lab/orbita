import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLACKHOLE_STEP_PX } from "./blackhole-layout.ts";
import { TETRIS_SHAPES, tetrisGeometry, tetrisKeyOf, tetrisSpan } from "./tetris-geometry.ts";

/**
 * 俄罗斯方块形态的形状几何：分族 → 形状映射、mw 随名字伸缩与上限、名字与凸块的
 * 拆分、外轮廓与接缝。几何是纯函数——这些断言同时钉住「已发送消息的快照只凭
 * 附件清单重算出同一块」的前提。
 */

const geo = (kind: "image" | "file" | "dir", name: string, columns = 22) =>
  tetrisGeometry({ kind, name, columns });

describe("tetrisKeyOf：分族 → 形状（复用 fileIcon，不另造一套）", () => {
  it("线性内容是 I：文本 / 文档 / PDF / 音视频 / 未知文件", () => {
    for (const name of ["README.md", "notes.txt", "orbita-roadmap.docx", "design-review.pdf", "demo.mp4", "voice-memo.m4a", "makefile-stuff.dat"]) {
      assert.equal(tetrisKeyOf("file", name), "I", name);
    }
  });

  it("画幅与网格是 O：图片文件与表格；截图材料也是 O（横幅）", () => {
    assert.equal(tetrisKeyOf("file", "photo.png"), "O");
    assert.equal(tetrisKeyOf("file", "Q3 营收预测.xlsx"), "O");
    assert.equal(tetrisKeyOf("image", "截图.png"), "O");
  });

  it("演示是 T；代码与网页是 S；配置是 Z；目录是 J；压缩包是 L", () => {
    assert.equal(tetrisKeyOf("file", "发布会.pptx"), "T");
    assert.equal(tetrisKeyOf("file", "BlackholeBox.tsx"), "S");
    assert.equal(tetrisKeyOf("file", "index.html"), "S");
    assert.equal(tetrisKeyOf("file", "package.json"), "Z");
    assert.equal(tetrisKeyOf("file", ".gitignore"), "Z");
    assert.equal(tetrisKeyOf("file", "Makefile"), "Z");
    assert.equal(tetrisKeyOf("dir", "src"), "J");
    assert.equal(tetrisKeyOf("file", "logs.tar.gz"), "L");
  });

  it("三色族跟着 fileIconTone：doc 蓝 / slides 橙 / sheet 绿，其余中性", () => {
    assert.equal(geo("file", "a.docx").tone, "doc");
    assert.equal(geo("file", "a.pptx").tone, "slides");
    assert.equal(geo("file", "a.xlsx").tone, "sheet");
    assert.equal(geo("file", "a.md").tone, null);
    assert.equal(geo("file", "a.pdf").tone, null);
    assert.equal(geo("dir", "src").tone, null);
  });

  it("图标沿用 fileIcon：目录是 folder，其余按扩展名", () => {
    assert.equal(geo("dir", "src").icon, "folder");
    assert.equal(geo("file", "a.ts").icon, "file-code-2");
    assert.equal(geo("file", "a.docx").icon, "book");
  });
});

describe("tetrisGeometry：名字与形状怎么配", () => {
  it("拓扑固定：mw=1 时外接尺寸 = 形状定义的格数", () => {
    const g = geo("file", "a.ts");
    assert.equal(g.mw, 1);
    assert.equal(g.key, "S");
    assert.equal(g.cols, 3);
    assert.equal(g.rows, 2);
  });

  it("mw 随名字伸缩：长名字的 I 块更宽，整块不超过半个盒宽", () => {
    const short = geo("file", "a.md");
    const long = geo("file", "quarterly-report-final-v3-reviewed-by-legal.md");
    assert.ok(long.mw > short.mw);
    assert.ok(long.cols <= Math.floor(22 / 2));
    assert.equal(long.cols, long.mw * 4);
    // 盒子更窄时上限跟着收
    const narrow = geo("file", "quarterly-report-final-v3-reviewed-by-legal.md", 10);
    assert.ok(narrow.cols <= Math.floor(10 / 2));
  });

  it("非 I 块把扩展名挪进凸块：stem 去扩展名、nubText 大写、有 nubRect", () => {
    const g = geo("file", "发布会-终稿.pptx");
    assert.equal(g.stem, "发布会-终稿");
    assert.equal(g.nubText, "PPTX");
    assert.equal(g.meta, "");
    assert.ok(g.nubRect !== null);
    assert.ok(g.nubRect.width >= g.nubText.length * 6);
    // 凸块宽度装得下扩展名（估宽口径）：mw 至少被它撑起来
    assert.ok(g.mw >= 2);
  });

  it("凸块装得下扩展名所需：mw 的下限由凸块那一横反推", () => {
    // L 的凸块只有一格宽（耳朵），ZIP 三个字符至少要 1 格多 → mw ≥ 2
    const g = geo("file", "logs.zip");
    assert.ok(g.mw >= 2, `mw=${g.mw}`);
    assert.ok((g.nubRect?.width ?? 0) >= 3 * 6);
  });

  it("I 块扩展名留在名字行末尾：meta=.ext、没有凸块", () => {
    const g = geo("file", "orbita-roadmap.docx");
    assert.equal(g.key, "I");
    assert.equal(g.stem, "orbita-roadmap");
    assert.equal(g.meta, ".docx");
    assert.equal(g.nubText, "");
    assert.equal(g.nubRect, null);
  });

  it("目录是 J：stem 是原名（尾 / 由渲染层补），凸块留空（子项数这版拿不到）", () => {
    const g = geo("dir", "src");
    assert.equal(g.key, "J");
    assert.equal(g.stem, "src");
    assert.equal(g.nubText, "");
    assert.equal(g.nubRect, null);
  });

  it("截图是固定 4×2 横幅：mw=2、不显示名字（labelRect 为 null）", () => {
    const g = geo("image", "截图 2026-10-12 17.20.png");
    assert.equal(g.banner, true);
    assert.equal(g.mw, 2);
    assert.equal(g.cols, 4);
    assert.equal(g.rows, 2);
    assert.equal(g.labelRect, null);
  });

  it("图片文件引用是普通 O 块：有名字行，PNG 进凸块", () => {
    const g = geo("file", "photo.png");
    assert.equal(g.banner, false);
    assert.equal(g.key, "O");
    assert.ok(g.labelRect !== null);
    assert.equal(g.nubText, "PNG");
  });

  it("没有扩展名的文件不拆名字（makefile / 点文件归 Z 族）", () => {
    assert.equal(geo("file", "Makefile").stem, "Makefile");
    assert.equal(geo("file", ".gitignore").stem, ".gitignore");
    assert.equal(geo("file", ".gitignore").nubText, "");
  });

  it("「未复制」的额外宽度会把名字行撑宽", () => {
    const plain = tetrisGeometry({ kind: "file", name: "notes.md", columns: 22 });
    const wide = tetrisGeometry({ kind: "file", name: "notes.md", columns: 22, extraPx: 80 });
    assert.ok(wide.mw >= plain.mw);
  });

  it("超窄盒：块压不进盒宽时收 mw、再不行砍右边的格子，不崩", () => {
    const g = geo("file", "a.ts", 3); // S 块 3 格宽 × mw=1 正好压满
    assert.ok(g.cols <= 3);
    const tinier = geo("file", "a.ts", 2); // 只剩 2 列：砍掉最右格
    assert.ok(tinier.cols <= 2);
    assert.ok(tinier.footprint.every(([cx]) => cx < 2));
    const image = geo("image", "shot.png", 3); // 横幅收成 2×2
    assert.ok(image.cols <= 3);
  });
});

describe("tetrisGeometry：脚印与渲染几何", () => {
  it("脚印行从盒底数：形状定义从上数，两者关于水平中线镜像", () => {
    const g = geo("file", "a.ts"); // S：从上数 [[1,0],[2,0],[0,1],[1,1]]
    const fromBottom = new Set(g.footprint.map(([cx, cy]) => `${cx},${cy}`));
    for (const [cx, cy] of TETRIS_SHAPES.S.cells) {
      assert.ok(fromBottom.has(`${cx},${g.rows - 1 - cy}`), `${cx},${cy} 没映到脚印`);
    }
    // 脚印展开到 mw 列宽：mw=1 时格数 = 形状格数
    assert.equal(g.footprint.length, 4);
  });

  it("外接尺寸 = cols × rows 步进；名字行在 labelRow 那一横（只跨那一横的格子）", () => {
    const g = geo("file", "a.ts");
    const step = BLACKHOLE_STEP_PX;
    // S 的名字行是底行，那一横 2 格：宽 = 2 × mw × 步进 - 间距
    assert.equal(g.labelRect?.width, 2 * g.mw * step - 4);
    assert.equal(g.labelRect?.height, step - 4);
    assert.equal(g.labelRect?.top, g.labelRow * step + 2);
    // S 的名字行是底行（labelRow=1），凸块在顶行
    assert.equal(g.labelRow, 1);
    assert.ok((g.nubRect?.top ?? -1) < g.labelRect.top);
  });

  it("外轮廓是闭合路径：M 开头 Z 结尾、无 NaN，同输入同结果（七种形状都过一遍）", () => {
    const cases: { key: "I" | "O" | "T" | "S" | "Z" | "J" | "L"; kind: "file" | "dir"; name: string }[] = [
      { key: "I", kind: "file", name: "quarterly-report-final-v3-reviewed-by-legal.md" },
      { key: "O", kind: "file", name: "quarterly-report-final-v3-reviewed-by-legal-by-finance.xlsx" },
      { key: "T", kind: "file", name: "发布会-终稿-给老板看的那一版.pptx" },
      { key: "S", kind: "file", name: "BlackholeBox.tsx" },
      { key: "Z", kind: "file", name: "electron-builder.json" },
      { key: "J", kind: "dir", name: "design-system" },
      { key: "L", kind: "file", name: "release-0.9.3-mac-arm64.zip" },
    ];
    for (const c of cases) {
      const g = geo(c.kind, c.name);
      assert.equal(g.key, c.key, `${c.name} 没落到 ${c.key}`);
      assert.ok(g.outline.startsWith("M"), `${c.key} 轮廓不是 M 开头`);
      assert.ok(g.outline.endsWith("Z"), `${c.key} 轮廓没闭合`);
      assert.ok(!g.outline.includes("NaN"), `${c.key} 轮廓有 NaN`);
      assert.equal(g.outline, geo(c.kind, c.name).outline);
    }
  });

  it("接缝：带文字的那一横（名字行 / 放了扩展名的凸块行）内部没有竖向接缝；行与行之间有横向接缝", () => {
    const g = geo("file", "quarterly-report-final-v3-reviewed-by-legal.md"); // I：名字行是唯一的一横
    assert.equal(g.seams.filter((s) => s.x1 !== s.x2).length, 0);
    // O（xlsx）：两横都有文字（名字 + XLSX 凸块）→ 一条竖缝都没有，横向接缝照常
    // （2026-10-12 验收：接缝曾从「XL¦SX」中间穿过去）
    const sheet = geo("file", "quarterly-report-final-v3-reviewed-by-legal-by-finance.xlsx");
    assert.equal(sheet.seams.filter((s) => s.x1 === s.x2).length, 0);
    assert.ok(sheet.seams.filter((s) => s.y1 === s.y2).length >= 1);
    // Z（json）：凸块行放 JSON，名字行在底 → 顶行那一道竖缝也被略过
    const z = geo("file", "package.json");
    assert.equal(z.seams.filter((s) => s.x1 === s.x2).length, 0);
    assert.ok(z.seams.filter((s) => s.y1 === s.y2).length >= 1);
  });

  it("凸块空着的行（无扩展名的 Z / 目录）照常画竖向接缝", () => {
    // Makefile 归 Z 族但没有扩展名：凸块空 → 顶行两格之间照常一道竖缝
    const bare = geo("file", "Makefile");
    assert.equal(bare.key, "Z");
    assert.equal(bare.nubText, "");
    assert.equal(bare.seams.filter((s) => s.x1 === s.x2).length, 1);
  });

  it("tetrisSpan：脚印与外接框都交给落位层", () => {
    const g = geo("file", "a.ts");
    const span = tetrisSpan(g);
    assert.equal(span.shape, "S");
    assert.equal(span.col, g.cols);
    assert.equal(span.row, g.rows);
    assert.equal(span.cells, g.footprint);
  });

  it("rotation 只接受 0（这一版不旋转，参数是给以后留的扩展口）", () => {
    const g = tetrisGeometry({ kind: "file", name: "a.ts", columns: 22, rotation: 0 });
    assert.equal(g.key, "S");
  });
});
