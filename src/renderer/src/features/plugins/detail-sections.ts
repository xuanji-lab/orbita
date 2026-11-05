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
