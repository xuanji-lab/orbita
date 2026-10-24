/**
 * 让 bash 工具**不去问人**：把非交互环境变量作为 `shellCommandPrefix` 交给 pi。
 *
 * 治的是一种**永远不退出**的命令（实测：最近 60 个会话里 12 次 bash 跑过 30 分钟，
 * 最长 3.7 小时，吃掉全部 bash 墙上时间的 41%）。其中一类根因不是慢，而是在等人：
 * 分页器（`git log` 进 less 等按键）、凭据提示（`git push` 等密码 / 账号）、
 * 交互确认（`gh` / `npm` 的 SSH 口令）。没有 TTY 时它们有的等 stdin、有的重试到超时。
 *
 * 路线是**改环境、不改命令**：五个同类项目（pi / Proma / codex / ZCode / deepseek-harness）
 * 里 codex 与 dsh 都往子进程环境注入非交互变量（`GH_PAGER`、`CODEX_CI` 等），
 * 而没有一家去改写命令本身（插 `timeout` / `</dev/null` / `| cat`）——改命令会
 * 连带改变输出与退出码语义，改环境只是让程序选非交互分支。
 *
 * 为什么是 `export` 前缀而不是 pi 的 env 设置：pi 的 bash 工具没有「注入环境变量」的
 * 设置项，只有 `shellCommandPrefix`（`settings-schema.ts`），由 `agent-session` 传给
 * bash 工具，工具把它当**独立一行**插在命令前（`core/tools/bash.js`）——同一行 shell
 * 里 `export` 后对所有后续行生效，语义正好是「给这条命令一个非交互环境」。
 * 因此不需要 patch pi。
 */

/** 一条命令前拼的独立一行。全部是「别进交互分支」的开关，不改命令本身。 */
export const NON_INTERACTIVE_SHELL_PREFIX =
  "export PAGER=cat GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never";

/** POSIX 系 shell 的 basename（去掉 Windows 的 `.exe` 之后）。 */
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * 该 shell 是不是 POSIX 系，能不能吃 `export ...` 这一行。
 *
 * 判错方向的代价不对称：前缀是 `export`，交给 `cmd.exe` / PowerShell 会把
 * **每一条**命令都变成语法错误（不是少一个功能，是全挂）。所以只认白名单，
 * 其余一律当非 POSIX。
 *
 * `shellPath` 为 `undefined` 时给前缀：pi 自己的兜底是 Git Bash（Windows）/ `sh`
 * （POSIX），两者都吃 `export`。
 */
export function nonInteractivePrefixFor(shellPath: string | undefined): string {
  if (shellPath === undefined) return NON_INTERACTIVE_SHELL_PREFIX;
  const base = shellPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const name = base.toLowerCase().replace(/\.exe$/, "");
  return POSIX_SHELLS.has(name) ? NON_INTERACTIVE_SHELL_PREFIX : "";
}
