/**
 * .blg 解析 —— bibtex / biber 的真根因只在那一份里。
 *
 * 编译回执以前只说 `latexmk exited with code 12 / Missing bbl file`，而磁盘上的
 * `build/main.blg` 写着 `Illegal end of database file---line 5 of file refs.bib`
 * ——「是 .bib 写坏了还是没跑 bibtex」这个判断只有读了它才能做。全仓在本次改动前
 * **没有任何 .blg 消费者**（`grep -rn "\.blg" src` 零命中）。
 *
 * 纯函数、无 IO（同 parse-log.ts）：run.ts 负责找路径与读文本。
 *
 * **biber 的措辞未在本机实测**（本机只跑过 bibtex 路径）：按官方日志的
 * `INFO/WARN/ERROR - ` 前缀做容错解析，认不出的一律不收——把 biber 的
 * `INFO - ` 读成 error 比漏认更糟。
 */
import type { LatexIssue } from "../../shared/latex.ts";

/** 单条 message 的字符上限（与 parse-log 同一口径） */
const MAX_MESSAGE_CHARS = 240;

/**
 * bibtex 的 `.blg`：`Illegal end of database file---line 5 of file refs.bib`
 * （行号是**数据库文件**的行号，不是 .tex 的）。
 */
const ILLEGAL_END = /^Illegal end of database file---line (\d+) of file (.+)$/;

/** `I couldn't open database file nosuch.bib`（后面常跟 `---line N of file main.aux`） */
const CANT_OPEN = /^I couldn't open (?:database|style) file (.+)$/;

/** `Warning--I didn't find a database entry for "levy2019"`（biber 用单引号） */
const NO_DATABASE_ENTRY = /^Warning--I didn't find a database entry for ["'](.+)["']/;

/** biber：`WARN - I didn't find a database entry for 'levy2019'` */
const BIBER_NO_ENTRY = /^I didn't find a database entry for ["'](.+)["']/;

/** biber 的每一条都带 `INFO - ` / `WARN - ` / `ERROR - ` 前缀 */
const BIBER_LEVEL = /^(ERROR|WARN) - (.*)$/;

function clip(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= MAX_MESSAGE_CHARS ? collapsed : `${collapsed.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * 一份 .blg → 诊断。`step` 按日志自称判断（biber 打 `INFO - This is Biber …`），
 * 认不出时按 bibtex——TeX Live 的默认链就是 bibtex。
 *
 * **只收能成句的行**：`I'm skipping whatever remains of this entry`、
 * `(There was 1 error message)` 是上一条的尾巴 / 汇总，收进来只会让列表变长。
 */
export function parseBlg(text: string): LatexIssue[] {
  if (text.trim() === "") return [];
  const step = /\bThis is Biber\b|\bINFO - /.test(text) ? "biber" : "bibtex";
  const issues: LatexIssue[] = [];
  const seen = new Set<string>();

  const push = (issue: LatexIssue): void => {
    const key = `${issue.file ?? ""}:${issue.line ?? ""}:${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const illegal = ILLEGAL_END.exec(line);
    if (illegal !== null) {
      push({
        kind: "error",
        file: (illegal[2] ?? "").trim(),
        line: Number(illegal[1]),
        message: clip(line),
        code: "bib-error",
        column: null,
        source: "blg",
        step,
        raw: clip(line),
      });
      continue;
    }

    const unopenable = CANT_OPEN.exec(line);
    if (unopenable !== null) {
      push({
        kind: "error",
        file: (unopenable[1] ?? "").trim(),
        line: null,
        message: clip(line),
        code: "missing-file",
        column: null,
        source: "blg",
        step,
        raw: clip(line),
      });
      continue;
    }

    const noEntry = NO_DATABASE_ENTRY.exec(line) ?? BIBER_NO_ENTRY.exec(line);
    if (noEntry !== null) {
      push({
        kind: "warning",
        file: null,
        line: null,
        message: clip(line),
        // 与 TeX 日志里的 `Citation `k' undefined` 是同一个根因，用同一个 code
        code: "citation-undefined",
        column: null,
        source: "blg",
        step,
        raw: clip(line),
      });
      continue;
    }

    const biber = BIBER_LEVEL.exec(line);
    if (biber !== null) {
      const message = (biber[2] ?? "").trim();
      if (message === "") continue;
      const level = biber[1] ?? "WARN";
      // biber 的 WARN 也可能就是「找不到条目」——与 bibtex 的 Warning-- 归同一类
      const noEntry = NO_DATABASE_ENTRY.exec(message) ?? BIBER_NO_ENTRY.exec(message);
      push({
        kind: level === "ERROR" ? "error" : "warning",
        file: null,
        line: null,
        message: clip(`biber ${level}: ${message}`),
        code: noEntry === null ? "bib-error" : "citation-undefined",
        column: null,
        source: "blg",
        step,
        raw: clip(line),
      });
      continue;
    }

    // bibtex 的其余 Warning--（empty author / to sort …）：低价值但确实是 bib 侧的事实
    if (line.startsWith("Warning--")) {
      push({
        kind: "warning",
        file: null,
        line: null,
        message: clip(line),
        code: "bib-error",
        column: null,
        source: "blg",
        step,
        raw: clip(line),
      });
    }
  }
  return issues;
}
