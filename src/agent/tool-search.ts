/**
 * tool_search：模型加载「先不发给它」的工具（turn-tools.ts 里 deferred 的那几组）。
 *
 * 搜索与加载就是 durable 自带的 createToolSearchTool（BM25 排序，结果经 control.addTools 写进会话的 modelTools，
 * 下一次请求起发给模型；加载状态落在会话文档里，跨轮、压缩、重开库都在）。这里只做两处 Orbita 的贴合：
 * - 说明换成固定的一段，只讲「搜目录里标了还没加载的那些组」：durable 的原说明提到 MCP，而能力集可能把 MCP 收掉了，
 *   不该承诺搜得到没有的东西；这段字固定不随工具集变，不打断提示缓存；
 * - 加载结果后面附上被加载工具的 promptGuidelines（例如终端的复用纪律）：这些规矩平时写在系统提示的 Guidelines 里，
 *   延迟的工具不进那份提示（提示不随加载变，缓存稳），规矩改在加载这一刻交给模型，随结果留在转录里。
 *
 * 重放：保持 durable 原样的 `replay: "safe"`（只改「发给模型什么」，不碰外界）；不把别的工具标 safe。
 */
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";

export { TOOL_SEARCH_TOOL_NAME };

/**
 * 给模型的说明（固定文本）。只说「目录里标了 Not loaded yet 的组」——能力集收掉的组不在目录里，这里也就没有承诺。
 */
export const TOOL_SEARCH_DESCRIPTION =
  "Loads tools that are not offered yet. It searches only the tool groups that the capability catalog lists as not loaded " +
  "(ranked by name, description and parameters); matching tools are available from your next call, and you keep them for the rest of the conversation. " +
  "Call it before using a tool from such a group, with a short description of the task or a tool name. Tools of groups the catalog does not list cannot be found.";

/** 被加载工具的规矩接在结果后面：同一条规矩只写一次 */
function rulesText(rules: ReadonlyMap<string, readonly string[]>, loaded: readonly string[]): string {
  const lines = [...new Set(loaded.flatMap((name) => rules.get(name) ?? []))];
  return lines.length === 0 ? "" : `\n\nRules for the tools just loaded:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/** 从 durable 的结果里取出这次加载了哪些工具（details.loaded）；形状不对当没有 */
function loadedNames(result: ToolExecutionResult): string[] {
  const details = result.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const loaded = (details as Record<string, unknown>)["loaded"];
  return Array.isArray(loaded) ? loaded.filter((name): name is string => typeof name === "string") : [];
}

/**
 * Orbita 的 tool_search 注册项。`rules`：延迟工具名 → 它的 promptGuidelines（没有规矩的工具不用放）。
 */
export function createOrbitaToolSearch(rules: ReadonlyMap<string, readonly string[]>): ToolRegistration {
  const base = createToolSearchTool() as unknown as ToolRegistration;
  return {
    ...base,
    description: TOOL_SEARCH_DESCRIPTION,
    async execute(args, api, context) {
      const result = await base.execute(args, api, context);
      const extra = rulesText(rules, loadedNames(result));
      if (extra === "" || result.output === undefined) return result;
      return { ...result, output: [...result.output, { type: "text", text: extra }] };
    },
  };
}

/**
 * 模型调了一个这一轮注册着、却还没加载的延迟工具（没先 tool_search，或与 tool_search 在同一批里调）：
 * 结果说清它在、怎么加载，而不是 durable 的「not available」被折成「not found」。
 */
export function notLoadedReceipt(name: string): string {
  return `Tool ${name} is not loaded yet. Call ${TOOL_SEARCH_TOOL_NAME} with a short description of what you need (for example "${name}"); it is available from your next call, then call ${name} again.`;
}
