/**
 * 把一条候选文献写进项目的 .bib（`cite:save` 的实做，纯模块：不 import electron）。
 *
 * **写哪一份文件**，按用户能预期的顺序：
 * 1. 主文件里声明的第一份 `.bib`（`\bibliography{refs/lit}` / `\addbibresource{…}`）——
 *    那才是编译时真正读的那份。没有它，写进 refs.bib 而文档引用 refs/lit 就是「写成功
 *    了但 \cite 仍未定义」（评审 F5）。声明的那份还不存在就按它建。
 * 2. 项目根的 `refs.bib`（最常见的约定）。
 * 3. 扫描顺序里的第一份 `.bib`（按相对路径排序，任何机器上都一样）。
 * 4. 一份都没有：在主文件旁新建 `refs.bib`（主文件在 `chapters/` 里就建在 `chapters/`）。
 *
 * **不覆盖**：读到的原文指纹当 `expectedHash` 交给 `files/write.ts` 的原子写，它写前
 * 重读并比对；中间被 agent / 另一个编辑器 / 用户自己改过就回 conflict，一个字都不写。
 * 新建走 `open(path, "wx")` **独占创建**：两个人同时保存时只有一个建得成，另一个回
 * conflict，不会互相把先写的那条抹掉（评审 F4）。
 *
 * **写不到项目外**：`.orbita/latex.json` 里 `main: ../outside/main.tex` 这种手改配置
 * 会让「主文件旁新建」落到工作区外（评审 F16）。主文件与最终目标都要重新过一遍
 * 「在项目目录内」的判定，越界回 outside-project，不写。
 *
 * **同一篇不写第二份**：按 DOI / arXiv 号在项目里所有 .bib 中查一遍，命中就复用它的
 * key、不追加（评审 F6）。key 去重也扫**全部** .bib（评审 F3）——只查目标文件会让
 * `\cite` 在两条同名 key 之间指向不确定的那条。
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CITE_PREFERRED_BIB,
  type CiteCandidate,
  type CiteEntry,
  type CiteSaveOutcome,
} from "../../shared/cite.ts";
import { contentHash, EDITOR_WRITE_LIMIT, type FileWriteResult } from "../../shared/files.ts";
import { samePath } from "../../shared/path.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { writeEditedFile } from "../files/write.ts";
import { declaredBibFiles } from "./bibliography.ts";
import { collectCiteLibrary, scanBibFiles } from "./library.ts";
import { appendBibEntry, bibKeyBase, formatBibEntry, uniqueBibKey } from "./entry.ts";
import { parseBibtex } from "./bib.ts";

/** 要写的那一份：绝对路径 + 现在是否存在 */
interface BibTarget {
  path: string;
  exists: boolean;
}

/** 选目标的结局：要么一份目标，要么「这个位置在项目外」（带上是哪条路径） */
export interface BibChoice {
  target: BibTarget | null;
  /** 非 null = 需要写的那个位置落在项目外（主文件或声明里写的），不许写 */
  outside: string | null;
}

/**
 * 选目标文件。`declared` 是主文件里声明过的 `.bib`（相对项目目录），`files` 是
 * `scanBibFiles` 的绝对路径清单（已按相对路径排序），`mainOutside` 是「主文件在
 * 项目外」时它的原始路径（否则 null）。
 */
export function chooseBibTarget(
  projectDir: string,
  declared: readonly string[],
  files: readonly string[],
  mainOutside: string | null,
): BibChoice {
  const dir = resolve(projectDir);

  const firstDeclared = declared[0];
  if (firstDeclared !== undefined) {
    const abs = insideProject(dir, firstDeclared);
    if (abs === null) return { target: null, outside: firstDeclared };
    return { target: { path: abs, exists: isFile(abs) }, outside: null };
  }

  const preferred = join(dir, CITE_PREFERRED_BIB);
  const topLevel = files.find((path) => samePath(resolve(path), preferred));
  if (topLevel !== undefined) return { target: { path: topLevel, exists: true }, outside: null };
  // 存在但扫描没看到（例如扫描上限之外）：仍然优先它
  if (isFile(preferred)) return { target: { path: preferred, exists: true }, outside: null };

  const first = files[0];
  if (first !== undefined) return { target: { path: resolve(first), exists: true }, outside: null };

  if (mainOutside !== null) return { target: null, outside: mainOutside };
  return { target: { path: join(dir, CITE_PREFERRED_BIB), exists: false }, outside: null };
}

