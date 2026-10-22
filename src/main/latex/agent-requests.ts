/**
 * agent 的 LaTeX 编译请求 → 授权 → 内核（run.ts）→ 回执载荷。
 *
 * **这里没有 renderer 的 IPC**：`latex:compile` / `latex:probe` 与 preload 面等到
 * PR3 有预览面板时再加——当前仓里没有任何调用点，按消费者纪律不进仓（评审 M6）。
 * agent 工具 `compile_latex` 是当前唯一的消费者（runtime.ts 注册 →
 * `latexRequest` → 这里 → `latexResult`），与 terminalRequest 同一条边界。
 *
 * **授权**：`dir` 必须落在会话授权目录内（工作区根 + 附加目录），与终端 cwd 授权
 * 共用一套 realpath / 越界判定（terminal/agent-policy.ts 的 resolveAgentCwd）与
 * 同一份根名单（agent/session-roots.ts）。理由不只是「别写错地方」：TeX 文档能用
 * \input 读任意路径的文件、把内容排进 PDF，编译一个来路不明的 .tex 等价于让模型
 * 读那些文件。
 *
 * `main` 只许是**目录内的相对路径**：绝对路径、Windows 盘符相对路径（`D:x.tex`）
 * 或带 `..` 的一律拒绝，否则「编这个目录里的文件」这条授权会被一个参数绕过去。
 * 项目自己的 `.orbita/latex.json` 不受此限——那是用户写在自己目录里的配置，
 * 不是模型这一次的入参。
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isLatexEngine, type LatexCompileRequest, type LatexRunOutcome } from "../../shared/latex.ts";
import {
  sessionAuthorizedRoots,
  type SessionRootsSource,
  type WorkspaceRootsSource,
} from "../agent/session-roots.ts";
import { resolveAgentCwd, type AgentCwdDeps } from "../terminal/agent-policy.ts";
import type { LatexRunner } from "./run.ts";

/** 真的 fs 依赖（agent-policy 的注入点，生产环境就用真的） */
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

const LATEX_CWD_POLICY = {
  subject: "LaTeX build",
  hint: " — omit dir to compile in the session's working directory.",
};

/**
 * agent 的编译请求。**任何路径都回执**——挂着不回的话 agent 进程里那次工具调用
 * 永远等下去（terminalRequest 同一条纪律）。`dir` 相对会话 cwd 解析，
 * 并硬校验在授权目录内。
 */
export async function applyLatexRequest(
  runner: Pick<LatexRunner, "compile">,
  sessions: SessionRootsSource,
  workspaces: WorkspaceRootsSource,
  event: { sessionId: string; request: LatexCompileRequest },
): Promise<LatexRunOutcome> {
  try {
    const roots = await sessionAuthorizedRoots(sessions, workspaces, event.sessionId);
    const resolved = resolveAgentCwd(
      event.request.dir,
      { roots, defaultCwd: roots[0] ?? "" },
      fsDeps,
      LATEX_CWD_POLICY,
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const main = cleanMain(event.request.main);
    if (main !== undefined && !mainInsideDir(resolved.cwd, main)) {
      return { ok: false, error: "main must be a relative path inside dir (no absolute paths, no '..')." };
    }
    const engine = isLatexEngine(event.request.engine) ? event.request.engine : undefined;
    return await runner.compile({
      dir: resolved.cwd,
      ...(main === undefined ? {} : { main }),
      ...(engine === undefined ? {} : { engine }),
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function cleanMain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `main` 是否真的落在 `dir` 内。三道闸：
 *   1. 绝对路径拒绝；
 *   2. Windows **盘符相对**路径（`D:x.tex`）拒绝——它不是 isAbsolute，但
 *      `resolve(dir, "D:x.tex")` 会落到**进程 cwd**（评审 A2）；
 *   3. resolve 后判 `relative(dir, …)` 不以 `..` 开头；文件存在时再过一遍 realpath，
 *      防 dir 内的符号链接 / junction 指到外面。
 *
 * 文件不存在时第 3 步的 realpath 会抛：这里不拦，交给 resolve.ts 报「主文件不存在」
 * ——两处对同一个输入给不同结论，模型只会更困惑。
 */
export function mainInsideDir(dir: string, main: string): boolean {
  if (isAbsolute(main)) return false;
  if (/^[A-Za-z]:/.test(main)) return false;
  const resolved = resolve(dir, main);
  if (!within(dir, resolved)) return false;
  try {
    return within(realpathSync(dir), realpathSync(resolved));
  } catch {
    return true;
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
