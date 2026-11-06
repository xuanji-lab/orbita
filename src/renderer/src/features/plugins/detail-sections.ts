/**
 * 详情长页的「节」：哪些节有内容、一节的内容签名、数据变了哪几节、有几处等你。
 * 「正在做」（草稿）就是同一张长页：没写的节画虚线框「还没聊到」，刚变化的节外圈高亮 2 秒——
 * 这两件事都靠这里的判定。纯函数，单独成文件只为可测。
 */
import type { PluginView, PluginWorkflowStep } from "../../../../shared/plugin.ts";

/** 长页的节（顺序无关，布局由 CSS 排）。 */
export const DETAIL_SECTIONS = ["abilities", "io", "workflow", "board", "config", "scope", "source"] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/** 刚变化的节高亮多久（毫秒）。 */
export const FRESH_HIGHLIGHT_MS = 2000;

/** 这一节写了没有（草稿里没写的画「还没聊到」）。「装在哪」「来源与版本」草稿恒为没有——装上时才定。 */
export function sectionFilled(view: PluginView, section: DetailSection): boolean {
  const abilities = view.skills.length + view.mcp.length + view.unsupported.length + view.external.length > 0 || view.contents.scripts;
  switch (section) {
    case "abilities":
      return abilities;
    case "io":
      return view.io.reads.length + view.io.writes.length > 0;
    case "workflow":
      return view.workflow.length > 0;
    case "board":
      return view.board !== null;
    case "config":
      // 「要你填的」没有也是常态：聊到技能那一步之后就算聊过了，不再画虚线
      return view.config.length > 0 || abilities;
    case "scope":
    case "source":
      return false;
  }
}

/** 一节内容的签名：变了就说明智能体刚改了它（高亮用）。 */
export function sectionSignature(view: PluginView, section: DetailSection): string {
  switch (section) {
    case "abilities":
      return JSON.stringify([view.skills, view.mcp, view.unsupported, view.external, view.contents.scripts]);
    case "io":
      return JSON.stringify(view.io);
    case "workflow":
      return JSON.stringify(view.workflow);
    case "board":
      return JSON.stringify(view.board);
    case "config":
      return JSON.stringify(view.config.map((state) => state.field));
    case "scope":
    case "source":
      return "";
  }
}

export type SectionSignatures = Readonly<Record<DetailSection, string>>;

export function sectionSignatures(view: PluginView): SectionSignatures {
  return Object.fromEntries(DETAIL_SECTIONS.map((section) => [section, sectionSignature(view, section)])) as Record<DetailSection, string>;
}

/**
 * 相对上一次，哪几节变了。上一次没有（第一次读到）= 没有变化：刚打开时整页不该全亮。
 * 一节从「没写」变成「写了」、或写了又改了，都算变。
 */
export function changedSections(previous: SectionSignatures | null, next: SectionSignatures): DetailSection[] {
  if (previous === null) return [];
  return DETAIL_SECTIONS.filter((section) => previous[section] !== next[section]);
}

/** 工作流里有几处等用户（标题行写「N 处等你」）。 */
export function waitCount(steps: readonly PluginWorkflowStep[]): number {
  return steps.filter((step) => step.wait !== null).length;
}

/**
 * 详情页按种类决定画哪几块（面板叫「能力」，列表里有三种东西，详情各画各的）：
 * - 真插件：能做什么 / 输入输出 / 工作流 / 看板 / 要你填的 / 装在哪（三选一）/ 来源与版本；插件带的技能只读、
 *   带的 MCP 只显示状态与工具、不单独启停（跟着插件走）；
 * - 你的技能：内容三格（可编辑）+ 在哪儿可用；断链的只有清理入口；
 * - 你的 MCP：状态（含启用开关）/ 工具 / 命令 + 在哪儿可用。
 * 单独成函数只为可测：`node --test` 只加载 .ts，这些判定写在 .tsx 里没法直接跑。
 */
export interface DetailParts {
  /** 内容三格：名称、什么时候用、说明（SKILL.md 正文），失焦即存。只有你自己的、真身还在的技能；插件里的技能永远没有 */
  skillContent: boolean;
  /** 断链提示 + 「清理断链引用」 */
  skillMissing: boolean;
  /** 「状态」一节：连接状态 + 错误全文 + 重试 */
  mcpStatus: boolean;
  /** 状态一节里的启用开关（= setDisabled）。插件带的 MCP 没有，启停跟着插件 */
  mcpSwitch: boolean;
  /** 「工具 N」「命令」两节 */
  mcpTools: boolean;
  mcpCommand: boolean;
  /** 「在哪儿可用」小标（全局 / 各工作区）；真插件用「装在哪」三选一 */
  availability: boolean;
  /** 真插件才有的几块 */
  pluginScope: boolean;
  abilities: boolean;
  source: boolean;
  /** 标题下那段（可展开的）描述：技能的描述在内容里编辑、MCP 的描述就是命令，都不重复 */
  lead: boolean;
}

export function detailParts(view: Pick<PluginView, "origin" | "problems">): DetailParts {
  const skill = view.origin === "user-skill";
  const mcp = view.origin === "user-mcp";
  const missing = skill && view.problems.some((problem) => problem.kind === "skill-folder-missing");
  return {
    skillContent: skill && !missing,
    skillMissing: missing,
    mcpStatus: mcp,
    mcpSwitch: mcp,
    mcpTools: mcp,
    mcpCommand: mcp,
    availability: (skill && !missing) || mcp,
    pluginScope: view.origin === "plugin",
    abilities: view.origin === "plugin",
    source: view.origin === "plugin",
    lead: view.origin === "plugin",
  };
}