/**
 * 写盘的出口（默认 `files/write.ts` 的原子写）。抽成参数只有一个理由：测试要能
 * 制造「读完之后、写之前盘上被改过」这一格——那是这套写法的核心承诺（不覆盖），
 * 不能只靠一个「碰时间窗」的并发测试去碰运气。
 */
export type CiteWriteFn = (
  path: string,
  text: string,
  expectedHash: string | null,
) => Promise<FileWriteResult>;

export interface CiteWriteDeps {
  write?: CiteWriteFn;
}

/**
 * 追加一条候选。`projectDir` 必须已过白名单（调用方 `main/cite/ipc.ts` 用
 * `locateLatexProject` 拿到它）。`mainRelative` 是主文件相对项目目录的路径。
 */
export async function writeCiteEntry(
  projectDir: string,
  mainRelative: string | null,
  candidate: CiteCandidate,
  deps: CiteWriteDeps = {},
): Promise<CiteSaveOutcome> {
  const dir = resolve(projectDir);
  const library = collectCiteLibrary(dir);

  // F6：库里已经有同一篇（同 DOI 或同 arXiv 号）→ 复用它的 key，不追加第二份
  const same = library.entries.find((entry) => isSameWork(entry, candidate));
  if (same !== undefined) {
    return { ok: true, path: same.file, key: same.key, created: false, reused: true };
  }

  const mainPath = mainRelative === null ? null : insideProject(dir, mainRelative);
  const mainOutside = mainRelative !== null && mainPath === null ? mainRelative : null;
  const declared = mainPath === null ? [] : declaredBibFiles(readTextOrEmpty(mainPath)).map((item) => item.path);

  const choice = chooseBibTarget(dir, declared, scanBibFiles(dir).files, mainOutside);
  if (choice.target === null) {
    return { ok: false, reason: "outside-project", detail: choice.outside ?? "" };
  }
  const target = choice.target;
  // 最终目标再过一次「在项目内」：选目标那一步已经核过，这里是第二道闸
  if (insideProject(dir, target.path) === null) {
    return { ok: false, reason: "outside-project", detail: toForwardSlashes(relative(dir, target.path)) };
  }
  const rel = toForwardSlashes(relative(dir, target.path));

  let source = "";
  if (target.exists) {
    try {
      const stats = statOrNull(target.path);
      if (stats === null) {
        // stat 不到：当成「刚被删掉」，按新建走（下面独占创建会抢到或撞 conflict）
        return await createEntry(target.path, rel, candidate, library.entries);
      }
      if (!stats.isFile()) return { ok: false, reason: "read-failed", detail: `not-a-file: ${rel}` };
      if (stats.size > EDITOR_WRITE_LIMIT) {
        return { ok: false, reason: "too-large", detail: `too-large: ${rel} (${stats.size} > ${EDITOR_WRITE_LIMIT})` };
      }
      source = await readFile(target.path, "utf8");
    } catch (cause) {
      return { ok: false, reason: "read-failed", detail: messageOf(cause) };
    }
  } else {
    return await createEntry(target.path, rel, candidate, library.entries);
  }

  // key 去重按**项目里全部 .bib 现在盘上的 key** 算（F3）
  const key = uniqueAcrossProject(bibKeyBase(candidate), library.entries, source);
  const text = appendBibEntry(source, formatBibEntry(candidate, key));

  try {
    const write = deps.write ?? writeEditedFile;
    const result = await write(target.path, text, contentHash(source));
    if (result.kind === "written") return { ok: true, path: rel, key, created: false, reused: false };
    if (result.kind === "conflict") return { ok: false, reason: "conflict", detail: rel };
    return {
      ok: false,
      reason: "too-large",
      detail: `too-large: ${rel} (${result.size} > ${result.limit})`,
    };
  } catch (cause) {
    return { ok: false, reason: "write-failed", detail: messageOf(cause) };
  }
}

