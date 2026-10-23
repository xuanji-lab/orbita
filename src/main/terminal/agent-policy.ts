/**
 * agent 终端的策略 —— cwd 授权与所有权校验。**纯模块**（不 import electron、不 import
 * node:fs 的默认导出），可被 `node --test` 直接测；真的 PTY 在 service.ts，那边
 * import electron。
 *
 * 两条硬边界，与 Proma 的 terminal-agent-policy.ts / terminal-service.ts 同构：
 *
 * 1. **所有权**：agent 只能驱动自己会话开的终端。用户在同一面板里手动关掉一个 tab，
 *    agent 下一次写它就必然失败——这不是竞态，是「人随时能接管」的另一面。
 * 2. **cwd 授权**：agent 开的终端必须落在会话授权目录内（工作区根 + 附加目录），
 *    解析时过一遍 realpath，防止用符号链接把终端开到授权目录外。
 *
 * ⚠ 这不是 OS sandbox——注释写在这是给读代码的人看的。拿到交互 shell 的 agent 仍然拥有
 * 本机 shell 本身的文件访问能力，授权目录限制的只是「终端开在哪、从哪起步」。
 */
import { posix, win32 } from "node:path";
import type { TerminalInfo } from "../../shared/terminal.ts";

/** 用到的几个路径算法。默认随平台（node:path），测试注入 posix 保持可移植 */
export interface PathApi {
  isAbsolute: (value: string) => boolean;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
}

/** 授权目录解析与存在性检查的注入点（测试用假实现；生产走 node:fs + node:path） */
export interface AgentCwdDeps {
  /** realpath（跟随符号链接）。不存在的路径要抛——调用方据此报「不存在」 */
  realpath: (path: string) => string;
  isDirectory: (path: string) => boolean;
  path?: PathApi;
  /** 大小写折叠口径（Windows 文件系统大小写不敏感）。默认随平台 */
  platform?: NodeJS.Platform;
}

export interface AgentCwdContext {
  /** 会话授权目录（工作区根 + 附加目录），绝对路径 */
  roots: readonly string[];
  /** 会话 cwd：相对 cwd 的解析基准，也是 cwd 缺席时的落点 */
  defaultCwd: string;
}

export type AgentCwdResult = { ok: true; cwd: string } | { ok: false; error: string };

/**
 * 授权失败文案的主语与提示。终端用自己的那份（默认值，文案一字不变）；
 * LaTeX 编译用「LaTeX build」——两处共用同一套 realpath / 越界判定，只换说法。
 */
export interface AgentCwdPolicy {
  /** 文案里的名词短语（单数形）：`no <subject> can be opened there` */
  subject: string;
  /** 越界文案的尾句 */
  hint: string;
}

const TERMINAL_CWD_POLICY: AgentCwdPolicy = {
  subject: "terminal",
  hint: " — pass no cwd to use the session's working directory.",
};

/**
 * 把 agent 给的 cwd 解析成一个**授权目录内的真实路径**。
 *
 * 缺席 / 空串 = 会话 cwd（它本身就是授权目录之一，不必再查）。相对路径按会话 cwd
 * 解析（Proma 同款：模型经常给 "apps/electron" 这种）。解析完必须过三道关：
 * 存在（realpath 不抛）、在授权目录内（**realpath 之后**判，否则 symlink 一指就逃）、
 * 是目录。任何一道不过都是明确报错——agent 终端不像人工终端那样回退 homedir：
 * 悄悄开到别处比开不出来危险得多。
 */
export function resolveAgentTerminalCwd(
  input: string | undefined,
  context: AgentCwdContext,
  deps: AgentCwdDeps,
): AgentCwdResult {
  return resolveAgentCwd(input, context, deps, TERMINAL_CWD_POLICY);
}

/**
 * resolveAgentTerminalCwd 的通用形：同一条 realpath / 越界判定，失败文案按
 * `policy` 换主语。LaTeX 编译（main/latex/ipc.ts）用的是这一条——两份授权实现
 * 迟早会漂，而「能不能在这个目录里干活」只能有一套真相。
 */
