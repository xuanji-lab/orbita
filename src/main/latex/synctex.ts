/**
 * SyncTeX 双向定位 —— 源码行 ↔ PDF 位置，用 TeX 发行版自带的 `synctex` 命令，
 * 不加任何依赖、不读 .synctex.gz 的二进制格式（那是另一套解析器，出问题时无从对证；
 * 而 `synctex` 与引擎同版本，它的解释就是 TeX 的解释）。
 *
 * 两条命令（均以项目目录为 cwd，两侧路径都用绝对路径——实测 Windows 反斜杠与
 * 正斜杠都能被 synctex 认）：
 *
 *   synctex view  -i <line>:<column>:<file> -o <pdf>     → Page: / x: / y: / h: / v: / W: / H:
 *   synctex edit  -o <page>:<x>:<y>:<pdf>                → Input: / Line: / Column:
 *
 * **坐标契约**在 `shared/latex.ts` 的 `LatexSyncRect` 上写死了：PDF 点（1/72 英寸）、
 * 原点页面左上、y 向下。synctex 的 `view` 输出的 y 正是「到页顶的距离」（实测：
 * A4 页高 841.89，正文基线的 PDF 内部坐标是自下而上 640.40，输出 y = 201.49），
 * 所以这里**不做翻转**；横向取 `h`（这一行盒子在页面上的左缘）与 `W`（盒子宽），
 * 纵向取 `v − H` 到 `v`（`v` 是基线加上下伸部，`H` 是基线上方的高度）。不用 `x`：
 * 它指向行内某个词边界，做「整行高亮」时会跑进句子中间。
 *
 * **失败必须说清是哪一种**（见 `LatexSyncFailureReason`）：没有 .synctex.gz 与
 * 「synctex 跑完但没命中」是两件事——前者要用户重新编译，后者多半是源码改过没重编。
 * synctex 本身在缺数据 / 路径不存在时**静默退出 0**（实测），所以这三种前提
 * （PDF 在、.synctex.gz 在）在起进程之前就各自核一遍，不靠退出码猜。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  LatexForwardOutcome,
  LatexReverseOutcome,
  LatexSyncFailure,
  LatexSyncFailureReason,
  LatexSyncRect,
} from "../../shared/latex.ts";

/** 单次定位的等待上限：synctex 只读索引，正常在 100 ms 量级；15 秒还没回来是坏了 */
const SYNCTEX_TIMEOUT_MS = 15_000;

/** 输出上限：view 对一整段可能回几十条记录，1 MB 已经远超正常需要 */
const SYNCTEX_OUTPUT_LIMIT = 1024 * 1024;

export interface SynctexViewBox {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface SynctexEditHit {
  input: string;
  line: number;
  column: number | null;
}

export interface SynctexRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起不来的原因（ENOENT / EACCES…）；非 null 时 `code` 无意义 */
  spawnError: string | null;
}

export interface SynctexDeps {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  run(command: string, argv: string[], cwd: string): Promise<SynctexRunResult>;
}

export interface SynctexForwardArgs {
  /** 项目目录（命令的 cwd） */
  dir: string;
  /** 源码绝对路径；必须在项目目录内 */
  file: string;
  /** PDF 绝对路径（项目的产物） */
  pdf: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列（可选） */
  column: number;
  /** 探测到的 latexmk 路径：synctex 与它同目录 */
  latexmk: string | null;
}

export interface SynctexReverseArgs {
  dir: string;
  pdf: string;
  /** 1 基页码 */
  page: number;
  /** PDF 点，原点页面左上 */
  x: number;
  y: number;
  latexmk: string | null;
}

