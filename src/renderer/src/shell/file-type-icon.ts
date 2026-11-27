/**
 * 彩色文件图标的纯推导（2026-11-22 用户：「整套文件图标都换上」，照 Proma 用的那套）。
 *
 * 图标与映射都来自 material-icon-theme（MIT，devDependency 精确锁 5.40.0）：它的 manifest 按
 * 文件名 → 复合扩展名 → 扩展名 → 语言 id 的顺序决定一个文件长什么样，文件夹按名字（展开另有一套）。
 * 这里只做「名字 → 图标名」，图标名 → 文件 URL 由 FileTypeIcon.tsx 管。
 *
 * 纯模块：不碰 DOM / React / 打包器，可被 node --test 直接加载（测试传一份小 manifest）。
 */

/** material-icon-theme 的 manifest 里我们用到的那几张表（dist/material-icons.json 的子集） */
export interface IconManifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileExtensions: Readonly<Record<string, string>>;
  fileNames: Readonly<Record<string, string>>;
  folderNames: Readonly<Record<string, string>>;
  folderNamesExpanded: Readonly<Record<string, string>>;
  languageIds: Readonly<Record<string, string>>;
}

/**
 * manifest 的 fileExtensions 里没有、要经语言 id 才认得出的常见扩展名（VS Code 先把扩展名认成语言，再查 languageIds）。
 * 只列真碰得到的；认不出的落通用文件图标。
 */
const EXT_LANGUAGE: Readonly<Record<string, string>> = {
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  ini: "ini",
  vue: "vue",
  jsx: "javascriptreact",
  lua: "lua",
  swift: "swift",
  r: "r",
  tex: "latex",
  bib: "bibtex",
  log: "log",
  md: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  html: "html",
  htm: "html",
  py: "python",
  ts: "typescript",
  js: "javascript",
  json: "json",
};

/** Orbita 自己的文件：演示文稿（<名字>.slides.json）是演示，不是 json */
const ORBITA_FILE_ICONS: readonly (readonly [RegExp, string])[] = [[/\.slides\.json$/i, "powerpoint"]];

/** 文件 / 文件夹 → 图标名（manifest 里 iconDefinitions 的键）。认不出的给通用图标 */
export function materialIconName(manifest: IconManifest, name: string, kind: "file" | "directory" | "symlink" | "other", open = false): string {
  const lower = name.toLowerCase();
  if (kind === "directory") {
    const table = open ? manifest.folderNamesExpanded : manifest.folderNames;
    return table[lower] ?? (open ? manifest.folderExpanded : manifest.folder);
  }
  for (const [pattern, icon] of ORBITA_FILE_ICONS) {
    if (pattern.test(lower)) return icon;
  }
  const byName = manifest.fileNames[lower];
  if (byName !== undefined) return byName;
  // 复合扩展名从长到短：a.test.ts → test.ts → ts
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (ext === "") continue;
    const byExt = manifest.fileExtensions[ext];
    if (byExt !== undefined) return byExt;
  }
  const last = parts.length > 1 ? (parts.at(-1) ?? "") : "";
  const language = EXT_LANGUAGE[last];
  if (language !== undefined) {
    const byLanguage = manifest.languageIds[language];
    if (byLanguage !== undefined) return byLanguage;
  }
  return manifest.file;
}

/** 图标名 → 图标文件名（iconDefinitions 里的 iconPath 取末段，「./../icons/markdown.svg」→「markdown.svg」） */
export function iconFileOf(definitions: Readonly<Record<string, { iconPath: string }>>, icon: string): string | null {
  const path = definitions[icon]?.iconPath;
  if (path === undefined) return null;
  return path.split("/").pop() ?? null;
}