/**
 * 新建一份 `.bib`。`open(path, "wx")` 是**独占创建**：文件已存在会被内核直接拒
 * （EEXIST），所以两个人同时点「选这条」时只有一个建得成，另一个拿到 conflict，
 * 先写的那条不会消失（F4）。占位文件建好后用原子写填内容——读者要么看到空文件，
 * 要么看到完整内容，不会看到半条。
 */
async function createEntry(
  path: string,
  rel: string,
  candidate: CiteCandidate,
  libraryEntries: readonly CiteEntry[],
): Promise<CiteSaveOutcome> {
  const key = uniqueAcrossProject(bibKeyBase(candidate), libraryEntries, "");
  const text = appendBibEntry("", formatBibEntry(candidate, key));
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx");
    await handle.close();
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") return { ok: false, reason: "conflict", detail: rel };
    return { ok: false, reason: "write-failed", detail: messageOf(cause) };
  }
  try {
    await writeTextAtomic(path, text);
  } catch (cause) {
    return { ok: false, reason: "write-failed", detail: messageOf(cause) };
  }
  return { ok: true, path: rel, key, created: true, reused: false };
}

/**
 * key 在**整个项目**里不重名：先按所有 .bib 解析出的 key，再按目标文件此刻的原文
 * （它可能比 library 扫描更新）。两份都用同一条规则比较（大小写不敏感）。
 */
function uniqueAcrossProject(base: string, entries: readonly CiteEntry[], targetSource: string): string {
  // 目标文件此刻的原文也算进来：它可能比 library 那次扫描更新（同一轮里刚被改过）
  const keys = [...entries.map((entry) => entry.key), ...parseBibtex(targetSource).entries.map((entry) => entry.key)];
  return uniqueBibKey(base, keys);
}

/** 同一条文献：DOI 或 arXiv 号命中就算（忽略 URL 前缀、大小写、arXiv 版本号） */
function isSameWork(entry: CiteEntry, candidate: CiteCandidate): boolean {
  const doi = normalizeDoi(candidate.doi);
  if (doi !== null && normalizeDoi(entry.doi) === doi) return true;
  const arxiv = normalizeArxiv(candidate.arxivId);
  return arxiv !== null && normalizeArxiv(entry.eprint) === arxiv;
}

/**
 * `https://doi.org/10.x/Y` / `10.X/y` / `.bib` 里的 `10.x/Y\_1` 都是同一个 DOI。
 * **盘上的值带 TeX 转义**（我们自己写进去时就转义了 `_`），比对前必须还原，
 * 否则「同一篇再选一次」认不出来，会追第二份（真机验收抓到）。
 */
export function normalizeDoi(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = unescapeTex(value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/** `arXiv:1706.03762v7` → `1706.03762`（同样还原一次 TeX 转义） */
export function normalizeArxiv(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = unescapeTex(value).trim().replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "");
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/** `\_` → `_`、`\&` → `&`：只还原我们写进 .bib 的那几个字符 */
function unescapeTex(value: string): string {
  return value.replace(/\\([&%_#$])/g, "$1");
}

/**
 * 一个路径是否在项目目录内：是则回绝对路径，否则 null。
 * 与 `files/list.ts` 的 `whitelistedPath` 同一个判定口径（relative 不以 `..` 开头、
 * 不是绝对路径）。写目标这一层自己再核一次，是因为 `main` / `\bibliography` 都可以
 * 指向项目外（评审 F16）。
 */
function insideProject(projectDir: string, path: string): string | null {
  const abs = resolve(projectDir, path);
  const rel = relative(projectDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function isFile(path: string): boolean {
  return statOrNull(path)?.isFile() === true;
}

function statOrNull(path: string): { isFile: () => boolean; size: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** 主文件读不了（被删 / 权限）：当作「没声明」，退回按约定猜的那套 */
function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function toForwardSlashes(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).join("/");
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message.split("\n")[0] ?? cause.message;
  return String(cause);
}

function errorCode(cause: unknown): string | null {
  if (cause instanceof Error && "code" in cause) {
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
