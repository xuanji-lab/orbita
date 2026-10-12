/**
 * 俄罗斯方块形态的形状几何（tetris 形态专用；黑洞形态仍是矩形胶囊 / 正方形，
 * 见 blackhole-layout.ts 的 blackholeSpan，这次完全不动它）。
 *
 * 一份材料 → 一块四格方块（2026-10-12 用户裁决，原型 /tmp/orbita-tetris-proto）：
 * - 形状跟文件类型走，分类复用文件面板 `fileIcon` 的分族、不另造一套：I = 线性
 *   内容（文本 / 文档 / PDF / 音视频 / 未知文件），O = 画幅与网格（截图 / 图片 /
 *   表格），T = 演示（幕布 + 支架），S = 代码与网页（错开的台阶），Z = 配置（S 的
 *   镜像），J = 目录（左上的凸块是文件夹的耳朵），L = 压缩包（右耳像扣上的箱扣）。
 * - 拓扑固定，单格宽度 mw（占几列）随名字伸缩；名字放在 labelRow 那一横，非 I 块
 *   把扩展名挪进凸块（大写、mono、小字），I 块名字行末尾带 `.ext`（tertiary）。
 * - 每一格都是满高一行（30px 格 + 4px 间距，行步进 34px，不做半行）——T/S/Z/J/L
 *   比 1 行胶囊高出来的部分由「拼合」落位找回来，不靠把凸块压薄（半高薄脚被否决）。
 * - 截图（有字节的 image 材料）固定 mw=2 的 4 列 × 2 行横幅缩略图，不显示名字；
 *   图片**文件引用**（.png 的 file）是带名字的普通 O 块——没有缩略图可画。
 * - 目录的凸块这版留空：子项数需要新 IPC，不为它加（数据没有就不显示）。
 *
 * 一个几何同时给两套坐标：
 * - 渲染要的像素几何（outline / seams / labelRect / nubRect），原点在块外接框
 *   左上，框宽 = cols × 步进（**含尾步进**），可见轮廓四边各内缩 GAP/2——相邻块
 *   的可见轮廓之间正好留一格间距；
 * - 落位要的 footprint（[列, 行从盒底数]，块内相对坐标），交给 blackhole-layout.ts
 *   的格子占用判碰撞。
 *
 * 这一版不旋转：`rotation` 参数只接受 0（类型上钉死），以后做旋转时在 SHAPES 表
 * 扩方向、这里的公式不动。纯函数：不 import React，可被 `node --test` 直接加载
 * （依赖的 tree-view.ts 与 blackhole-layout.ts 同样不摸 DOM）。
 */
import { BLACKHOLE_GAP_PX, BLACKHOLE_STEP_PX, textWidthPx, type BlackholeSpan } from "./blackhole-layout.ts";
import { fileIcon, fileIconTone, type FileIconTone } from "../features/files/tree-view.ts";
import type { IconName } from "./Icon.tsx";

/** 名字行的固定开销（px）：左内边距 9 + 图标 13 + 图标与名字的间距 4 + 右内边距 8 + 2px 余量 */
const LABEL_CHROME_PX = 9 + 13 + 4 + 8 + 2;
/** 名字与行尾 `.ext` 之间的间距（px） */
const META_GAP_PX = 4;
/** 凸块文字的左右内边距合计（px） */
const NUB_PAD_PX = 14;
/** 外轮廓的圆角半径（px）：凸角凹角同值 */
const OUTLINE_RADIUS_PX = 6;
/** 接缝端头离格边的缩短量（px）：别顶到轮廓上 */
const SEAM_INSET_PX = 4;
/** I 块行尾 `.ext` 与凸块文字的字号（px，micro 档）——估宽与渲染都用它 */
const META_FONT_PX = 11;

/** 七种四格方块。格坐标 [列, 行从上数]——渲染原点在左上；labelRow = 放名字的那一横 */
export type TetrisKey = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

