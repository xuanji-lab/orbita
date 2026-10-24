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
 * **上限只防病态仓，不许静默丢文件**（评审 F1）：论文仓里 `figures/` 放两千张图
 * 是常态，早期版本把「看过的条目数」全局卡在 2000，排在后面的 `refs/ok.bib` 就整份
 * 读不到而界面毫无提示。现在：
 * - 预算按**每个目录**算（20000 个条目：一个目录里真有十万个文件才触发），
 *   总量再给一个很宽的兜底（20 万）；
 * - `MAX_FILES` 只数 `.bib`；
 * - 任何因上限 / 体积没读的 `.bib` 都进 `skipped`（带得上路径就带），
 *   数不出路径的情形（预算用完、深度截断）置 `truncated`——界面据此给一条
 *   「补全可能不全」的 warning。
 *
 * 只读盘、不缓存：一次扫描是几个小文件的 readFileSync，比「缓存失效」的复杂度便宜。
 * 调用方按项目源码 mtime 决定什么时候再问（见 renderer 的 useCiteLibrary）。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { CiteBibFile, CiteLibrary, CiteSkippedBib } from "../../shared/cite.ts";
import { mergeBibEntries, parseBibtex, type ParsedBib } from "./bib.ts";

/** 递归上限：文献库通常在顶层或 `refs/`，再深就是误入别人的仓库 */
const MAX_DEPTH = 3;

/**
 * **每个目录**最多看多少条目：防一个病态目录（十万个文件）把主进程拖住。
 * 宽到 20000 是故意的——`figures/` 两千张图不该影响文献库。
 */
const MAX_DIR_ENTRIES = 20_000;

/** 整次扫描最多看多少条目（宽上限，只防误入一个巨大的仓库） */
const MAX_ENTRIES = 200_000;

/** 最多解析多少份 .bib：正常论文个位数，200 已经宽到离谱 */
const MAX_FILES = 200;

/** 单份 .bib 的体积上限：超过就整份跳过（记进 skipped），不读进内存 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 跳过的目录名（隐藏目录另判）：产物、依赖、版本库 */
const SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn"]);

/** 扫描结果：读哪些 .bib、哪些没读、有没有看不全的地方 */
export interface BibScan {
  /** 绝对路径，**按相对路径排序**（决定去重时谁先出现） */
  files: string[];
  /** 因上限没读的 .bib（路径是绝对的） */
  skipped: CiteSkippedBib[];
  /** 有目录 / 深度没进去看：可能还有 .bib 没被发现，具体是哪几份数不出来 */
  truncated: boolean;
}

/** 扫项目目录、解析、合并去重。`projectDir` 是绝对路径（已过白名单） */
export function collectCiteLibrary(projectDir: string): CiteLibrary {
  const dir = resolve(projectDir);
  const scan = scanBibFiles(dir);
  const files: CiteBibFile[] = [];
  const parsed: { path: string; entries: ParsedBib["entries"] }[] = [];
  const skipped: CiteSkippedBib[] = scan.skipped.map((item) => ({ ...item, path: toForwardSlashes(relative(dir, item.path)) }));

  for (const path of scan.files) {
    const rel = toForwardSlashes(relative(dir, path));
    let source: string;
    try {
      const stats = statSync(path);
      if (stats.size > MAX_BYTES) {
        // 体积超限不是「坏条目」：整份没读，与上限截断一样进 skipped（界面汇总一条）
        skipped.push({ path: rel, reason: "too-large" });
        continue;
      }
      source = readFileSync(path, "utf8");
    } catch (cause) {
      // 读失败是「这份文件本身有问题」：按文件报，用户能照着路径去查权限 / 编码
      files.push({ path: rel, bad: 0, error: failMessage(cause) });
      continue;
    }
    const result = parseBibtex(source);
    files.push({ path: rel, bad: result.bad, error: null });
    parsed.push({ path: rel, entries: result.entries });
  }

  return { entries: mergeBibEntries(parsed), files, skipped, truncated: scan.truncated };
}

/**
 * 目录里所有 `.bib` 的绝对路径 + 没读的那些，**按相对路径排序**。
 * 深度与条目数都有上限——这里不是 `find`，它跑在主进程里。
 */
export function scanBibFiles(projectDir: string): BibScan {
  const files: string[] = [];
  const skipped: CiteSkippedBib[] = [];
  let truncated = false;
  let seen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      // 没下去看：可能还有 .bib，如实标成「看不全」
      truncated = true;
      return;
    }
    if (seen >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length > MAX_DIR_ENTRIES) truncated = true;
    // 名字排序：同一个项目在任何机器上扫出的文件顺序都一样
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let looked = 0;
    for (const entry of entries) {
      if (looked >= MAX_DIR_ENTRIES || seen >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      // 「没读」名单也不无限攒：多到与 MAX_FILES 一样多时，剩下的不数了，
      // 用 truncated 说「可能还有」——否则一个几万份 .bib 的病态仓库会把名单撑爆
      if (skipped.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      looked += 1;
      seen += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".bib") continue;
      if (files.length >= MAX_FILES) {
        skipped.push({ path, reason: "too-many-files" });
        continue;
      }
      files.push(path);
    }
  };

  walk(projectDir, 0);
  return { files, skipped, truncated };
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
