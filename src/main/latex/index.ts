/**
 * 项目符号索引（`latex:index`）—— 补全的「本项目那一层」：`\label` 候选、项目自己
 * 定义的命令 / 环境、`\input` / `\includegraphics` 的路径候选。
 *
 * 三个决定：
 * - **正则在剔除注释之后跑，不上 AST**：论文里的符号就是那几种写法，`latex-utensils`
 *   一类的解析器要引依赖、要跑 worker，收益是「更懂 TeX」，而补全只需要「名字在哪」。
 *   误报的代价也小：多一个候选，选错了用户会看见。
 * - **与编译读同一个项目目录**：目录由 `latex:ipc` 用同一套 `locateLatexProject` 算，
 *   magic root 把项目指到别处时，补全看的也是那一份。
 * - **上限只防病态仓，不静默**：深度 / 条数 / 单文件体积撞上限时置 `truncated`，
 *   界面不拿它当错误，但测试与日志能看出「这次索引不完整」。
 *
 * 只读盘、不起进程、不做缓存：一次索引是几十份小文件的 readFileSync；缓存失效比读盘贵。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { LatexLabelRef, LatexProjectIndex } from "../../shared/latex.ts";

/** 递归上限：论文项目两三层，再深多半是误入别人的仓库 */
const MAX_DEPTH = 4;

/** 一次索引最多看多少个条目（文件 + 目录）：防一个大仓把主进程拖住 */
const MAX_ENTRIES = 4000;

/** 单份 .tex 的体积上限：超过只读头部（符号定义总在能被正常编辑的文件里） */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** 路径候选里最多收多少个：弹层只渲染前几十个，几千个候选只是白占内存 */
const MAX_FILES = 3000;

/** 跳过的目录名（隐藏目录另判）：产物、依赖、版本库 */
const SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn"]);

/** 参与符号解析的扩展名（.cls/.sty 里也会定义命令，但那是别人的文件——只读项目自己的） */
const SOURCE_EXTS = new Set([".tex", ".ltx"]);

/** 路径候选的扩展名：正文能 `\input` 的、图片能 `\includegraphics` 的 */
const PATH_EXTS = new Set([
  ".tex",
  ".ltx",
  ".bib",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".eps",
  ".svg",
]);

export interface ExtractedSymbols {
  /** 按出现顺序；不含行号（行号在扫描时按文件累加） */
  labels: { name: string; line: number }[];
  commands: string[];
  environments: string[];
}

/**
 * 去掉 TeX 注释（未转义的 `%` 到行尾），**保留换行**——行号是索引的一部分，
 * 注释里的 `\label{...}` 不该进候选（被注释掉的 label 恰恰最容易误导）。
 */
export function stripTexComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1;
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const LABEL = /\\label\s*\{([^{}]+)\}/g;
const NEWCOMMAND = /\\(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z@]+)/g;
const DEF = /\\def\s*\\([A-Za-z@]+)/g;
const DECLARE_MACRO = /\\(?:providecommand|DeclareMathOperator|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)/g;
const NEWENV = /\\(?:re)?newenvironment\*?\s*\{([^{}]+)\}/g;
const NEWTHEOREM = /\\newtheorem\*?\s*\{([^{}]+)\}/g;

/** 从一份 .tex 里抽符号（纯函数，`node --test` 覆盖）。行号 1 基 */
export function extractSymbols(text: string): ExtractedSymbols {
  const source = stripTexComments(text);
  const labels: { name: string; line: number }[] = [];
  const commands: string[] = [];
  const environments: string[] = [];

  // 行起点表 + 二分：一个个 match 从头数行在长文档上是 O(n²)
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const match of source.matchAll(LABEL)) {
    const name = (match[1] ?? "").trim();
    // `\label{#1}` 是宏定义体里的占位符，不是真 label
    if (name === "" || name.includes("#")) continue;
    labels.push({ name, line: lineAt(match.index ?? 0) });
  }
  for (const pattern of [NEWCOMMAND, DECLARE_MACRO, DEF]) {
    for (const match of source.matchAll(pattern)) {
      const name = (match[1] ?? "").trim();
      if (name !== "") commands.push(name);
    }
  }
  for (const match of source.matchAll(NEWENV)) {
    const name = (match[1] ?? "").trim();
    if (name !== "") environments.push(name);
  }
  for (const match of source.matchAll(NEWTHEOREM)) {
    const name = (match[1] ?? "").trim();
    if (name !== "") environments.push(name);
  }
  return { labels, commands, environments };
}

/** 相对路径统一成正斜杠（Windows 上也一样，界面与测试都按这一种形状断言） */
function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 扫描结果：索引本体 + 有没有看不全 */
interface ScanResult {
  labels: LatexLabelRef[];
  commands: Set<string>;
  environments: Set<string>;
  files: Set<string>;
  truncated: boolean;
}

function scanProject(projectDir: string): ScanResult {
  const labels: LatexLabelRef[] = [];
  const commands = new Set<string>();
  const environments = new Set<string>();
  const files = new Set<string>();
  let seen = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      const rel = toForwardSlashes(relative(projectDir, path));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        seen += 1;
        files.add(`${rel}/`);
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      const ext = extname(entry.name).toLowerCase();
      if (PATH_EXTS.has(ext) && files.size < MAX_FILES) files.add(rel);
      if (!SOURCE_EXTS.has(ext)) continue;
      let text: string;
      try {
        const stats = statSync(path);
        if (stats.size > MAX_SOURCE_BYTES) {
          truncated = true;
          continue;
        }
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const symbols = extractSymbols(text);
      for (const label of symbols.labels) labels.push({ name: label.name, file: rel, line: label.line });
      for (const name of symbols.commands) commands.add(name);
      for (const name of symbols.environments) environments.add(name);
    }
  };

  walk(resolve(projectDir), 0);
  return { labels, commands, environments, files, truncated };
}

const byName = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** 项目目录 → 索引（绝对路径，已过白名单） */
export function buildLatexIndex(projectDir: string): LatexProjectIndex {
  const dir = resolve(projectDir);
  const scan = scanProject(dir);

  scan.labels.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const counts = new Map<string, number>();
  for (const label of scan.labels) counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
  const duplicateLabels = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort(byName);

  return {
    dir,
    labels: scan.labels,
    duplicateLabels,
    commands: [...scan.commands].sort(byName),
    environments: [...scan.environments].sort(byName),
    files: [...scan.files].sort(byName),
    truncated: scan.truncated,
  };
}
