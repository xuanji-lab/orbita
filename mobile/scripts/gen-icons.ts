/**
 * 生成 mobile/src/theme/icons.gen.ts：把 app 用到的 lucide 图标从 design-system/assets/icons/lucide/
 * （lucide-static@1.33.0，与桌面同一份文件）转成 react-native-svg 能画的元素表。
 *
 * 不用 lucide-react-native：它跟着 lucide 主线走（1.80），图形会和桌面钉住的 1.33.0 漂开。
 * 新加图标：把名字加进 ICONS，在 mobile/ 下跑 `bun run gen`；设计系统里没有的先照 readme 的规矩
 * 从 lucide-static@1.33.0 拷进 design-system/assets/icons/lucide/。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ICONS = [
  "arrow-up",
  "bot",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevron-up",
  "circle-stop",
  "clock",
  "folder",
  "folder-open",
  "history",
  "key",
  "laptop",
  "list-todo",
  "loader-circle",
  "message-square",
  "messages-square",
  "smartphone",
  "triangle-alert",
  "wifi-off",
] as const;

const ICON_DIR = join(import.meta.dirname, "..", "..", "design-system", "assets", "icons", "lucide");
export const ICONS_OUT = join(import.meta.dirname, "..", "src", "theme", "icons.gen.ts");

const TAGS = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const ATTRS = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "points"]);

export type IconElement = [tag: string, attrs: Record<string, string>];

export function parseIcon(svg: string): IconElement[] {
  const body = svg.replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "");
  const out: IconElement[] = [];
  for (const match of body.matchAll(/<(\w+)([^>]*?)\/?>/g)) {
    const tag = match[1] ?? "";
    if (!TAGS.has(tag)) {
      if (!tag.startsWith("/")) throw new Error(`unsupported svg element <${tag}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) {
      const name = attr[1] ?? "";
      if (ATTRS.has(name)) attrs[name] = attr[2] ?? "";
    }
    out.push([tag, attrs]);
  }
  return out;
}

export function buildIconsModule(): string {
  const table: Record<string, IconElement[]> = {};
  for (const name of ICONS) table[name] = parseIcon(readFileSync(join(ICON_DIR, `${name}.svg`), "utf8"));
  return [
    "// 由 mobile/scripts/gen-icons.ts 从 design-system/assets/icons/lucide/（lucide-static@1.33.0）生成，**不要手改**。",
    "",
    'export type IconTag = "path" | "circle" | "rect" | "line" | "polyline" | "polygon" | "ellipse";',
    "",
    `export const ICON_ELEMENTS = ${JSON.stringify(table, null, 2)} as const satisfies Record<string, readonly (readonly [IconTag, Readonly<Record<string, string>>])[]>;`,
    "",
    "export type IconName = keyof typeof ICON_ELEMENTS;",
    "",
  ].join("\n");
}

if (process.argv[1] === import.meta.filename) {
  writeFileSync(ICONS_OUT, buildIconsModule());
  console.log(`写好了 ${ICONS_OUT}`);
}