interface ShapeDef {
  cells: readonly (readonly [number, number])[];
  /** 名字所在行（从上数）：带文字的那一横内部不画竖向接缝，免得穿过文字 */
  labelRow: number;
}

export const TETRIS_SHAPES: Readonly<Record<TetrisKey, ShapeDef>> = {
  I: { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], labelRow: 0 },
  O: { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], labelRow: 1 },
  T: { cells: [[0, 0], [1, 0], [2, 0], [1, 1]], labelRow: 0 },
  S: { cells: [[1, 0], [2, 0], [0, 1], [1, 1]], labelRow: 1 },
  Z: { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], labelRow: 1 },
  J: { cells: [[0, 0], [0, 1], [1, 1], [2, 1]], labelRow: 1 },
  L: { cells: [[2, 0], [0, 1], [1, 1], [2, 1]], labelRow: 1 },
};

/** fileIcon 的分族 → 方块形状。目录在 tetrisKeyOf 里先分走（J），不进这张表 */
const ICON_TO_KEY: Partial<Record<IconName, TetrisKey>> = {
  "file-text": "I",
  book: "I",
  "scroll-text": "I",
  "file-audio-2": "I",
  "file-video-2": "I",
  file: "I",
  image: "O",
  "file-spreadsheet": "O",
  presentation: "T",
  "file-code-2": "S",
  globe: "S",
  "file-json-2": "Z",
  "file-archive": "L",
};

/** 材料 → 方块形状：目录是 J（耳朵），截图是 O（横幅），文件按 fileIcon 分族 */
export function tetrisKeyOf(kind: "image" | "file" | "dir", name: string): TetrisKey {
  if (kind === "dir") return "J";
  if (kind === "image") return "O";
  return ICON_TO_KEY[fileIcon(name, "file")] ?? "I";
}

/** 名字里的扩展名（最后一个 `.` 之后，小写）；点文件（`.` 开头）没有扩展名这个概念 */
function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** 像素矩形（原点 = 块外接框左上） */
export interface TetrisRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一条接缝（虚线段），横竖都一样表示 */
export interface TetrisSeam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TetrisGeometry {
  key: TetrisKey;
  tone: FileIconTone | null;
  icon: IconName;
  /** 单格宽度（列数）：拓扑不变，名字长格就宽 */
  mw: number;
  /** 外接宽（列）与高（行）——行是满高行，不做半行 */
  cols: number;
  rows: number;
  /** 截图横幅：不显示名字，直接画缩略图（4 列 × 2 行） */
  banner: boolean;
  /** 名字所在行（从上数） */
  labelRow: number;
  /** 名字主干（非 I 块已去掉扩展名；目录不带尾 `/`——渲染层用 DirMarkName 补） */
  stem: string;
  /** I 块名字行末尾的 `.ext`（其余块为空串：扩展名在凸块里） */
  meta: string;
  /** 凸块文字（扩展名大写；目录恒空——子项数这版拿不到，不为它加 IPC） */
  nubText: string;
  /** 落位脚印：[列, 行从盒底数]，块内相对坐标（blackhole-layout 判碰撞用） */
  footprint: readonly (readonly [number, number])[];
  /** 外轮廓 SVG path：格子并集的边界内缩 GAP/2，凸角凹角都做小圆角 */
  outline: string;
  /** 显示接缝：格与格之间的淡虚线。带文字的那一横（名字行 / 放了扩展名的凸块行）
   *  内部不画竖向接缝，免得穿过文字；凸块空着（目录）就照常画 */
  seams: readonly TetrisSeam[];
  labelRect: TetrisRect | null;
  nubRect: TetrisRect | null;
}

/**
 * 一份材料 → 方块几何。同一输入永远同一结果（不碰随机、不碰 DOM）——已发送
 * 消息的缩小快照只凭附件清单重算，必须和输入框逐块一致。
 */
