/**
 * 开轮命令里的能力集（shared/capabilities.ts）：从子会话 meta 取，把 `plugin:<名>` 展开成它带的技能与 MCP 服务。
 * 展开放主进程：插件装配（哪个插件带哪些技能、它的 MCP 叫什么名字）只有主进程知道，agent 进程只收
 * `skill:` / `mcp:` 两种（与 skillsDirs / mcpServers 同一条纪律：路径与名字策略在主进程）。
 *
 * 纯模块：不 import electron，node --test 直接测。
 */
import { isCapabilityModule, namedInstalled, type CapabilityModule } from "../../shared/capabilities.ts";
import { PLUGIN_SERVER_PREFIX } from "../../shared/mcp.ts";
import type { PluginAssembly } from "../plugin/store.ts";
import { nameSegment } from "../plugin/names.ts";

/**
 * 缺席（全带）原样缺席——普通会话与没定能力集的活，命令里不出现这个键。
 * 展开后的 `skill:` / `mcp:` 去重、排序：同一能力集的两件活，命令里是同一串。
 */
/**
 * 内置插件里讲怎么用某个模块的技能（browser 插件的 browser 技能、reading 插件的 reading 技能……）跟着模块走：
 * 带了浏览器就带上「怎么用浏览器」那份说明，不必主智能体再点名。键是模块，值是内置插件名（resources/builtin-plugins/<名>）。
 * 实例实测（2026-11-17）：不跟着走时，只带浏览器的活的系统提示里一份技能都没有，浏览器的用法说明也丢了。
 */
const MODULE_COMPANION_PLUGINS: Readonly<Partial<Record<CapabilityModule, string>>> = {
  browser: "browser",
  "pdf-docx": "reading",
  "docs-slides": "docs-slides",
  terminal: "terminal",
  store: "skill-kit",
};

export function turnCapabilities(
  capabilities: readonly string[] | undefined,
  assembly: Pick<PluginAssembly, "skills" | "mcpServers">,
): { capabilities?: string[] } {
  if (capabilities === undefined) return {};
  const companions = capabilities.flatMap((entry) => {
    const plugin = isCapabilityModule(entry) ? MODULE_COMPANION_PLUGINS[entry] : undefined;
    return plugin === undefined ? [] : assembly.skills.filter((skill) => skill.plugin === plugin).map((skill) => `skill:${skill.slug}`);
  });
  const plugins = namedInstalled(capabilities, "plugin:");
  if (plugins.length === 0 && companions.length === 0) return { capabilities: [...capabilities] };
  const kept = capabilities.filter((entry) => !entry.startsWith("plugin:"));
  const extra: string[] = [];
  for (const plugin of plugins) {
    for (const skill of assembly.skills) if (skill.plugin === plugin) extra.push(`skill:${skill.slug}`);
    const prefix = `${PLUGIN_SERVER_PREFIX}${nameSegment(plugin)}_`;
    for (const server of Object.keys(assembly.mcpServers)) if (server.startsWith(prefix)) extra.push(`mcp:${server}`);
  }
  const modules = kept.filter((entry) => !entry.includes(":"));
  const installed = [...new Set([...kept.filter((entry) => entry.includes(":")), ...extra, ...companions])].sort();
  return { capabilities: [...modules, ...installed] };
}
