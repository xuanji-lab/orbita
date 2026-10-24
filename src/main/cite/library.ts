/**
 * 项目里的文献库 = 所有 `.bib` 解析后的合并视图（`cite:library` 的实现）。
 *
 * 扫描规则与 `latex/project.ts` 数「源码 mtime」时同一套：递归 ≤ 3 层、跳过隐藏目录
 * 与 `build/ out/ dist/ node_modules/ .git` 一类产物目录——补全不该把 `build/` 里
 * 那份 latexmk 拷来的 .bib 也算进候选（那是产物，改了没用）。
 *
 * **文件顺序决定「同 key 先出现者」**：按相对路径排序后依次解析，所以结果与
 * readdir 的返回顺序、平台差异无关，测试也能钉死。
 *
 * 只读盘、不缓存：一次扫描是几个小文件的 readFileSync，比「缓存失效」的复杂度便宜。
 * 调用方按项目源码 mtime 决定什么时候再问（见 renderer 的 useCiteLibrary）。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { CiteBibFile, CiteLibrary } from "../../shared/cite.ts";
import { mergeBibEntries, parseBibtex, type ParsedBib } from "./bib.ts";

/** 递归上限：文献库通常在顶层或 `refs/`，再深就是误入别人的仓库 */
const MAX_DEPTH = 3;

/** 每个目录最多看多少条目（防一个巨大的附件目录把主进程拖住） */
const MAX_ENTRIES = 2000;

/** 最多解析多少份 .bib：正常论文个位数，200 已经宽到离谱 */
const MAX_FILES = 200;

/** 单份 .bib 的体积上限：超过就整份跳过（在问题上留一句），不读进内存 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 跳过的目录名（隐藏目录另判）：产物、依赖、版本库 */
const SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn"]);

/** 扫项目目录、解析、合并去重。`projectDir` 是绝对路径（已过白名单） */
export function collectCiteLibrary(projectDir: string): CiteLibrary {
  const dir = resolve(projectDir);
  const files: CiteBibFile[] = [];
  const parsed: { path: string; entries: ParsedBib["entries"] }[] = [];

  for (const path of listBibFiles(dir)) {
    const rel = toForwardSlashes(relative(dir, path));
    let source: string;
    try {
      const stats = statSync(path);
      if (stats.size > MAX_BYTES) {
        files.push({ path: rel, entries: 0, bad: 0, error: "file is larger than 8 MB" });
        continue;
      }
      source = readFileSync(path, "utf8");
    } catch (cause) {
      files.push({ path: rel, entries: 0, bad: 0, error: failMessage(cause) });
      continue;
    }
    const result = parseBibtex(source);
    files.push({ path: rel, entries: result.entries.length, bad: result.bad, error: null });
    parsed.push({ path: rel, entries: result.entries });
  }

  const merged = mergeBibEntries(parsed);
  return { entries: merged.entries, files, duplicates: merged.duplicates };
}

/**
 * 目录里所有 .bib 的绝对路径，**按相对路径排序**（决定去重时谁先出现）。
 * 深度与条目数都有上限——这里不是 `find`，它跑在主进程里。
 */
export function listBibFiles(projectDir: string): string[] {
  const out: string[] = [];
  let seen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 名字排序：同一个项目在任何机器上扫出的文件顺序都一样
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (seen >= MAX_ENTRIES || out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (extname(entry.name).toLowerCase() === ".bib") out.push(path);
    }
  };

  walk(projectDir, 0);
  return out;
}

/** 契约里的路径一律正斜杠：renderer 直接显示，Windows 上反斜杠混在提示里很难读 */
function toForwardSlashes(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).join("/");
}

function failMessage(cause: unknown): string {
  if (cause instanceof Error) {
    // Node 的 fs 错自带 `code`（EACCES / ENOENT），消息里已经有人话；只取第一行
    return cause.message.split("\n")[0] ?? cause.message;
  }
  return String(cause);
}
