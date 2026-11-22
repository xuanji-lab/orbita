import manifest from "material-icon-theme/dist/material-icons.json";
import { iconFileOf, materialIconName, type IconManifest } from "./file-type-icon.ts";

/**
 * 彩色文件图标（2026-11-22 用户：「整套文件图标都换上……右侧面板跟文中的这个图标能对上」，照 Proma 用的 material-icon-theme）。
 * 文件面板、输入框附件、对话结尾的改文件卡与产物卡都用它：同一个文件在哪儿都长一个样。图标自带颜色，不另垫底。
 *
 * 图标文件不进仓库：从 devDependency 的 material-icon-theme/icons 取 URL（不内联，见 electron.vite.config 的
 * assetsInlineLimit），浏览器按需加载、缓存；映射表是同一个包的 manifest。
 */
const ICON_URLS = import.meta.glob("../../../../node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const URL_BY_FILE = new Map<string, string>(
  Object.entries(ICON_URLS).map(([path, url]) => [path.split("/").pop() ?? path, url]),
);

const MANIFEST = manifest as unknown as IconManifest & { iconDefinitions: Record<string, { iconPath: string }> };

/** 名字 → 图标 URL（认不出的给通用文件 / 文件夹图标） */
export function fileTypeIconUrl(name: string, kind: "file" | "directory" | "symlink" | "other", open = false): string | null {
  const icon = materialIconName(MANIFEST, name, kind, open);
  const file = iconFileOf(MANIFEST.iconDefinitions, icon) ?? iconFileOf(MANIFEST.iconDefinitions, MANIFEST.file);
  return file === null ? null : (URL_BY_FILE.get(file) ?? null);
}

export function FileTypeIcon(props: {
  name: string;
  kind?: "file" | "directory" | "symlink" | "other";
  open?: boolean;
  size?: number;
  className?: string;
}) {
  const size = props.size ?? 16;
  const url = fileTypeIconUrl(props.name, props.kind ?? "file", props.open === true);
  if (url === null) return <span className={props.className} style={{ display: "inline-block", width: size, height: size }} />;
  return (
    <img
      className={props.className === undefined ? "file-type-icon" : `file-type-icon ${props.className}`}
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      style={{ flex: "none", display: "block" }}
    />
  );
}