export function tetrisGeometry(input: {
  kind: "image" | "file" | "dir";
  name: string;
  /** 盒子列数：块宽的上限（半个盒宽）与超窄盒截断都看它 */
  columns: number;
  /** 名字之外的额外宽度（「未复制」标记），px */
  extraPx?: number;
  /** 旋转方向；这一版只有 0（不旋转），类型钉死给以后留扩展口 */
  rotation?: 0;
}): TetrisGeometry {
  const columns = Math.max(1, input.columns);
  const key = tetrisKeyOf(input.kind, input.name);
  const tone: FileIconTone | null = input.kind === "file" ? fileIconTone(input.name, "file") : null;
  const icon: IconName = input.kind === "dir" ? "folder" : fileIcon(input.name, "file");

  // 名字拆分：非 I 的文件把扩展名挪进凸块；I 块名字行末尾带 .ext。
  // 截图材料（banner）不拆名字——不显示；目录 / 点文件没有扩展名概念
  const ext = input.kind === "file" ? extOf(input.name) : "";
  let stem = input.name;
  let nubText = "";
  let meta = "";
  if (input.kind !== "dir" && ext !== "") {
    stem = input.name.slice(0, input.name.length - ext.length - 1);
    if (key === "I") meta = `.${ext}`;
    else nubText = ext.toUpperCase();
  }

  const def = TETRIS_SHAPES[key];
  const rows = Math.max(...def.cells.map(([, r]) => r)) + 1;
  // 名字那一横的格数：名字宽度换算成 mw 时摊在这么多格上
  const labelRun = def.cells.filter(([, r]) => r === def.labelRow).length;
  // 整块不超过半个盒宽：mw 的上限由此反推
  let shapeCells = def.cells;
  let widthMinos = Math.max(...shapeCells.map(([c]) => c)) + 1;
  const maxMw = Math.max(1, Math.floor(Math.floor(columns / 2) / widthMinos));
  let mw: number;
  if (input.kind === "image") {
    mw = 2;
  } else {
    const labelPx =
      textWidthPx(stem) +
      (meta !== "" ? textWidthPx(meta, META_FONT_PX) + META_GAP_PX : 0) +
      LABEL_CHROME_PX +
      (input.extraPx ?? 0);
    const wantCols = Math.ceil((labelPx + BLACKHOLE_GAP_PX) / BLACKHOLE_STEP_PX);
    // 凸块要装下扩展名：按凸块所在各行里最短的一横反推单格最少宽度
    const nubRows = new Set(shapeCells.filter(([, r]) => r !== def.labelRow).map(([, r]) => r));
    let nubRun = Number.POSITIVE_INFINITY;
    for (const r of nubRows) nubRun = Math.min(nubRun, shapeCells.filter(([, nr]) => nr === r).length);
    const nubCols =
      nubText !== "" && nubRun !== Number.POSITIVE_INFINITY
        ? Math.max(
            1,
            Math.ceil(
              (textWidthPx(nubText, META_FONT_PX) + NUB_PAD_PX + BLACKHOLE_GAP_PX) /
                BLACKHOLE_STEP_PX /
                Math.max(1, nubRun),
            ),
          )
        : 1;
    mw = Math.min(maxMw, Math.max(1, nubCols, Math.ceil(wantCols / Math.max(1, labelRun))));
  }
  // 超窄盒兜底：块压不进盒宽时先收 mw，再不行砍掉右边的格子（块宽 ≤ 列数）
  if (widthMinos * mw > columns) {
    mw = Math.max(1, Math.floor(columns / widthMinos));
    if (widthMinos * mw > columns) {
      shapeCells = shapeCells.filter(([c]) => c < columns);
      widthMinos = Math.min(widthMinos, columns);
      mw = 1;
    }
  }
  const cols = widthMinos * mw;

  // 落位脚印（行从盒底数）与渲染用的展开格（列从左数、行从上数）
  const footprint: (readonly [number, number])[] = [];
  const gridCells: [number, number][] = [];
  for (const [c, r] of shapeCells) {
    for (let dx = 0; dx < mw; dx++) {
      footprint.push([c * mw + dx, rows - 1 - r]);
      gridCells.push([c * mw + dx, r]);
    }
  }

  const minoX0 = (c: number): number => c * mw * BLACKHOLE_STEP_PX;
  const minoX1 = (c: number): number => (c + 1) * mw * BLACKHOLE_STEP_PX;
  const rowY0 = (r: number): number => r * BLACKHOLE_STEP_PX;
  const rowY1 = (r: number): number => (r + 1) * BLACKHOLE_STEP_PX;
  const hasMino = (c: number, r: number): boolean => shapeCells.some(([mc, mr]) => mc === c && mr === r);
  /** 一横上格子并成的矩形，四边内缩 GAP/2（名字行 / 凸块都用它） */
  const runRect = (row: number): TetrisRect | null => {
    const cs = shapeCells
      .filter(([, r]) => r === row)
      .map(([c]) => c)
      .sort((a, b) => a - b);
    const first = cs[0];
    const last = cs[cs.length - 1];
    if (first === undefined || last === undefined) return null;
    return {
      left: minoX0(first) + BLACKHOLE_GAP_PX / 2,
      top: rowY0(row) + BLACKHOLE_GAP_PX / 2,
      width: minoX1(last) - minoX0(first) - BLACKHOLE_GAP_PX,
      height: BLACKHOLE_STEP_PX - BLACKHOLE_GAP_PX,
    };
  };
  const labelRow = def.labelRow;
  const labelRect = input.kind === "image" ? null : runRect(labelRow);
  let nubRect: TetrisRect | null = null;
  /** 凸块所在行（从上数）：nubText 非空时第一非空非名字行 */
  let nubRow: number | null = null;
  if (nubText !== "") {
    for (let r = 0; r < rows; r++) {
      if (r === labelRow) continue;
      const rect = runRect(r);
      if (rect !== null) {
        nubRect = rect;
        nubRow = r;
        break;
      }
    }
  }

  // 接缝：格与格之间的淡虚线。竖向接缝在**带文字的那一横**内部不画——名字行如此，
  // 放了扩展名 / 子项数的凸块行也如此（2026-10-12 验收：接缝从「XLSX」「JSON」
  // 中间穿过去）；凸块空着（目录 / 无扩展名）就照常画。横向接缝落在行与行的间隙里，
  // 不碰任何文字
  const textRows = new Set<number>([labelRow]);
  if (nubRow !== null) textRows.add(nubRow);
  const seams: TetrisSeam[] = [];
  for (const [c, r] of shapeCells) {
    if (hasMino(c + 1, r) && !textRows.has(r)) {
      seams.push({
        x1: minoX1(c),
        y1: rowY0(r) + BLACKHOLE_GAP_PX / 2 + SEAM_INSET_PX,
        x2: minoX1(c),
        y2: rowY1(r) - BLACKHOLE_GAP_PX / 2 - SEAM_INSET_PX,
      });
    }
    if (hasMino(c, r + 1)) {
      seams.push({
        x1: minoX0(c) + BLACKHOLE_GAP_PX / 2 + SEAM_INSET_PX,
        y1: rowY1(r),
        x2: minoX1(c) - BLACKHOLE_GAP_PX / 2 - SEAM_INSET_PX,
        y2: rowY1(r),
      });
    }
  }

  return {
    key,
    tone,
    icon,
    mw,
    cols,
    rows,
    banner: input.kind === "image",
    labelRow,
    stem,
    meta,
    nubText,
    footprint,
    outline: outlinePathOf(gridCells, OUTLINE_RADIUS_PX),
    seams,
    labelRect,
    nubRect,
  };
}

