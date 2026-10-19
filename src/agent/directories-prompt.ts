/**
 * 开轮目录清单 —— 讲给模型听的一段说明（拼进 system prompt，同 gitAttributionGuideline
 * 的注入方式）。**纯模块**：不 import electron，可被 `node --test` 直接加载。
 *
 * 讲的是 2026-09-22 裁决的三层地盘：
 *   cwd           工作区文件夹（工具面的家）
 *   attached      工作区挂的附加目录（只告知——工具面仍是 cwd + protectedPaths 黑名单）
 *   workbench     会话私有草稿区（<userData>/workbenches/<sessionId>/）
 *
 * **只告知不硬拦**：pi 的 read/write 只把相对路径 resolve 到 cwd，不做包含性校验；
 * 白名单硬拦是新功能，不是这份 prompt 的事。模型读到绝对路径自然会去用。
 */
import type { TurnDirectories } from "../shared/agent-ipc.ts";

/**
 * directories 缺席 = 空串（调用方按空串跳过这一段，不留空行；旧测试夹具不带这个字段）。
 *
 * attached 为空时省略那一段——留一行 "- (none)" 只会教模型模仿这个格式。
 * workbench 恒出现：哪怕没挂任何附加目录，会话也总有草稿要落。
 * related 为空 / 缺席时省略那一段（同 attached 的纪律）——绝大多数会话没有父子关系。
 */
export function describeDirectories(cwd: string, directories: TurnDirectories | undefined): string {
  if (directories === undefined) return "";
  const lines: string[] = ["<directories>", `Working directory (cwd): ${cwd}`];
  if (directories.attached.length > 0) {
    lines.push(
      "Attached directories (read and write as the user allows; use absolute paths):",
      ...directories.attached.map((dir) => `- ${dir}`),
    );
  }
  lines.push(
    `Session workbench: ${directories.workbench}`,
    "  Private scratch space for this session: plans, handoffs, drafts, research notes. " +
      "It may not exist yet — create it with mkdir -p on first use. " +
      "Do not put user-facing deliverables here unless asked; those belong in the working directory.",
  );
  if (directories.related !== undefined && directories.related.length > 0) {
    lines.push(
      ...directories.related.map((entry) =>
        entry.relation === "parent"
          ? `Parent session "${entry.label}" (id ${entry.sessionId}) workbench: ${entry.path}`
          : entry.status === undefined
            ? `Sub-session "${entry.label}" (id ${entry.sessionId}) workbench: ${entry.path}`
            : `Sub-session "${entry.label}" (id ${entry.sessionId}) — state: ${entry.status} · workbench: ${entry.path}`,
      ),
      "  These are other sessions' private workbenches: read them to hand off material. " +
        "Do not modify files the other session is actively using unless the task calls for it.",
    );
    // 台账路由注只给有子会话的那一侧（root）。子会话的 related 恒为 [parent]：它没有
    // delegate / reply_subsession，给它讲「新产出用 delegate」只会诱导它调不存在的工具
    // （同 describeChannelRole 只给孩子一段的道理，2026-10-19 审查指出）。
    if (directories.related.some((entry) => entry.relation === "child")) {
      lines.push(
        "  Sub-session ids are the recipients of reply_subsession. state: done means it has already " +
          "delivered — start a new sub-session with delegate for a new deliverable; failed can still be " +
          "asked what went wrong; stopped is a channel the user terminated — do not send into it.",
      );
    }
  }
  if (directories.browserDownloads !== undefined) {
    lines.push(
      `Browser downloads: ${directories.browserDownloads}`,
      "  Files the user downloaded in Orbita's built-in browser (papers, exports) land here. " +
        "You may read and organize them when the conversation calls for it; ask before deleting anything. " +
        "Files you download in your own browser tab go to downloads/ in your session workbench instead.",
    );
  }
  lines.push("</directories>");
  return lines.join("\n");
}
