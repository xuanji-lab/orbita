import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLACKHOLE_GAP_PX,
  BLACKHOLE_SAFE_PX,
  BLACKHOLE_STEP_PX,
  EMPTY_LEDGER,
  blackholeSeedKey,
  enqueueByRank,
  fallStartAt,
  isSupported,
  materialBoxStyle,
  reconcileLedger,
  releaseInto,
  supportersOf,
  type BlackholeDropMode,
  type BlackholeLedger,
  blackholeSpan,
  boxHeightCap,
  cellsToPx,
  columnsForWidth,
  dropOne,
  packedExtent,
  packPlacements,
  settleAfterRemoval,
  type BlackholePlacement,
} from "./blackhole-layout.ts";

/** 两块是否占了同一格 */
function overlaps(a: BlackholePlacement, b: BlackholePlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(placed: readonly BlackholePlacement[]): void {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a === undefined || b === undefined) continue;
      assert.equal(overlaps(a, b), false, `第 ${i} 块与第 ${j} 块重叠：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
}

/** 每块都落在某块之上或盒底：重力下不该有悬空的块 */
function assertSupported(placed: readonly BlackholePlacement[]): void {
  for (const p of placed) {
    if (p.y === 0) continue;
    const below = placed.some((q) => q !== p && q.y + q.h === p.y && q.x < p.x + p.w && p.x < q.x + q.w);
    assert.ok(below, `悬空的块：${JSON.stringify(p)}`);
  }
}

describe("blackholeSpan：三种形状", () => {
  it("截图是 2×2 正方形", () => {
    assert.deepEqual(blackholeSpan("image", "截图 2026-10-11.png", 22), { shape: "square", col: 2, row: 2 });
  });

  it("名字短是小胶囊（至少 3 列）", () => {
    assert.deepEqual(blackholeSpan("file", "a.ts", 22), { shape: "capsule", col: 3, row: 1 });
    const mid = blackholeSpan("dir", "renderer", 22);
    assert.equal(mid.shape, "capsule");
    assert.ok(mid.col >= 3 && mid.col <= 6);
  });

  it("名字长是长条，最多半个盒宽", () => {
    const name = "quarterly-report-final-v3-reviewed-by-legal.pdf";
    assert.deepEqual(blackholeSpan("file", name, 22), { shape: "strip", col: 11, row: 1 });
    assert.deepEqual(blackholeSpan("file", name, 16), { shape: "strip", col: 8, row: 1 });
    // 盒子很宽时按名字要的宽度走，不硬撑到半宽
    assert.deepEqual(blackholeSpan("file", name, 40), { shape: "strip", col: 12, row: 1 });
  });

  it("额外宽度（未复制标记）会把胶囊撑成长条", () => {
    assert.equal(blackholeSpan("file", "notes.md", 22).shape, "capsule");
    assert.equal(blackholeSpan("file", "notes.md", 22, 120).shape, "strip");
  });

  it("中文名按全宽估", () => {
    assert.ok(blackholeSpan("file", "季度设计说明文档.md", 22).col > blackholeSpan("file", "abcdefgh.md", 22).col);
  });
});

describe("columnsForWidth", () => {
  it("760px 的输入框是 22 列；再窄也至少 1 列", () => {
    assert.equal(columnsForWidth(760), 22);
    assert.equal(columnsForWidth(10), 1);
    assert.equal(columnsForWidth(0), 1);
  });
});

describe("packPlacements：重力落位", () => {
  it("空清单没有落位，盒子 0 高", () => {
    const placed = packPlacements([], 22);
    assert.deepEqual(placed, []);
    assert.deepEqual(packedExtent(placed), { cols: 0, rows: 0 });
    assert.equal(cellsToPx(0), 0);
  });

  it("单个材料落在盒底最左", () => {
    assert.deepEqual(packPlacements([{ col: 3, row: 1 }], 22), [{ x: 0, y: 0, w: 3, h: 1 }]);
  });

  it("正常路径：先铺满底行，再往上叠在最低处", () => {
    const placed = packPlacements(
      [
        { col: 5, row: 1 },
        { col: 2, row: 2 },
        { col: 4, row: 1 },
        { col: 11, row: 1 },
        { col: 5, row: 1 },
      ],
      22,
    );
    assert.deepEqual(placed, [
      { x: 0, y: 0, w: 5, h: 1 },
      { x: 5, y: 0, w: 2, h: 2 },
      { x: 7, y: 0, w: 4, h: 1 },
      { x: 11, y: 0, w: 11, h: 1 },
      { x: 0, y: 1, w: 5, h: 1 },
    ]);
    assert.deepEqual(packedExtent(placed), { cols: 22, rows: 2 });
  });

  it("不填悬空的洞：块停在它跨过的最高处之上", () => {
    // 4 列盒：先一个 1×2 立在第 0 列，再一个 4 列宽的长条只能架在它顶上
    const placed = packPlacements([{ col: 1, row: 2 }, { col: 4, row: 1 }], 4);
    assert.deepEqual(placed[1], { x: 0, y: 2, w: 4, h: 1 });
  });

  it("同一份清单永远算出同一个布局（发出去的消息靠它重算）", () => {
    const spans = [{ col: 3, row: 1 }, { col: 2, row: 2 }, { col: 6, row: 1 }, { col: 11, row: 1 }];
    assert.deepEqual(packPlacements(spans, 22), packPlacements(spans, 22));
  });

  it("比盒子还宽的块压到盒宽", () => {
    assert.deepEqual(packPlacements([{ col: 9, row: 1 }], 4), [{ x: 0, y: 0, w: 4, h: 1 }]);
  });

  it("很多材料（40 个）：全部有落点、不重叠、不悬空、都在盒内", () => {
    const names = [
      "a.ts",
      "design-notes.md",
      "renderer",
      "quarterly-report-final-v3-reviewed-by-legal.pdf",
      "Composer.tsx",
      "Orbita Design System",
      "README.md",
    ];
    const spans = Array.from({ length: 40 }, (_, i) =>
      i % 5 === 1 ? blackholeSpan("image", "shot.png", 22) : blackholeSpan(i % 3 === 0 ? "dir" : "file", names[i % names.length] ?? "x", 22),
    );
    const placed = packPlacements(spans, 22);
    assert.equal(placed.length, 40);
    for (const p of placed) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `没有落点：${JSON.stringify(p)}`);
      assert.ok(p.x >= 0 && p.x + p.w <= 22, `出了盒子：${JSON.stringify(p)}`);
      assert.ok(p.y >= 0);
    }
    assertNoOverlap(placed);
    assertSupported(placed);
    // 没有行数上限：40 个材料会堆过好几行
    assert.ok(packedExtent(placed).rows >= 5);
  });
});

describe("dropOne：往已有的堆上再掉一块", () => {
  it("与整份重排逐块一致（没删过东西时，活落位 = 清单落位）", () => {
    const spans = [{ col: 3, row: 1 }, { col: 2, row: 2 }, { col: 11, row: 1 }, { col: 5, row: 1 }];
    const live: BlackholePlacement[] = [];
    for (const span of spans) live.push(dropOne(live, span, 22));
    assert.deepEqual(live, packPlacements(spans, 22));
  });
});

describe("random 落位（俄罗斯方块）", () => {
  /** 混合清单：每块自带种子键（截图按组内序号、文件按路径——与两个消费者同一条公式） */
  const spans40 = Array.from({ length: 40 }, (_, i) => ({
    col: [3, 2, 6, 11, 5][i % 5] ?? 3,
    row: i % 5 === 1 ? 2 : 1,
    seed: i % 5 === 1 ? blackholeSeedKey({ kind: "image", index: Math.floor(i / 5) }) : blackholeSeedKey({ kind: "file", path: `/repo/src/file-${i}.ts` }),
  }));

  it("同一份清单永远算出同一个布局（种子确定，不碰 Math.random）", () => {
    assert.deepEqual(packPlacements(spans40, 22, "random"), packPlacements(spans40, 22, "random"));
    // 种子一变布局就变——证明随机数真的来自种子键
    const other = spans40.map((s, i) => ({ ...s, seed: `x${i}` }));
    assert.notDeepEqual(packPlacements(spans40, 22, "random"), packPlacements(other, 22, "random"));
  });

  it("后加一块不重排已落定的块：前 N 块的落位一字不动（种子只由每块自己决定）", () => {
    const before = packPlacements(spans40.slice(0, 25), 22, "random");
    const after = packPlacements(spans40, 22, "random");
    assert.deepEqual(after.slice(0, 25), before);
  });

  it("都在盒内、不重叠、不悬空；随机落位天然堆得比 lowest 高", () => {
    const placed = packPlacements(spans40, 22, "random");
    assert.equal(placed.length, 40);
    for (const p of placed) {
      assert.ok(p.x >= 0 && p.x + p.w <= 22, `出了盒子：${JSON.stringify(p)}`);
      assert.ok(p.y >= 0);
    }
    assertNoOverlap(placed);
    assertSupported(placed);
    // 纯随机不填低的洞，同样 40 块堆得比最低列位模式高——限高与盒内滚动因此更常触发
    assert.ok(packedExtent(placed).rows > packedExtent(packPlacements(spans40, 22, "lowest")).rows);
  });

  it("种子键：截图按组内序号、文件 / 目录按路径（两处消费者算出同一个键）", () => {
    assert.equal(blackholeSeedKey({ kind: "image", index: 3 }), blackholeSeedKey({ kind: "image", index: 3 }));
    assert.notEqual(blackholeSeedKey({ kind: "image", index: 3 }), blackholeSeedKey({ kind: "image", index: 4 }));
    assert.equal(blackholeSeedKey({ kind: "dir", path: "/a/b" }), "/a/b");
  });

  it("缺省模式不生变：不传 mode 时与 lowest 逐字相同（黑洞的现状）", () => {
    assert.deepEqual(packPlacements(spans40, 22), packPlacements(spans40, 22, "lowest"));
  });

  it("删除后的补位不重抽列位：random 模式也只往下掉，不往旁边挪", () => {
    const placed = packPlacements(spans40.slice(0, 24), 22, "random");
    const rest = placed.filter((_, i) => i % 3 !== 0);
    const settled = settleAfterRemoval(rest);
    settled.forEach((p, i) => assert.equal(p.x, rest[i]?.x));
    assertNoOverlap(settled);
    assertSupported(settled);
  });

  it("列数变了整盒重排：同样的清单 + 种子，重排也是确定的", () => {
    const ledger = { columns: 22, order: ["a", "b", "c"], map: new Map([["a", { x: 0, y: 0, w: 3, h: 1 }]]) } as const;
    const again = reconcileLedger(
      { ...ledger, map: new Map(ledger.map) } as BlackholeLedger,
      new Set(["a", "b", "c"]),
      16,
      (id) => ({ col: id === "a" ? 3 : 5, row: 1 }),
      "random",
      (id) => (id === "a" ? "/a" : id === "b" ? "/b" : "/c"),
    );
    const rePacked = packPlacements(
      ["a", "b", "c"].map((id) => ({ col: id === "a" ? 3 : 5, row: 1, seed: `/${id}` })),
      16,
      "random",
    );
    assert.deepEqual(Array.from(again.map.values()), rePacked);
  });
});

describe("settleAfterRemoval：删除后的重力补位", () => {
  it("抽掉底下一块，正上方的块直接掉下来，列位不动", () => {
    const placed = packPlacements(
      [
        { col: 11, row: 1 }, // 0：底行左半
        { col: 11, row: 1 }, // 1：底行右半
        { col: 5, row: 1 }, // 2：第二行最左，压在 0 上
      ],
      22,
    );
    assert.deepEqual(placed[2], { x: 0, y: 1, w: 5, h: 1 });
    const settled = settleAfterRemoval([placed[1], placed[2]].filter((p): p is BlackholePlacement => p !== undefined));
    assert.deepEqual(settled, [
      { x: 11, y: 0, w: 11, h: 1 },
      { x: 0, y: 0, w: 5, h: 1 },
    ]);
  });

  it("旁边的块不挪；架在两块上的块掉到剩下那块的高度", () => {
    // 4 列盒：0 = 第 0-1 列 1 行，1 = 第 2-3 列 2 行，2 = 横跨 4 列架在顶上（y=2）
    const placed = packPlacements([{ col: 2, row: 1 }, { col: 2, row: 2 }, { col: 4, row: 1 }], 4);
    assert.deepEqual(placed[2], { x: 0, y: 2, w: 4, h: 1 });
    // 抽掉 1（高的那块）：长条落到 0 的顶上
    const settled = settleAfterRemoval([placed[0], placed[2]].filter((p): p is BlackholePlacement => p !== undefined));
    assert.deepEqual(settled, [
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 0, y: 1, w: 4, h: 1 },
    ]);
  });

  it("删光了就是空", () => {
    assert.deepEqual(settleAfterRemoval([]), []);
  });

  it("补位后仍不重叠、不悬空", () => {
    const spans = Array.from({ length: 24 }, (_, i) => ({ col: (i % 4) + 2, row: i % 6 === 0 ? 2 : 1 }));
    const placed = packPlacements(spans, 22);
    const rest = placed.filter((_, i) => i % 3 !== 0);
    const settled = settleAfterRemoval(rest);
    assertNoOverlap(settled);
    assertSupported(settled);
    settled.forEach((p, i) => assert.equal(p.x, rest[i]?.x));
  });
});

describe("boxHeightCap：盒子限高", () => {
  it("舷窗到盒底的距离减去安全距离，再向下取整到整行", () => {
    // 700 - 160 = 540，540/34 = 15.9 行 → 15 整行（cellsToPx(15) = 15×34 - 4 = 506）
    assert.equal(boxHeightCap(700), cellsToPx(15));
    assert.equal(boxHeightCap(700), 506);
  });

  it("限高永远是整数行：可视窗口底边落在行间隙上，不把底行拦腰切断", () => {
    for (const space of [300, 401, 522, 643, 764, 999]) {
      const cap = boxHeightCap(space);
      assert.equal((cap + BLACKHOLE_GAP_PX) % BLACKHOLE_STEP_PX, 0, `space=${space} cap=${cap}`);
    }
  });

  it("窗口很矮时至少留两行格子", () => {
    assert.equal(boxHeightCap(100), cellsToPx(2));
    assert.equal(boxHeightCap(0), cellsToPx(2));
  });
});

describe("materialBoxStyle：材料盒形态的判定", () => {
  it("黑洞开着 + 浅 / 黛 / 玄 = 黑洞形态", () => {
    assert.equal(materialBoxStyle(true, false, "light"), "blackhole");
    assert.equal(materialBoxStyle(true, false, "graphite"), "blackhole");
    assert.equal(materialBoxStyle(true, false, "black"), "blackhole");
  });

  it("俄罗斯方块开着（黑洞关着）= tetris 形态", () => {
    assert.equal(materialBoxStyle(false, true, "light"), "tetris");
    assert.equal(materialBoxStyle(undefined, true, "graphite"), "tetris");
  });

  it("两个都开时黑洞优先（parseSettings 已兑底，这里再防一手）", () => {
    assert.equal(materialBoxStyle(true, true, "light"), "blackhole");
  });

  it("纸面主题即使开着也不启用（落块动效不叠在稿纸上，首版沿用黑洞的限制）", () => {
    assert.equal(materialBoxStyle(true, false, "copybook"), null);
    assert.equal(materialBoxStyle(false, true, "typescript"), null);
    assert.equal(materialBoxStyle(true, true, "copybook"), null);
  });

  it("都关着 / 缺席一律不启用", () => {
    assert.equal(materialBoxStyle(false, false, "light"), null);
    assert.equal(materialBoxStyle(undefined, undefined, "black"), null);
  });
});

// ── 放出流程：模拟逐块到达、逐块放出 ─────────────────────────────────────────

/** 可复现的伪随机（mulberry32） */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mat = { id: string; kind: "image" | "file" | "dir"; name: string; seed: string };
const NAMES = ["a.ts", "design-notes.md", "renderer", "quarterly-report-final-v3-reviewed-by-legal.pdf", "设计说明文档.md", "src", "README.md", "Orbita Design System", "x"];

function mixed(count: number, seed: number): Mat[] {
  const r = rng(seed);
  let images = 0;
  return Array.from({ length: count }, (_, i) => {
    const roll = r();
    const kind = roll < 0.3 ? "image" : roll < 0.55 ? "dir" : "file";
    // 种子键与真实消费者同源：截图按组内序号（追加序，与清单序一致）、文件按路径
    return {
      id: `m${i}`,
      kind,
      name: NAMES[Math.floor(r() * NAMES.length)] ?? "x",
      seed: kind === "image" ? blackholeSeedKey({ kind: "image", index: images++ }) : blackholeSeedKey({ kind: kind, path: `/repo/${i}/${NAMES[i % NAMES.length] ?? "x"}` }),
    };
  });
}

/** 输入框清单的顺序（composerMaterials）：截图在前，文件 / 目录在后，各自按到达先后 */
function listOrder(arrived: readonly Mat[]): string[] {
  return [...arrived.filter((m) => m.kind === "image"), ...arrived.filter((m) => m.kind !== "image")].map((m) => m.id);
}

/** 自由落体时长（与 BlackholeBox 同一个公式，重力 2600px/s²；负落程钳到 0——
 *  random 模式堆得高，块会落在起点线以上，不钳会出现 NaN 时长） */
const duration = (fromPx: number): number => Math.max(160, Math.sqrt((2 * Math.max(0, fromPx)) / 2600) * 1000);

/**
 * 模拟：材料按 `batches` 分批到达（每批吸入 680ms 后按清单顺序插队），队列每 110ms
 * 放出一块；每一步都断言新块被已放出的块或盒底托着、全盒没有悬空块，并按
 * fallStartAt 排起跳时刻、断言没有块先于托它的块落地。
 */
function simulate(
  batches: readonly (readonly Mat[])[],
  columns: number,
  arriveEveryMs: number,
  mode: BlackholeDropMode = "lowest",
) {
  const all = batches.flat();
  const byId = new Map(all.map((m) => [m.id, m]));
  const spanOf = (id: string) => {
    const m = byId.get(id);
    return blackholeSpan(m?.kind ?? "file", m?.name ?? "", columns);
  };
  const seedOf = (id: string): string => byId.get(id)?.seed ?? "";
  let ledger: BlackholeLedger = { ...EMPTY_LEDGER, columns };
  let queue: string[] = [];
  const arrived: Mat[] = [];
  const landAt = new Map<string, number>();
  const events: { at: number; batch: number }[] = batches.map((_, i) => ({ at: i * arriveEveryMs + 680, batch: i }));
  let clock = 0;
  let next = 0;
  while (next < events.length || queue.length > 0) {
    // 到点的批次入队（吸入结束）
    while (next < events.length && (events[next]?.at ?? Infinity) <= clock) {
      const batch = batches[events[next]?.batch ?? 0] ?? [];
      arrived.push(...batch);
      const order = listOrder(arrived);
      queue = enqueueByRank(queue, batch.map((m) => m.id), (id) => order.indexOf(id));
      next++;
    }
    const id = queue.shift();
    if (id === undefined) {
      clock = events[next]?.at ?? clock;
      continue;
    }
    ledger = releaseInto(ledger, id, spanOf(id), mode, seedOf(id));
    const p = ledger.map.get(id);
    assert.ok(p !== undefined);
    // 不变量 1：新块只踩已放出的块或盒底
    assert.ok(isSupported(p, ledger.map), `悬空放出：${id} ${JSON.stringify(p)}`);
    // 不变量 2：任何时刻全盒没有悬空块、没有重叠
    for (const [, q] of ledger.map) assert.ok(isSupported(q, ledger.map));
    assertNoOverlap(Array.from(ledger.map.values()));
    // 不变量 3：落地晚于托它的每一块
    const fromPx = 600 - p.y * BLACKHOLE_STEP_PX;
    const d = duration(fromPx);
    const start = fallStartAt(clock, d, supportersOf(p, ledger.map).map((sid) => landAt.get(sid) ?? 0));
    landAt.set(id, start + d);
    for (const sid of supportersOf(p, ledger.map)) {
      assert.ok((landAt.get(sid) ?? 0) < start + d, `${id} 先于托它的 ${sid} 落地`);
    }
    clock += 110;
  }
  return { ledger, arrived, spanOf, seedOf };
}

describe("放出流程：落点在放出那一刻只对已放出的块算", () => {
  it("混合截图 / 文件 / 目录 24 个、乱序分 5 批到达：每一步都有支撑、无悬空、无抢先落地", () => {
    const mats = mixed(24, 7);
    const shuffled = [...mats].reverse();
    const batches = [shuffled.slice(0, 3), shuffled.slice(3, 11), shuffled.slice(11, 12), shuffled.slice(12, 20), shuffled.slice(20)];
    const { ledger } = simulate(batches, 22, 300);
    assert.equal(ledger.order.length, 24);
  });

  it("40 个、批与批之间重叠（上一批还在放出时下一批到）：同样成立", () => {
    const mats = mixed(40, 11);
    const batches = Array.from({ length: 8 }, (_, i) => mats.slice(i * 5, i * 5 + 5));
    const { ledger } = simulate(batches, 22, 150);
    assert.equal(ledger.order.length, 40);
  });

  it("同一批里截图先落，文件 / 目录后落（用户 2026-10 原话：一起拖进来先让图片落）", () => {
    const mats = mixed(20, 3);
    const { ledger } = simulate([mats], 22, 0);
    const kinds = ledger.order.map((id) => mats.find((m) => m.id === id)?.kind);
    const firstFile = kinds.findIndex((k) => k !== "image");
    assert.ok(kinds.slice(firstFile).every((k) => k !== "image"), `截图没有全排在前面：${kinds.join(",")}`);
  });

  it("跨批次按到达顺序落：后到的截图不插到先到的文件前面", () => {
    const file: Mat = { id: "f", kind: "file", name: "a.ts", seed: blackholeSeedKey({ kind: "file", path: "/a.ts" }) };
    const image: Mat = { id: "i", kind: "image", name: "shot.png", seed: blackholeSeedKey({ kind: "image", index: 0 }) };
    const { ledger } = simulate([[file], [image]], 22, 2000);
    assert.deepEqual(ledger.order, ["f", "i"]);
  });

  it("单批到齐：发送后按清单重算的布局与发送前逐块一致", () => {
    const mats = mixed(26, 5);
    const { ledger, arrived, spanOf, seedOf } = simulate([mats], 22, 0);
    const order = listOrder(arrived);
    const resent = packPlacements(order.map((id) => ({ ...spanOf(id), seed: seedOf(id) })), 22);
    order.forEach((id, i) => assert.deepEqual(ledger.map.get(id), resent[i], `${id} 发送前后不一致`));
  });

  it("单批里分两拨进状态（文件先、截图晚几十毫秒）：插队后仍与清单重算一致", () => {
    const mats = mixed(22, 9);
    const files = mats.filter((m) => m.kind !== "image");
    const images = mats.filter((m) => m.kind === "image");
    // 两拨都在第一块放出前吸入完（吸入 560ms ≫ 截图解码的几十毫秒）
    const { ledger, arrived, spanOf, seedOf } = simulate([files, images], 22, 0);
    const order = listOrder(arrived);
    const resent = packPlacements(order.map((id) => ({ ...spanOf(id), seed: seedOf(id) })), 22);
    order.forEach((id, i) => assert.deepEqual(ledger.map.get(id), resent[i]));
  });

  it("random 模式：逐块放出也步步有支撑、无悬空，40 个分 8 批到齐", () => {
    const mats = mixed(40, 11);
    const batches = Array.from({ length: 8 }, (_, i) => mats.slice(i * 5, i * 5 + 5));
    const { ledger } = simulate(batches, 22, 150, "random");
    assert.equal(ledger.order.length, 40);
    for (const [, p] of ledger.map) assert.ok(isSupported(p, ledger.map));
    assertNoOverlap(Array.from(ledger.map.values()));
  });

  it("random 模式：单批到齐时发送前后仍逐块一致（种子只由每块自己决定）", () => {
    const mats = mixed(26, 5);
    const { ledger, arrived, spanOf, seedOf } = simulate([mats], 22, 0, "random");
    const order = listOrder(arrived);
    const resent = packPlacements(order.map((id) => ({ ...spanOf(id), seed: seedOf(id) })), 22, "random");
    order.forEach((id, i) => assert.deepEqual(ledger.map.get(id), resent[i], `${id} 发送前后不一致`));
  });
});

describe("删除后的连锁掉落（三层堆叠）", () => {
  // 8 列盒：
  //   第 0 层：A[0-1] B[2-3] C[4-5] D[6-7]
  //   第 1 层：E[0-1]（压 A）  F[2-5] 宽长条（压 B、C）  G[6-7]（压 D）
  //   第 2 层：H[0-3] 宽长条（压 E 与 F 的左半）  I[6-7]（压 G）
  const layers = (): BlackholeLedger => {
    const cells: [string, BlackholePlacement][] = [
      ["A", { x: 0, y: 0, w: 2, h: 1 }],
      ["B", { x: 2, y: 0, w: 2, h: 1 }],
      ["C", { x: 4, y: 0, w: 2, h: 1 }],
      ["D", { x: 6, y: 0, w: 2, h: 1 }],
      ["E", { x: 0, y: 1, w: 2, h: 1 }],
      ["F", { x: 2, y: 1, w: 4, h: 1 }],
      ["G", { x: 6, y: 1, w: 2, h: 1 }],
      ["H", { x: 0, y: 2, w: 4, h: 1 }],
      ["I", { x: 6, y: 2, w: 2, h: 1 }],
    ];
    return { columns: 8, order: cells.map(([id]) => id), map: new Map(cells) };
  };

  it("夹具本身是一座合法的三层堆（每块都有支撑、不重叠）", () => {
    const ledger = layers();
    for (const [, p] of ledger.map) assert.ok(isSupported(p, ledger.map));
    assertNoOverlap(Array.from(ledger.map.values()));
    assert.deepEqual(ledger.map.get("F"), { x: 2, y: 1, w: 4, h: 1 });
    assert.deepEqual(ledger.map.get("H"), { x: 0, y: 2, w: 4, h: 1 });
    assert.deepEqual(ledger.map.get("I"), { x: 6, y: 2, w: 2, h: 1 });
  });

  it("删掉底层的 A 与 D：E、G 掉一层，压在它们上面的 I 一路跟着掉；H 仍被 F 托着不动", () => {
    const before = layers();
    const present = new Set(["B", "C", "E", "F", "G", "H", "I"]);
    const after = reconcileLedger(before, present, 8, () => ({ col: 2, row: 1 }));
    assert.deepEqual(after.map.get("E"), { x: 0, y: 0, w: 2, h: 1 });
    assert.deepEqual(after.map.get("G"), { x: 6, y: 0, w: 2, h: 1 });
    assert.deepEqual(after.map.get("I"), { x: 6, y: 1, w: 2, h: 1 });
    // H 只有右半被 F 托着（左半下面的 E 掉走了）：部分支撑也算支撑，不动
    assert.deepEqual(after.map.get("H"), before.map.get("H"));
    assert.deepEqual(after.map.get("F"), before.map.get("F"));
    for (const [, p] of after.map) assert.ok(isSupported(p, after.map));
    assertNoOverlap(Array.from(after.map.values()));
  });

  it("删掉 B 与 C：宽长条 F 掉到底；H 左半仍被 E 托着，不跟着掉", () => {
    const present = new Set(["A", "D", "E", "F", "G", "H", "I"]);
    const after = reconcileLedger(layers(), present, 8, () => ({ col: 2, row: 1 }));
    assert.deepEqual(after.map.get("F"), { x: 2, y: 0, w: 4, h: 1 });
    assert.deepEqual(after.map.get("E"), { x: 0, y: 1, w: 2, h: 1 }); // A 还在，E 不动
    assert.deepEqual(after.map.get("H"), { x: 0, y: 2, w: 4, h: 1 }); // 被 E 托着，不动
    for (const [, p] of after.map) assert.ok(isSupported(p, after.map));
    assertNoOverlap(Array.from(after.map.values()));
  });

  it("列位永远不变：补位只往下掉，不往旁边挪", () => {
    const before = layers();
    const after = reconcileLedger(before, new Set(["C", "E", "F", "H", "I"]), 8, () => ({ col: 2, row: 1 }));
    for (const id of after.order) assert.equal(after.map.get(id)?.x, before.map.get(id)?.x);
  });
});