/** 解析 `synctex view` 的输出。多页 / 一行多盒时会出多条记录 */
export function parseViewOutput(stdout: string): SynctexViewBox[] {
  const boxes: SynctexViewBox[] = [];
  /**
   * 页码**单独存**：一个页里续第二个盒时对象是新开的，盒子自己不重复记页码
   * （把 page 放在 current 上，flush 之后新盒就丢了 page，整盒被静默丢掉）。
   */
  let page: number | null = null;
  let current: Partial<SynctexViewBox> | null = null;
  const flush = (): void => {
    if (
      page !== null &&
      current !== null &&
      typeof current.x === "number" &&
      typeof current.y === "number"
    ) {
      boxes.push({
        page,
        x: current.x,
        y: current.y,
        h: typeof current.h === "number" ? current.h : current.x,
        v: typeof current.v === "number" ? current.v : current.y,
        width: typeof current.width === "number" ? current.width : 0,
        height: typeof current.height === "number" ? current.height : 0,
      });
    }
    current = null;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    const number = Number(value);
    switch (key) {
      case "Page": {
        // 新页开始：上一页的最后一个盒先收下
        flush();
        page = Number.isFinite(number) ? number : null;
        break;
      }
      // 一组盒以 x: 开头；同一页里第二组 x: 说明上一个盒已经完整
      case "x": {
        if (current !== null && typeof current.x === "number") flush();
        if (!Number.isFinite(number)) break;
        current ??= {};
        current.x = number;
        break;
      }
      case "y":
        if (current !== null && Number.isFinite(number)) current.y = number;
        break;
      case "h":
        if (current !== null && Number.isFinite(number)) current.h = number;
        break;
      case "v":
        if (current !== null && Number.isFinite(number)) current.v = number;
        break;
      case "W":
        if (current !== null && Number.isFinite(number)) current.width = number;
        break;
      case "H":
        if (current !== null && Number.isFinite(number)) current.height = number;
        break;
      case "SyncTeX result end":
        flush();
        page = null;
        break;
      default:
        break;
    }
  }
  flush();
  return boxes;
}

/** 解析 `synctex edit` 的输出（可有多条命中，按出现顺序） */
export function parseEditOutput(stdout: string): SynctexEditHit[] {
  const hits: SynctexEditHit[] = [];
  let input: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  const flush = (): void => {
    if (input !== null && line !== null) hits.push({ input, line, column });
    input = null;
    line = null;
    column = null;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const text = raw.trim();
    const at = text.indexOf(":");
    if (at < 0) continue;
    const key = text.slice(0, at);
    const value = text.slice(at + 1).trim();
    if (key === "Input") {
      // 下一条命中开始
      flush();
      if (value !== "") input = value;
      continue;
    }
    if (key === "Line") {
      const number = Number(value);
      if (Number.isFinite(number)) line = number;
      continue;
    }
    if (key === "Column") {
      const number = Number(value);
      column = Number.isFinite(number) && number > 0 ? number : null;
      continue;
    }
    if (key === "SyncTeX result end") flush();
  }
  flush();
  return hits;
}

/** 一个 view 盒 → 契约里的 PDF 矩形（左上原点、y 向下、单位 PDF 点） */
export function toPdfRect(box: SynctexViewBox): LatexSyncRect {
  const height = box.height > 0 ? box.height : 10;
  const bottom = box.v > 0 ? box.v : box.y + height;
  return {
    page: box.page,
    left: Math.max(0, box.h),
    top: Math.max(0, bottom - height),
    width: Math.max(0, box.width),
    height,
  };
}

/**
 * `synctex` 可执行文件：与 latexmk 同目录（TeX Live / MiKTeX 都把整套工具装在一起）。
 * latexmk 是 PATH 上的裸名字时（dirname = "."），同目录探测不会命中，直接回裸名字
 * 让 OS 顺着同一条 PATH 找——那里也一定有 synctex。
 */
