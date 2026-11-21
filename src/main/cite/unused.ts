/**
 * 「bib 里有、正文没引」—— 引用页签里给人看的只读清单。
 *
 * 与编译诊断的方向相反：`Citation 'x' undefined` 是正文引了 bib 里没有的键；这里
 * 找的是 bib 里有、当前 root 的**包含闭包**里一次都没 `\cite` 过的条目。用户拿它
 * 清理没人引的条目 / 发现自己忘了引某篇。
 *
 * 三条决定：
 * - **认当前 root 的闭包，不扫整个项目**：附录、另一篇论文的 .tex 不该让一条文献
 *   显得「被引用过」；闭包与编译 / 过期判定读同一张图（includes.ts）。
 * - **`\nocite{*}` 是「全部引用」**：BibTeX 的语义如此，此时清单必空并说明原因，
 *   不列一屏假阳性。
 * - **只读**：不改任何文件；删除未使用条目要人确认，这轮不做。
 */
import type { CiteLibrary, CiteUnusedEntry, CiteUnusedReport } from "../../shared/cite.ts";
import { stripTexComments } from "../latex/index.ts";
import {
  includeClosure,
  readSourceText,
  realIncludeDeps,
  type IncludeDeps,
} from "../latex/includes.ts";

/**
 * 认的引用命令。前几个是 LaTeX 经典写法，其后是 biblatex 的；大小写两种都收
 * （biblatex 的 `\Textcite` / `\Parencite` 是独立命令）。多 key 一律按逗号拆。
 */
const CITE_COMMANDS = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "citenum",
  "citeurl",
  "nocite",
  "citeonline",
  "citeasnoun",
  "citepalias",
  "citetalias",
  "Cite",
  "Citep",
  "Citet",
  "Citealp",
  "Citealt",
  "Citeauthor",
  "Citeyear",
  "parencite",
  "Parencite",
  "textcite",
  "Textcite",
  "autocite",
  "Autocite",
  "footcite",
  "Footcite",
  "footcitetext",
  "smartcite",
  "Smartcite",
  "supercite",
  "cites",
  "Cites",
  "parencites",
  "Parencites",
  "textcites",
  "Textcites",
  "autocites",
  "Autocites",
  "footcites",
  "Footcites",
  "smartcites",
  "Smartcites",
]);

/** 一次可以带多组 `{keys}` 的命令（biblatex 的 `\cites{a}{b}` 写法） */
const MULTI_CITE = new Set([
  "cites",
  "Cites",
  "parencites",
  "Parencites",
  "textcites",
  "Textcites",
  "autocites",
  "Autocites",
  "footcites",
  "Footcites",
  "smartcites",
  "Smartcites",
]);

/** 从 `open` 处的开括号读到配对的收括号；返回内容与收括号之后的下标 */
function readDelimited(
  source: string,
  open: number,
  opener: string,
  closer: string,
): { text: string; next: number } | null {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1; // 转义的括号不算括号
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open + 1, i), next: i + 1 };
    }
  }
  return null;
}

/**
 * 一份 .tex 里的引用键（注释里的不算）。`nociteAll` 表示出现了 `\nocite{*}`。
 * 纯函数：node --test 直接喂文本。
 */
export function extractCiteKeys(text: string): { keys: Set<string>; nociteAll: boolean } {
  const source = stripTexComments(text);
  const keys = new Set<string>();
  let nociteAll = false;
  if (!source.includes("\\")) return { keys, nociteAll };

  const command = /\\([A-Za-z]+)\*?/g;
  for (const match of source.matchAll(command)) {
    const name = match[1] ?? "";
    if (!CITE_COMMANDS.has(name)) continue;
    const multi = MULTI_CITE.has(name);
    let cursor = (match.index ?? 0) + match[0].length;
    // 组之间的可选参数（`[see][p.~3]`）与键组交替出现；普通命令取第一组就停
    while (true) {
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const ch = source[cursor];
      if (ch === "[") {
        const option = readDelimited(source, cursor, "[", "]");
        if (option === null) break;
        cursor = option.next;
        continue;
      }
      if (ch !== "{") break;
      const group = readDelimited(source, cursor, "{", "}");
      if (group === null) break;
      cursor = group.next;
      for (const raw of group.text.split(",")) {
        const key = raw.trim();
        if (key === "") continue;
        // 宏定义体里的 `#1` 是占位符，不是引用键
        if (key.includes("#")) continue;
        if (key === "*" && name === "nocite") {
          nociteAll = true;
          continue;
        }
        keys.add(key);
      }
      if (!multi) break;
    }
  }
  return { keys, nociteAll };
}

/**
 * 纯判定：文献库 + 闭包里所有 .tex 的正文 → 未使用清单。
 * `entries` 顺序跟文献库一致（key 已排序），不在这里再排一次。
 */
export function unusedCitations(
  library: CiteLibrary,
  texSources: readonly string[],
  meta: { rootFound: boolean; truncated: boolean },
): CiteUnusedReport {
  const cited = new Set<string>();
  let nociteAll = false;
  for (const text of texSources) {
    const scan = extractCiteKeys(text);
    if (scan.nociteAll) nociteAll = true;
    for (const key of scan.keys) cited.add(key);
  }
  const entries: CiteUnusedEntry[] =
    nociteAll || !meta.rootFound
      ? []
      : library.entries
          .filter((entry) => !cited.has(entry.key))
          .map((entry) => ({
            key: entry.key,
            type: entry.type,
            title: entry.title,
            year: entry.year,
            file: entry.file,
            line: entry.line,
          }));
  return {
    entries,
    nociteAll,
    rootFound: meta.rootFound,
    texFiles: texSources.length,
    bibFiles: library.files.length,
    truncated: meta.truncated || library.truncated,
  };
}

/**
 * 从当前 root 出发：算包含闭包、读闭包里的 .tex、再判定。
 *
 * root 读不到时 `rootFound:false`（界面说「认不出当前 root」），不是错误：文件面板
 * 的日常里有还没选主文件的项目。闭包撞上限或某份文件读不了时置 `truncated`——清单
 * 可能少报「被引用」，不敢说它完整。
 */
export function scanUnusedCitations(
  rootPath: string,
  library: CiteLibrary,
  deps: IncludeDeps = realIncludeDeps,
): CiteUnusedReport {
  const closure = includeClosure(rootPath, deps);
  if (closure === null) {
    return unusedCitations(library, [], { rootFound: false, truncated: false });
  }
  const sources: string[] = [];
  let unreadable = false;
  for (const path of closure.files) {
    if (!/\.tex$/i.test(path)) continue;
    const text = readSourceText(deps, path);
    if (text === null) {
      unreadable = true;
      continue;
    }
    sources.push(text);
  }
  return unusedCitations(library, sources, {
    rootFound: true,
    truncated: closure.truncated || unreadable,
  });
}
