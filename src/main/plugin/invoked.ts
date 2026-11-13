/**
 * `/plugin:<name>` 点名 → 指令块里的一条（shared/invocation.ts 的 InvokedPlugin）。
 * 纯函数：视图与「入口技能文件在哪」由调用方（agent/ipc.ts 的 prependInvocationDirectives）读好传进来，
 * 这里只做判定与取舍，所以可测。
 */
import { entrySkillSlug, type InvokedPlugin } from "../../shared/invocation.ts";
import { parsePluginViewId, scopeApplies, type PluginView } from "../../shared/plugin.ts";

/**
 * - view 为 undefined（没装 / 插件功能关着 / 点的是旧技能、旧 MCP 那种非真插件）→ not-installed；
 * - 装了但对这条会话的工作区没启用 → disabled（不给任何路径，模型不该去读它）；
 * - 启用 → 工作流各步、入口技能与看板。`locateSkill(slug)` 给入口技能 SKILL.md 的绝对路径，
 *   null = 开轮装配里没有它（撞名被丢 / 文件读不出）→ entry 为 null，指令块如实写明。
 */
export function invokedPluginOf(
  target: string,
  view: PluginView | undefined,
  workspaceId: string | null,
  locateSkill: (slug: string) => string | null,
): InvokedPlugin {
  if (view === undefined || view.origin !== "plugin" || parsePluginViewId(view.id)?.key !== target) {
    return { target, state: "not-installed" };
  }
  if (!scopeApplies(view.scope, workspaceId)) return { target, state: "disabled", displayName: view.name };
  const slug = entrySkillSlug(view.workflow, view.skills);
  const location = slug === null ? null : locateSkill(slug);
  return {
    target,
    state: "enabled",
    displayName: view.name,
    workflow: view.workflow.map((step) => ({ title: step.title, skill: step.skill })),
    entry: slug === null || location === null ? null : { skill: slug, location },
    hasBoard: view.board !== null,
  };
}