/** 几何 → 落位用的 span（blackhole-layout 的通用接口；cells 就是脚印） */
export function tetrisSpan(geo: TetrisGeometry): BlackholeSpan {
  return { shape: geo.key, col: geo.cols, row: geo.rows, cells: geo.footprint };
}

/**
 * 格子并集的外轮廓（SVG path d）：沿暴露边界走一圈角点 → 去共线点 → 每个角沿
 * 邻边夹角平分线内缩 GAP/2（miter）→ 凸角凹角都做小圆角（半径不超过相邻边长
 * 的一半）。坐标：格单位进、像素出（格步进 = BLACKHOLE_STEP_PX 的正方形格子）。
 */
function outlinePathOf(gridCells: readonly (readonly [number, number])[], radiusPx: number): string {
  const has = (x: number, y: number): boolean => gridCells.some(([cx, cy]) => cx === x && cy === y);
  // 有向边（顺时针）：角点 key → 下一角点。每条边只在暴露的那一侧生成；四格
  // 方块是四连通的，不会出现两个边抢同一个起点的自接触角
  const next = new Map<string, readonly [number, number]>();
  for (const [x, y] of gridCells) {
    if (!has(x, y - 1)) next.set(`${x},${y}`, [x + 1, y]);
    if (!has(x + 1, y)) next.set(`${x + 1},${y}`, [x + 1, y + 1]);
    if (!has(x, y + 1)) next.set(`${x + 1},${y + 1}`, [x, y + 1]);
    if (!has(x - 1, y)) next.set(`${x},${y + 1}`, [x, y]);
  }
  const start = next.keys().next().value;
  if (start === undefined) return "";
  const corners: [number, number][] = [];
  let key = start;
  do {
    const parts = key.split(",");
    corners.push([Number(parts[0]), Number(parts[1])]);
    const to = next.get(key);
    if (to === undefined) break;
    key = `${to[0]},${to[1]}`;
  } while (key !== start && corners.length < 999);
  // 去共线点：圆角只需要转角
  const pts = corners.filter((p, i) => {
    const a = corners[(i - 1 + corners.length) % corners.length];
    const b = corners[(i + 1) % corners.length];
    if (a === undefined || b === undefined) return true;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
  const px = pts.map(([x, y]): [number, number] => [x * BLACKHOLE_STEP_PX, y * BLACKHOLE_STEP_PX]);
  // 内缩：每个角沿两邻边的角平分线方向退 GAP/2
  const inset = px.map((v, i): [number, number] => {
    const p = px[(i - 1 + px.length) % px.length] ?? v;
    const n = px[(i + 1) % px.length] ?? v;
    const unit = (a: readonly [number, number], b: readonly [number, number]): [number, number] => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };
    const d1 = unit(p, v);
    const d2 = unit(v, n);
    const half = BLACKHOLE_GAP_PX / 2;
    return [v[0] + half * (-d1[1] - d2[1]), v[1] + half * (d1[0] + d2[0])];
  });
  // 圆角：每角一段二次贝塞尔（角点为控制点），首尾相接
  let path = "";
  const count = inset.length;
  for (let i = 0; i < count; i++) {
    const v = inset[i];
    const prev = inset[(i - 1 + count) % count];
    const after = inset[(i + 1) % count];
    if (v === undefined || prev === undefined || after === undefined) continue;
    const lenPrev = Math.hypot(prev[0] - v[0], prev[1] - v[1]) || 1;
    const lenAfter = Math.hypot(after[0] - v[0], after[1] - v[1]) || 1;
    const r = Math.min(radiusPx, lenPrev / 2, lenAfter / 2);
    const a: [number, number] = [v[0] + ((prev[0] - v[0]) / lenPrev) * r, v[1] + ((prev[1] - v[1]) / lenPrev) * r];
    const b: [number, number] = [v[0] + ((after[0] - v[0]) / lenAfter) * r, v[1] + ((after[1] - v[1]) / lenAfter) * r];
    path += `${i === 0 ? "M" : "L"}${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${v[0].toFixed(1)} ${v[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return `${path}Z`;
}
