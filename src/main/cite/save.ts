/**
 * 把一条候选文献写进项目的 .bib（`cite:save` 的实做，纯模块：不 import electron）。
 *
 * **写哪一份文件**，按用户能预期的顺序：
 * 1. 项目根的 `refs.bib`（论文仓最常见的名字；用户加了 `\bibliography{refs}` 就是这份）；
 * 2. 否则扫描顺序里的第一份 `.bib`（扫描按相对路径排序，所以「第一份」在任何机器
 *    上都一样，不会因为 readdir 顺序而这次写 A、下次写 B）；
 * 3. 一份都没有：在主文件旁新建 `refs.bib`（主文件在 `chapters/` 里就建在 `chapters/`
 *    里——那是用户 `\bibliography` 的相对基准）。
 *
 * **不覆盖**：读到的原文指纹当 `expectedHash` 交给 `files/write.ts` 的原子写，它写前
 * 重读并比对；中间被 agent / 另一个编辑器 / 用户自己改过就回 conflict，一个字都不写。
 * 复用那一条通道也复用了它的排队（同一路径的写不交错）与临时文件 + rename——
 * `.bib` 写到一半崩掉会让整篇论文编不出来。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  CITE_PREFERRED_BIB,
  type CiteCandidate,
  type CiteSaveOutcome,
} from "../../shared/cite.ts";
import { contentHash, EDITOR_WRITE_LIMIT, type FileWriteResult } from "../../shared/files.ts";
import { samePath } from "../../shared/path.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { writeEditedFile } from "../files/write.ts";
import { parseBibtex } from "./bib.ts";
import { appendBibEntry, bibKeyBase, formatBibEntry, uniqueBibKey } from "./entry.ts";
import { scanBibFiles } from "./library.ts";

/** 要写的那一份：绝对路径 + 现在是否存在 */
interface BibTarget {
  path: string;
  exists: boolean;
}

/**
 * 选目标文件。`files` 是 `scanBibFiles` 的绝对路径清单（已按相对路径排序），
 * `mainRelative` 是主文件相对项目目录的路径（没有主文件时 null）。
 */
export function chooseBibTarget(
  projectDir: string,
  mainRelative: string | null,
  files: readonly string[],
): BibTarget {
  const dir = resolve(projectDir);
  const preferred = join(dir, CITE_PREFERRED_BIB);
  const topLevel = files.find((path) => samePath(resolve(path), preferred));
  if (topLevel !== undefined) return { path: topLevel, exists: true };
  // 存在但扫描没看到（例如刚被 .gitignore 之外的规则排除）也仍然优先它
  if (isFile(preferred)) return { path: preferred, exists: true };

  const first = files[0];
  if (first !== undefined) return { path: resolve(first), exists: true };

  const base = mainRelative === null ? dir : join(dir, dirname(mainRelative));
  return { path: join(base, CITE_PREFERRED_BIB), exists: false };
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
 * `locateLatexProject` 拿到它）。
 */
export async function writeCiteEntry(
  projectDir: string,
  mainRelative: string | null,
  candidate: CiteCandidate,
  deps: CiteWriteDeps = {},
): Promise<CiteSaveOutcome> {
  const dir = resolve(projectDir);
  const target = chooseBibTarget(dir, mainRelative, scanBibFiles(dir).files);
  const rel = toForwardSlashes(relative(dir, target.path));

  let source = "";
  if (target.exists) {
    try {
      const stats = statSync(target.path);
      if (!stats.isFile()) {
        return { ok: false, reason: "read-failed", detail: `${rel} 不是一份文件` };
      }
      if (stats.size > EDITOR_WRITE_LIMIT) {
        return { ok: false, reason: "too-large", detail: rel };
      }
      source = readFileSync(target.path, "utf8");
    } catch (cause) {
      return { ok: false, reason: "read-failed", detail: messageOf(cause) };
    }
  }

  // key 去重按**盘上现在**的 key 算（大小写不敏感：引用时几乎不会有人靠大小写区分）
  const existing = parseBibtex(source).entries.map((entry) => entry.key);
  const key = uniqueBibKey(bibKeyBase(candidate), existing);
  const text = appendBibEntry(source, formatBibEntry(candidate, key));

  if (!target.exists) {
    try {
      // 新建也用原子写：半份 refs.bib 比没有更难查
      await writeTextAtomic(target.path, text);
    } catch (cause) {
      return { ok: false, reason: "write-failed", detail: messageOf(cause) };
    }
    return { ok: true, path: rel, key, created: true };
  }

  try {
    const write = deps.write ?? writeEditedFile;
    const result = await write(target.path, text, contentHash(source));
    if (result.kind === "written") return { ok: true, path: rel, key, created: false };
    if (result.kind === "conflict") return { ok: false, reason: "conflict", detail: rel };
    return {
      ok: false,
      reason: "too-large",
      detail: `${rel}（${result.size} > ${result.limit}）`,
    };
  } catch (cause) {
    return { ok: false, reason: "write-failed", detail: messageOf(cause) };
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toForwardSlashes(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).join("/");
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message.split("\n")[0] ?? cause.message;
  return String(cause);
}
