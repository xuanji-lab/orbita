/**
 * agent 的 `new_paper` 请求 → 授权 → 写模板 → 回执载荷。
 *
 * 与 agent-requests.ts（compile_latex）同一条边界：**写盘在主进程**，agent 进程
 * 只发 `newPaperRequest` 等 `newPaperResult`。理由是 agent 不持有 fs 策略——
 * 「哪些目录算本会话的」只有一处实现（agent/session-roots.ts + terminal/agent-policy.ts）。
 *
 * 与编译的三处不同，都是有意的：
 *
 * 1. **目标的目录可以不存在**，所以不能直接用 resolveAgentCwd（它要求 realpath
 *    成功）。这里对不存在的路径取「最近的已存在祖先」过 realpath，再把剩余段
 *    拼回去判授权——祖先落在授权目录内，新建的目录才会落在里面；符号链接因此
 *    也逃不出去。复用同一份根名单与大小写口径（pathWithinRoot）。
 * 2. **目录必须不存在或为空**。理由不是洁癖：模板会写 main.tex / refs.bib /
 *    figures/example.png，任何一个同名文件被覆盖，用户丢的是自己的论文。所以
 *    先整目录看一眼，非空就一个字都不写——「报错 + 已有内容原封不动」比
 *    「写了一半再回滚」可预期。
 * 3. **失败不装成功**：越界、非空、写盘异常都走 `{ ok: false }`，工具层把它
 *    抛成一次工具失败，模型据此换目录名/先清理，而不是以为项目已经建好。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { NewPaperOutcome, NewPaperRequest } from "../../shared/latex.ts";
import {
  sessionAuthorizedRoots,
  type SessionRootsSource,
  type WorkspaceRootsSource,
} from "../agent/session-roots.ts";
import {
  pathWithinRoot,
  realAuthorizedRoots,
  type AgentCwdDeps,
} from "../terminal/agent-policy.ts";
import { paperTemplateFiles, writePaperTemplate } from "./paper-template.ts";

/** 真的 fs 依赖（agent-policy 的注入点；生产只用真的） */
const fsDeps: AgentCwdDeps = {
  realpath: (path: string): string => realpathSync(path),
  isDirectory: (path: string): boolean => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/** 非空目录报错时最多列几个条目：够模型认出「这是我刚才建的项目」就行 */
const MAX_LISTED_ENTRIES = 5;

export async function applyNewPaperRequest(
  sessions: SessionRootsSource,
  workspaces: WorkspaceRootsSource,
  event: { sessionId: string; request: NewPaperRequest },
): Promise<NewPaperOutcome> {
  try {
    const roots = await sessionAuthorizedRoots(sessions, workspaces, event.sessionId);
    const target = resolvePaperDir(event.request.dir, roots);
    if (!target.ok) return { ok: false, error: target.error };

    const dir = target.dir;
    // mkdir 前就有的条目（null = 目录本来不存在）。这一步是「不覆盖任何东西」的
    // 唯一闸门：模板文件清单是固定的，目录空则同名文件不可能存在。
    const existing = listEntries(dir);
    if (existing !== null && existing.length > 0) {
      return { ok: false, error: notEmptyError(dir, existing) };
    }
    // 极端窄的竞态兜底（我们在检查之后、写之前有人放进了一个文件）：拒绝而不是覆盖
    for (const file of paperTemplateFiles()) {
      const path = resolve(dir, ...file.path.split("/"));
      if (existsSync(path)) {
        return { ok: false, error: `${path} already exists — new_paper never overwrites files, pick another directory.` };
      }
    }

    mkdirSync(dir, { recursive: true });
    const files = writePaperTemplate(dir, event.request.title);
    return { ok: true, result: { dir, files } };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 目标目录解析与授权。
 *
 * - 缺席 / 空串 = 会话 cwd（与 compile_latex 同一口径）。
 * - 相对路径按 **roots[0]** 解析：applyLatexRequest 已经定了这个基准
 *   （它的 defaultCwd 就是 roots[0]），两处必须同一个，否则「同一个 dir 相对谁」
 *   有两个答案。
 * - 已存在：realpath 后判授权、判目录。
 * - 不存在：最近的已存在祖先 realpath 后拼回剩余段，再判授权。
 */
export function resolvePaperDir(
  input: string | undefined,
  roots: readonly string[],
): { ok: true; dir: string } | { ok: false; error: string } {
  const realRoots = realAuthorizedRoots(roots, fsDeps);
  if (realRoots.length === 0) {
    return { ok: false, error: "This session has no authorized directory to create a paper project in." };
  }
  const defaultCwd = roots[0] ?? "";
  const wanted = input === undefined || input.trim() === "" ? defaultCwd : input.trim();
  if (wanted === "") {
    return { ok: false, error: "This session has no working directory to create a paper project in — pass dir." };
  }
  const resolved = isAbsolute(wanted) ? wanted : resolve(defaultCwd, wanted);

  // 已存在（含符号链接目标）：以 realpath 为准，否则一个链接就能把论文写到授权目录外
  const real = tryRealpath(resolved);
  if (real !== null) {
    if (!inside(realRoots, real)) return { ok: false, error: outsideError(real, roots) };
    if (!fsDeps.isDirectory(real)) return { ok: false, error: `"${real}" is not a directory.` };
    return { ok: true, dir: real };
  }

  // 不存在：祖先 realpath + 剩余段。剩余段由 dirname 一路上拆出来，不含 ".."
  //（resolve 已经规范化过），所以拼回去不会跑出祖先。
  const ancestor = nearestExistingAncestor(resolved);
  if (ancestor === null) return { ok: false, error: `"${resolved}" cannot be created.` };
  const candidate = resolve(ancestor.real, ...ancestor.rest);
  if (!inside(realRoots, candidate)) return { ok: false, error: outsideError(candidate, roots) };
  return { ok: true, dir: candidate };
}

function inside(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => pathWithinRoot(root, candidate));
}

function outsideError(candidate: string, roots: readonly string[]): string {
  return (
    `"${candidate}" is outside this session's authorized directories (${roots.join(", ")}). ` +
    "Agent paper projects may only be created there — omit dir to use the session's working directory."
  );
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 最近的存在祖先 + 从它到目标之间缺的段（顺序由深到浅拆、再翻回来）。
 * 根目录都 realpath 不了的话返回 null（Windows 上盘符不存在会走到这里）。
 */
function nearestExistingAncestor(target: string): { real: string; rest: string[] } | null {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    const real = tryRealpath(current);
    if (real !== null) return { real, rest: rest.reverse() };
    const parent = dirname(current);
    if (parent === current) return null;
    rest.push(relative(parent, current));
    current = parent;
  }
}

/** 目录里的条目；目录不存在时 null（**不是空数组**——两者含义不同） */
function listEntries(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function notEmptyError(dir: string, entries: readonly string[]): string {
  const shown = [...entries].sort().slice(0, MAX_LISTED_ENTRIES);
  const more = entries.length - shown.length;
  return (
    `"${dir}" is not empty (${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}). ` +
    "new_paper only writes into a missing or empty directory and never overwrites files — " +
    "pick a new directory name (for example the paper's short title) and retry."
  );
}
