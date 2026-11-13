/**
 * 外部来源（别家 agent 工具留在本机磁盘上的聊天记录）的契约真源。
 *
 * Orbita 只读它们：read_task 按 `ext:<来源>:<id>` 读源头的最新内容，不复制进 Orbita 的
 * 会话库——源头永远是真源（2026-11-13 用户：「能读到聊天记录就行了」）。
 */

/** 能只读的来源。顺序即 read_task 目录与设置页里的列出顺序。 */
export const EXTERNAL_SOURCE_IDS = [
  "claude-code",
  "codex",
  "kimi-code",
  "kimi-work",
  "opencode",
  "reasonix",
  "zcode",
  "proma",
] as const;

export type ExternalSourceId = (typeof EXTERNAL_SOURCE_IDS)[number];

export function isExternalSourceId(value: unknown): value is ExternalSourceId {
  return typeof value === "string" && (EXTERNAL_SOURCE_IDS as readonly string[]).includes(value);
}
