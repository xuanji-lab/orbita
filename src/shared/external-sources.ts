import type { ImportCustomRoot } from "./import.ts";

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

/**
 * 设置 › 外部来源里的逐个开关（存在 AppSettings.externalSources）。**缺席 = 开**：发现了就读；
 * 关掉写 false，再打开写 true（逐项记账）。关着的来源 read_task 不列，读它的 ref 时说明已关闭。
 */
export type ExternalSourceSwitches = Partial<Record<ExternalSourceId, boolean>>;

/** 只认已知来源与布尔值；一个都不剩返回 undefined（不落键）。 */
export function parseExternalSourceSwitches(raw: unknown): ExternalSourceSwitches | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: ExternalSourceSwitches = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isExternalSourceId(key) && typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function isExternalSourceEnabled(switches: ExternalSourceSwitches | undefined, id: ExternalSourceId): boolean {
  return switches?.[id] !== false;
}

/** 一个来源的一个数据目录。 */
export interface ExternalSourceRoot {
  dir: string;
  /** 用户在设置里手动加的（可移除） */
  custom: boolean;
  /** 会话入口在不在（自定义目录被挪走时为 false） */
  hasData: boolean;
}

/** 设置页的一行（external-sources:list 的一项）。 */
export interface ExternalSourceInfo {
  id: ExternalSourceId;
  /** 发现的数据目录；空 = 本机没发现 */
  roots: ExternalSourceRoot[];
  /** 一个都没发现时，默认会去哪里找 */
  expected: string;
  /** 发现的会话数（只 stat 数出来的；关着的来源照样数） */
  sessions: number;
  enabled: boolean;
  /** 读不全的原因（库打不开、新版格式还不读……），原样给用户看 */
  problems: string[];
}

/** external-sources:list 的返回。 */
export interface ExternalSourcesResult {
  /** 家目录：界面把路径缩写成 ~/… */
  home: string;
  sources: ExternalSourceInfo[];
  /** 用户手动加的数据目录（来源 + 目录），增删走 import:custom-roots:* */
  customRoots: ImportCustomRoot[];
}