export function resolveAgentCwd(
  input: string | undefined,
  context: AgentCwdContext,
  deps: AgentCwdDeps,
  policy: AgentCwdPolicy,
): AgentCwdResult {
  const path = deps.path ?? defaultPathApi();
  const roots = realAuthorizedRoots(context.roots, deps);
  if (roots.length === 0) {
    return { ok: false, error: `This session has no authorized directory to open a ${policy.subject} in.` };
  }
  const wanted = input === undefined || input.trim() === "" ? context.defaultCwd : input.trim();
  if (wanted === "") {
    return { ok: false, error: `This session has no working directory to open a ${policy.subject} in.` };
  }
  const resolved = path.isAbsolute(wanted) ? wanted : path.resolve(context.defaultCwd, wanted);
  let real: string;
  try {
    real = deps.realpath(resolved);
  } catch {
    return { ok: false, error: `"${resolved}" does not exist, so no ${policy.subject} can be opened there.` };
  }
  if (!roots.some((root) => pathWithinRoot(root, real, path, deps.platform ?? process.platform))) {
    return {
      ok: false,
      error:
        `"${resolved}" is outside this session's authorized directories (${context.roots.join(", ")}). ` +
        `Agent ${policy.subject}s may only be opened there${policy.hint}`,
    };
  }
  if (!deps.isDirectory(real)) {
    return { ok: false, error: `"${real}" is not a directory.` };
  }
  return { ok: true, cwd: real };
}

/**
 * 授权目录各自过一遍 realpath：失效的（被挪走 / 删掉）直接从名单里去掉。
 * 导出给 latex/new-paper.ts 用——它要判一个**还不存在**的目标目录，走不了
 * resolveAgentCwd（那条路要求目录已存在），但必须认同一份根名单与同一套
 * realpath / 大小写口径，否则「能不能写进这个工作区」会有两个答案。
 */
export function realAuthorizedRoots(roots: readonly string[], deps: AgentCwdDeps): string[] {
  const real: string[] = [];
  for (const root of roots) {
    try {
      const resolved = deps.realpath(root);
      if (!real.includes(resolved)) real.push(resolved);
    } catch {
      // 目录不在了：不是授权目录
    }
  }
  return real;
}

/**
 * 目录包含判定。Windows 文件系统大小写不敏感，比较前折叠（同 agent/permission.ts
 * 的 foldPath 口径）；posix 大小写敏感，原样比。
 * 导出：new-paper 判「这个还不存在的目录将来会不会落在授权目录外」。
 */
export function pathWithinRoot(
  root: string,
  candidate: string,
  path: PathApi = defaultPathApi(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rel = path.relative(fold(root, platform), fold(candidate, platform));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function fold(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase() : value;
}

/** 平台默认路径算法。测试注入别的保持可移植，生产默认随 process.platform */
export function defaultPathApi(platform: NodeJS.Platform = process.platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

/**
 * 找「本会话拥有且能写」的那个终端。
 *
 * `requireRunning`（execute / interrupt 传 true）：shell 已经退出的终端没有可写的
 * 对象，写进去只会失踪。**read 传 false**——进程退出后的尾巴往往正是要读的东西
 * （dev server 崩前的最后几行），只要 tab 没被关（关了就出不了这张表）就能读。
 */
export function ownedTerminal(
  terminals: readonly TerminalInfo[],
  sessionId: string,
  terminalId: string,
  options: { requireRunning: boolean },
): { ok: true; terminal: TerminalInfo } | { ok: false; error: string } {
  const terminal = terminals.find((item) => item.terminalId === terminalId);
  if (terminal === undefined) {
    return {
      ok: false,
      error:
        `No open terminal has the id "${terminalId}" — it was closed, by you or by the user. ` +
        "Call terminal_list to see the terminals this session still owns.",
    };
  }
  if (terminal.owner.kind !== "agent" || terminal.owner.sessionId !== sessionId) {
    return {
      ok: false,
      error:
        `Terminal "${terminalId}" is not owned by this session (it belongs to ` +
        `${terminal.owner.kind === "agent" ? `session ${terminal.owner.sessionId}` : "the user"}). ` +
        "Only terminals this session opened can be driven from here; every terminal is visible to the user in the terminal panel.",
    };
  }
  if (options.requireRunning && terminal.exited !== null) {
    return {
      ok: false,
      error:
        `Terminal "${terminalId}" has already exited (exit code ${terminal.exited}) — there is no shell left to write to. ` +
        "Read its last output with terminal_read, or open a new terminal with terminal_open.",
    };
  }
  return { ok: true, terminal };
}
