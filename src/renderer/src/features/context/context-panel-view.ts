/**
 * 上下文面板的显示口径 —— ContextInventory（数据推导）→ 面板要画的东西。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 * 拆出来是因为「哪些算进用量条、剩下的叫什么、组里数几行」都是会被争论的口径，
 * 争论的东西必须能单测。
 *
 * **用量条的口径**：条画的是「装的东西由什么构成」，整条 = 当前已用总量，不是窗口。
 *   「装满了多少」由输入框旁的用量环与面板顶部那行数字回答；按窗口画的话，1M 窗口下
 *   每类来源都不到 1%，条上什么也看不见（2026-10-29 实机）。
 * - 总量与窗口取 pi 报的真实值（stats.contextUsage），各来源是估算（±30%）；
 * - 已压缩出上下文的行（gone）不算进条——它们不在上下文里了，只在列表里灰显；
 * - 「其余」= 真实总量 − 各来源估算之和：整个任务视野下是对话正文（用户消息与
 *   agent 回答）加工具的 JSON 定义（随请求发、不在系统提示里，哪组都不算它）；
 *   本轮视野下还含此前各轮带进来的东西；
 * - 估算之和超过真实总量（估算偏高、或压缩刚做完）时按比例压到真实总量，
 *   「其余」记 0——条不能比真实用量长。
 */
import type { ContextInventory, ContextRulesGroup } from "../../../../shared/context-inventory.ts";

/**
 * 工作目录之外的目录小标：只留最后两级（「…/apps/electron」）。整条绝对路径在 320px
 * 的栏里从尾部被截，截掉的恰是有用的那段（2026-10-29 实机：一排
 * 「/Users/…/agent-workspaces/workspace-17734712410…」分不出谁是谁）；完整路径放悬停。
 */
export function shortOutsideDir(dir: string): string {
  const parts = dir.split("/").filter((part) => part !== "");
  if (parts.length <= 2) return dir;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 面板的分组，顺序即显示顺序（规则在最前：它每轮都在、永不被压缩） */
export const CONTEXT_GROUPS = ["rules", "attach", "files", "web", "tasks", "mcp", "skills"] as const;
export type ContextGroupKey = (typeof CONTEXT_GROUPS)[number];

export interface ContextGroupSummary {
  key: ContextGroupKey;
  /** 组里的行数（文件组 = 文件行 + 搜索小计行） */
  count: number;
  /** 仍在上下文里的估算 token（gone 行不计） */
  liveTokens: number;
  /** 组里每一行都已被压缩出上下文 */
  allGone: boolean;
}

/**
 * 「规则与说明」组的拆解：规则文件各一行、技能索引一行、其余（内核说明 + 工具
 * 清单 + Orbita 逐轮追加的说明段）合成一行——逐段列给用户太细，它关心的是
 * 「我写的规则占了多少、技能索引占了多少」。
 *
 * baseTokens 已含规则文件与技能索引（契约写明），内置那一行 = base − 两者 + 追加段。
 * 估算误差可能让差值为负，钉到 0。
 */
export function rulesBreakdown(rules: ContextRulesGroup): {
  files: ContextRulesGroup["files"];
  skillsIndex: ContextRulesGroup["skillsIndex"] | null;
  builtinTokens: number;
} {
  const filesTokens = rules.files.reduce((sum, file) => sum + file.tokens, 0);
  const segmentsTokens = rules.segments.reduce((sum, segment) => sum + segment.tokens, 0);
  return {
    files: rules.files,
    skillsIndex: rules.skillsIndex.names.length > 0 ? rules.skillsIndex : null,
    builtinTokens: Math.max(0, rules.baseTokens - filesTokens - rules.skillsIndex.tokens) + segmentsTokens,
  };
}

interface RowLike {
  gone: boolean;
  tokens: number;
}

function summarize(key: ContextGroupKey, rows: readonly RowLike[]): ContextGroupSummary | null {
  if (rows.length === 0) return null;
  return {
    key,
    count: rows.length,
    liveTokens: rows.reduce((sum, row) => sum + (row.gone ? 0 : row.tokens), 0),
    allGone: rows.every((row) => row.gone),
  };
}

/**
 * 各组的汇总，只含非空组（空组整组不出现——面板只说装了什么）。
 * 规则组在清单未知（这条会话还没开过轮）时不在这里，面板另起一行说明。
 */
export function groupSummaries(inventory: ContextInventory): ContextGroupSummary[] {
  const out: ContextGroupSummary[] = [];
  if (inventory.rules !== null) {
    const breakdown = rulesBreakdown(inventory.rules);
    out.push({
      key: "rules",
      count: breakdown.files.length + (breakdown.skillsIndex === null ? 0 : 1) + 1,
      liveTokens: inventory.rules.tokens,
      allGone: false,
    });
  }
  const groups: [ContextGroupKey, readonly RowLike[]][] = [
    ["attach", inventory.attach.rows],
    ["files", [...inventory.files.dirs.flatMap((dir) => dir.rows), ...inventory.files.searches]],
    ["web", inventory.web.rows],
    ["tasks", inventory.tasks.rows],
    ["mcp", inventory.mcp.rows],
    ["skills", inventory.skills.rows],
  ];
  for (const [key, rows] of groups) {
    const summary = summarize(key, rows);
    if (summary !== null) out.push(summary);
  }
  return out;
}

/**
 * 条上画一段的最小占比：整条的 0.5%（480px 宽的条约 2px）。更小的来源画出来只是
 * 一根细竖线，几个挨着就成了一排刻度——不画，列表里照常列出量。「其余」不受此限。
 */
export const MIN_SEGMENT_RATIO = 0.005;

export interface ContextBarSegment {
  key: ContextGroupKey | "rest";
  /** 占整条（当前已用总量）的比例（0–1），条按它画宽 */
  ratio: number;
  tokens: number;
}

export interface ContextBar {
  /** 真实总量；null = 未知（压缩刚做完、下一次模型响应前） */
  used: number | null;
  window: number;
  percent: number | null;
  /** 真实总量 − 各来源估算之和（≥ 0）；总量未知时为 null */
  rest: number | null;
  segments: ContextBarSegment[];
}

/**
 * 用量条。usage 缺席（pi 连窗口都不知道）= null，面板不画条。
 * 总量未知（压缩刚做完）：整条按各来源估算之和画，不画「其余」——答不上来时不编一个数。
 */
export function contextBar(
  groups: readonly ContextGroupSummary[],
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | null,
): ContextBar | null {
  if (usage === null || usage.contextWindow <= 0) return null;
  const window = usage.contextWindow;
  const sources = groups.filter((group) => group.liveTokens > 0);
  const sourceSum = sources.reduce((sum, group) => sum + group.liveTokens, 0);
  const used = usage.tokens;
  // 整条 = 真实总量；估算之和超过它（估算偏高）时以估算之和为整条，「其余」记 0
  const whole = Math.max(used ?? 0, sourceSum);
  const rest = used === null ? null : Math.max(0, used - sourceSum);
  const segments: ContextBarSegment[] =
    whole <= 0
      ? []
      : sources
          .map((group) => ({ key: group.key, tokens: group.liveTokens, ratio: group.liveTokens / whole }))
          .filter((segment) => segment.ratio >= MIN_SEGMENT_RATIO);
  if (rest !== null && rest > 0 && whole > 0) segments.push({ key: "rest", tokens: rest, ratio: rest / whole });
  const percent =
    used === null ? null : (usage.percent ?? Math.round(Math.min(1, Math.max(0, used / window)) * 100));
  return { used, window, percent, rest, segments };
}
