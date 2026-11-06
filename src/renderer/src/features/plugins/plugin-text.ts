/**
 * 把契约里的数据（冲突、问题、预览错误、MCP 起不来的原因）说成句子。
 * 主进程只给带 kind 的数据，句子由这里按当前语言出——文案表在 messages-*.ts。
 * 纯函数、表由调用方传入：可直接被 `node --test` 加载。
 */
import type {
  PluginConflict,
  PluginInstallRow,
  PluginMcpProblem,
  PluginPreviewError,
  PluginProblem,
  PluginRowInstallResult,
} from "@shared/plugin";
import type { Messages } from "../../messages-en.ts";

type T = Messages["plugins"];

export function conflictText(t: T, conflict: PluginConflict): string {
  switch (conflict.kind) {
    case "skill-name":
      return conflict.with.origin === "user-skill"
        ? t.conflict.skillUser(conflict.skill, conflict.with.name)
        : t.conflict.skillPlugin(conflict.skill, conflict.with.name);
    case "skill-duplicate":
      return t.conflict.skillDuplicate(conflict.skill);
    case "plugin-exists":
      return t.conflict.pluginExists(conflict.name);
    case "mcp-name":
      return t.conflict.mcpName(conflict.server, conflict.qualified, conflict.with);
  }
}

export function problemText(t: T, problem: PluginProblem): string {
  return t.problem[problem.kind](problem.detail);
}

export function mcpProblemText(t: T, problem: PluginMcpProblem): string {
  switch (problem.kind) {
    case "unknown-variable":
      return t.mcpProblemUnknownVariable(problem.variable);
    case "config-missing":
      return t.mcpProblemConfigMissing(problem.key);
    case "invalid":
      return t.mcpProblemInvalid;
    case "command-missing":
      return t.mcpProblemCommandMissing(problem.command);
  }
}

export function previewErrorText(t: T, error: PluginPreviewError | { kind: "stale-preview" }): string {
  switch (error.kind) {
    case "not-a-plugin":
      return t.install.error.notAPlugin;
    case "invalid-name":
      return t.install.error.invalidName(error.name);
    case "git-url-rejected":
      return t.install.error.gitUrlRejected;
    case "git-failed":
      // 超时由 stageGit 标成 "timeout"：单独一句比把词原样贴出来强
      return error.message === "timeout" ? t.install.error.gitTimeout : t.install.error.gitFailed(error.message);
    case "too-large":
      return t.install.error.tooLarge;
    case "symlink-escape":
      return t.install.error.symlinkEscape(error.paths.slice(0, 3).join(", "));
    case "read-failed":
      return t.install.error.readFailed(error.message);
    case "stale-preview":
      return t.install.error.stale;
  }
}

// ---------- 对话里「装上插件」那一行（PluginInstallLine） ----------

type RowT = T["row"];

/**
 * 这一行此刻画哪一种：已装列表说了算（`installedNow`：true / false / undefined = 还没读到），
 * 没读到时按它落盘时的样子画（装上的不闪成「没装」，等的不闪成「已装」）。
 * 装上过又卸载了 = uninstalled（可重新安装）。
 */
export function rowMode(row: Pick<PluginInstallRow, "state">, installedNow: boolean | undefined): "installed" | "pending" | "uninstalled" {
  if (installedNow === true) return "installed";
  if (installedNow === undefined) return row.state === "installed" ? "installed" : "pending";
  return row.state === "installed" ? "uninstalled" : "pending";
}

/** 「N 个技能」；没有技能（只带 MCP 或只有面板）为空串。 */
export function rowSkillsText(t: RowT, row: Pick<PluginInstallRow, "skills">): string {
  return row.skills.length === 0 ? "" : t.skillCount(row.skills.length);
}

/** 「只在「X」」 / 「所有工作区」。 */
export function rowScopeText(t: RowT, row: Pick<PluginInstallRow, "scope" | "workspaceName">): string {
  if (row.scope === "global") return t.scopeGlobal;
  return row.workspaceName === null ? "" : t.scopeWorkspace(row.workspaceName);
}

/** 没直接装、等用户点的原因，一句话（已装上的没有）。 */
export function rowReasonText(t: RowT, row: Pick<PluginInstallRow, "reason">): string {
  if (row.reason === "mcp") return t.pendingMcp;
  if (row.reason === "global") return t.pendingGlobal;
  if (row.reason === "manual") return t.pendingManual;
  return "";
}

/** 点「安装」没成的原因（主进程给稳定的代码，句子在这里出）。 */
export function rowFailureText(t: RowT, reason: Extract<PluginRowInstallResult, { ok: false }>["reason"], detail: string): string {
  switch (reason) {
    case "no-session":
      return t.failed.noSession;
    case "not-found":
      return t.failed.notFound;
    case "changed":
      return t.failed.changed;
    case "invalid":
      return t.failed.invalid(detail);
    case "failed":
      return t.failed.failed(detail);
  }
}
