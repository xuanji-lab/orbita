/**
 * 应用图标契约 —— IPC 四层的第 1 层。
 *
 * 图标在仓库里只放 SVG（renderer 的 `assets/app-icons/<kind>-<id>.svg`），选中时由 renderer
 * 在运行时画成 PNG 经 IPC 交给主进程，主进程再交给 Dock（macOS）/ 任务栏（Windows）并落盘缓存。
 * 理由：32 张预渲染 PNG 会让安装包大十几 MB，而 SVG 合计不到 1 MB。
 *
 * 款式分三类：
 * - `basic`：基础款（几何圈，四色）；
 * - `stone`：石纹款；
 * - `nebula`：星云款。石纹与星云共用同一批十四块石头的 id，名字也共用。
 * 一个款式的 id 是 `<kind>-<id>` 字符串，既是设置里存的值，也是 SVG 的文件名。
 */

/** 基础款的四个 id（默认款 ink 在最前，与设置页的排列同序） */
export const BASIC_ICON_IDS = ["ink", "paper", "blue", "yellow"] as const;
export type BasicIconId = (typeof BASIC_ICON_IDS)[number];

/** 石纹款与星云款共用的十四块石头（顺序即设置页的排列顺序） */
export const TEXTURE_ICON_IDS = [
  "feicui",
  "qinghua",
  "lanbao",
  "zhanguohong",
  "shuicao",
  "hujing",
  "yingjing",
  "dushan",
  "chaluo",
  "kongque",
  "lvsong",
  "bocailv",
  "moqing",
  "hongheitang",
] as const;
export type TextureIconId = (typeof TEXTURE_ICON_IDS)[number];

export type AppIconKind = "basic" | "stone" | "nebula";

/** 设置里存的款式值：`basic-ink`、`stone-feicui`、`nebula-moqing` …… 共 32 个 */
export type AppIconId = `basic-${BasicIconId}` | `stone-${TextureIconId}` | `nebula-${TextureIconId}`;

export interface AppIconEntry {
  id: AppIconId;
  kind: AppIconKind;
  /** 款式内的名字 key：基础款是 BasicIconId，石纹 / 星云是 TextureIconId（名字文案在 messages-*.ts） */
  key: BasicIconId | TextureIconId;
}

/** 默认款：墨底白圈。选回它也照常应用（不特殊处理成「恢复打包图标」，行为一致更简单） */
export const DEFAULT_APP_ICON: AppIconId = "basic-ink";

/** 全部 32 款，按设置页的分组顺序：基础 → 石纹 → 星云 */
export const APP_ICONS: readonly AppIconEntry[] = [
  ...BASIC_ICON_IDS.map((key): AppIconEntry => ({ id: `basic-${key}`, kind: "basic", key })),
  ...TEXTURE_ICON_IDS.map((key): AppIconEntry => ({ id: `stone-${key}`, kind: "stone", key })),
  ...TEXTURE_ICON_IDS.map((key): AppIconEntry => ({ id: `nebula-${key}`, kind: "nebula", key })),
];

const APP_ICON_ID_SET: ReadonlySet<string> = new Set(APP_ICONS.map((entry) => entry.id));

export function isAppIconId(value: unknown): value is AppIconId {
  return typeof value === "string" && APP_ICON_ID_SET.has(value);
}

/** renderer 画出的 PNG 的边长（px）。512 够 Dock 的 @2x，也够 Windows 的任务栏大图标 */
export const APP_ICON_PNG_SIZE = 512;

/** 主进程接收的 PNG 字节上限：512² 的 PNG 实际几十 KB，4 MB 之外一律当坏请求 */
export const APP_ICON_PNG_MAX_BYTES = 4 * 1024 * 1024;

/** 应用图标的 IPC 通道（只有一条：renderer → 主进程，应用并缓存） */
export const appIconChannels = {
  /** 载荷 AppIconApplyRequest，回 AppIconApplyResult */
  appIconApply: "app-icon:apply",
} as const;

export type AppIconChannel = (typeof appIconChannels)[keyof typeof appIconChannels];

export interface AppIconApplyRequest {
  id: AppIconId;
  /** 512×512 的 PNG 字节（renderer 按各平台的图标网格画好：mac 带圆角与留白，Windows 满铺方形） */
  png: Uint8Array;
}

export type AppIconApplyResult = { ok: true } | { ok: false; error: string };
