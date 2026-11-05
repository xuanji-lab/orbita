/**
 * 把契约里的数据（冲突、问题、预览错误、MCP 起不来的原因）说成句子。
 * 主进程只给带 kind 的数据，句子由这里按当前语言出——文案表在 messages-*.ts。
 * 纯函数、表由调用方传入：可直接被 `node --test` 加载。
 */
import type {
  PluginConflict,
  PluginMcpProblem,
  PluginPreviewError,
  PluginProblem,
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