export function synctexCommand(
  latexmk: string | null,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string {
  const names = platform === "win32" ? ["synctex.exe", "synctex.bat", "synctex.cmd", "synctex"] : ["synctex"];
  if (latexmk !== null && latexmk !== "") {
    const dir = dirname(latexmk);
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return "synctex";
}

/**
 * PDF 旁边的 SyncTeX 索引。latexmk 的 `-synctex=1` 把它写在 PDF 同一个目录，
 * 名字是 PDF 基础名 + `.synctex.gz`（未压缩时是 `.synctex`）。
 */
export function synctexFile(pdf: string, exists: (path: string) => boolean): string | null {
  const base = pdf.slice(0, pdf.length - extname(pdf).length);
  for (const candidate of [`${base}.synctex.gz`, `${base}.synctex`]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** 源码 → PDF 位置 */
export async function forwardSearch(
  args: SynctexForwardArgs,
  deps: SynctexDeps = realDeps(),
): Promise<LatexForwardOutcome> {
  const pdf = resolve(args.pdf);
  const guard = guardInputs(pdf, deps);
  if (guard !== null) return guard;

  const command = synctexCommand(args.latexmk, deps.platform, deps.exists);
  const input = `${Math.max(1, Math.floor(args.line))}:${Math.max(1, Math.floor(args.column))}:${resolve(args.file)}`;
  const outcome = await deps.run(command, ["view", "-i", input, "-o", pdf], args.dir);
  const failure = commandFailure(outcome, command);
  if (failure !== null) return failure;
  const boxes = parseViewOutput(outcome.stdout);
  if (boxes.length === 0) return fail("no-result", null);
  // 一行跨页时 synctex 给多条：取第一条（行首所在的那一页）就是用户要跳的位置
  return { ok: true, rect: toPdfRect(boxes[0]!) };
}

/** PDF 页面坐标 → 源码行 */
export async function reverseSearch(
  args: SynctexReverseArgs,
  deps: SynctexDeps = realDeps(),
): Promise<LatexReverseOutcome> {
  const pdf = resolve(args.pdf);
  const guard = guardInputs(pdf, deps);
  if (guard !== null) return guard;

  const command = synctexCommand(args.latexmk, deps.platform, deps.exists);
  const page = Math.max(1, Math.floor(args.page));
  // 坐标只保留到 0.01 pt：synctex 自己的输出就是这个精度，多余的位数只是噪声
  const point = `${page}:${round2(args.x)}:${round2(args.y)}:${pdf}`;
  const outcome = await deps.run(command, ["edit", "-o", point], args.dir);
  const failure = commandFailure(outcome, command);
  if (failure !== null) return failure;

  const hits = parseEditOutput(outcome.stdout);
  if (hits.length === 0) return fail("no-result", null);
  for (const hit of hits) {
    const mapped = insideProject(args.dir, hit.input);
    if (mapped !== null) return { ok: true, file: mapped.file, relative: mapped.relative, line: hit.line };
  }
  // 命中的全是项目外的文件（系统 .cls / .sty）：这不是「找不到」，是这一页这一点
  // 不属于用户的源码——分开报，用户才知道该点哪儿
  return fail("outside-project", hits[0]!.input);
}

/** 正向查找的路径前提：PDF 与 .synctex.gz 都得在（synctex 缺数据时静默退出 0） */
function guardInputs(pdf: string, deps: SynctexDeps): LatexSyncFailure | null {
  if (!deps.exists(pdf)) return fail("no-pdf", pdf);
  if (synctexFile(pdf, deps.exists) === null) return fail("no-synctex", pdf);
  return null;
}

function commandFailure(outcome: SynctexRunResult, command: string): LatexSyncFailure | null {
  if (outcome.spawnError !== null) return fail("not-installed", `${command}: ${outcome.spawnError}`);
  if (outcome.code !== 0) {
    const stderr = outcome.stderr.trim();
    return fail("failed", stderr === "" ? `${command} exited with code ${String(outcome.code)}` : stderr);
  }
  return null;
}

/**
 * synctex 记下的输入路径 → 项目内的绝对路径。`Input:` 里常见 `<项目>/./sections/a.tex`
 * 这种带 `./` 的写法（resolve 顺带清掉），项目外的（TeX 安装目录里的 .cls / .sty）
 * 一律回 null——界面不该替用户打开系统文件。
 */
export function insideProject(
  dir: string,
  input: string,
): { file: string; relative: string } | null {
  const root = resolve(dir);
  const file = resolve(input);
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return { file, relative: rel.split(sep).join("/") };
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function fail(reason: LatexSyncFailureReason, detail: string | null): LatexSyncFailure {
  return { ok: false, reason, detail };
}

/** 生产依赖：真盘 + 真 execFile（不经过 shell——参数表固定，少一层解释） */
function realDeps(): SynctexDeps {
  return {
    platform: process.platform,
    exists: (path) => existsSync(path),
    run: (command, argv, cwd) =>
      new Promise((resolvePromise) => {
        execFile(
          command,
          argv,
          { cwd, timeout: SYNCTEX_TIMEOUT_MS, windowsHide: true, maxBuffer: SYNCTEX_OUTPUT_LIMIT },
          (error, stdout, stderr) => {
            if (error === null) {
              resolvePromise({ code: 0, stdout, stderr, spawnError: null });
              return;
            }
            const code = (error as NodeJS.ErrnoException).code;
            // 字符串 code = 进程没起来（ENOENT / EACCES）；数字 = 起来了但非零退出
            if (typeof code === "string") {
              resolvePromise({ code: null, stdout, stderr, spawnError: code });
              return;
            }
            resolvePromise({
              code: typeof code === "number" ? code : null,
              stdout,
              stderr,
              spawnError: null,
            });
          },
        );
      }),
  };
}
