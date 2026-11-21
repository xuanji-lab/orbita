/**
 * 能力目录：系统提示里的一小段，告诉模型「这一轮 Orbita 自己给了我哪几组工具、各自什么时候用」。
 *
 * 来源只有一个：turn-tools.ts 的 selectTurnTools 在按能力集挑工具时，顺手收下的「非空且被选中」的分组
 * （id、何时用、可选 skill、组内工具名）。这里不写任何工具名清单——新工具进了某组，组内计数与入口自然跟着变；
 * 新加一组，类型要求它带 id 与 when，目录里就会多一行。能力集收掉的组、没注册的组（子会话的插件 / 记忆 / 自动化）、
 * 纯聊天，都不会出现在这里，因为它们根本不在传进来的分组里。
 *
 * 每组至多一行；skill 只在这一轮技能索引里真有它时才指过去（能力集没带、用户停用、被设为只能点名的都不指）。
 * MCP 不逐个列工具，按服务名归纳成一行。纯函数：同样的输入出同样的字（提示缓存对前缀逐字节敏感）。
 */
import { parseQualifiedToolName } from "../shared/mcp.ts";

/** 一组被选中的工具（turn-tools.ts 的 selectTurnTools 产出） */
export interface CatalogGroup {
  /** 稳定的组 id：模块 id（browser、docs-slides…）或 base 里细分出的 plan / plugins / channel / memory / automation，以及 mcp */
  id: string;
  /** 给模型看的「何时用」一行（不含工具名清单） */
  when: string;
  /** 这一组有完整用法的 skill 名（技能索引里的名字）；不一定这一轮都在，格式化时按实际索引过滤 */
  skills?: readonly string[];
  /** 这一轮这一组里实际被选中的工具名，按发给模型的顺序；调用方保证非空 */
  tools: readonly string[];
}

/** 目录全文（含标签）的字符预算：最坏情形（每组都在、技能都在、MCP 服务很多）也不超 */
export const CATALOG_BUDGET = 1500;

/** MCP 一行里服务名清单的字符上限：超出的归成「+N more」 */
const MCP_SERVERS_BUDGET = 60;

const HEADER = "Tool groups this turn besides read, write, edit, bash: group (first tool, +n more): when to use.";

/** 只有至少一行指向了 skill 才讲这一句（没有 skill 可指时不占字） */
const SKILL_HINT = "A named skill has the full how-to; read it before first use.";

/** MCP 工具按服务名归纳（去重、按字典序，同一批工具永远出同一行） */
function mcpLine(group: CatalogGroup): string {
  const servers = [...new Set(group.tools.flatMap((name) => parseQualifiedToolName(name)?.server ?? []))].sort();
  const shown: string[] = [];
  let used = 0;
  for (const server of servers) {
    const next = used + server.length + 2;
    if (shown.length > 0 && next > MCP_SERVERS_BUDGET) break;
    shown.push(server);
    used = next;
  }
  const more = servers.length - shown.length;
  const names = shown.length === 0 ? "none" : `${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
  return `- ${group.id} (servers: ${names}): ${group.when}`;
}

/** 这一组能指向的 skill：只留这一轮技能索引里真有的 */
function skillsOf(group: CatalogGroup, skillNames: ReadonlySet<string>): string[] {
  return group.id === "mcp" ? [] : (group.skills ?? []).filter((name) => skillNames.has(name));
}

function groupLine(group: CatalogGroup, skills: readonly string[]): string {
  if (group.id === "mcp") return mcpLine(group);
  const first = group.tools[0] ?? group.id;
  const rest = group.tools.length - 1;
  const skill = skills.length === 0 ? "" : ` (${skills.length === 1 ? "skill" : "skills"}: ${skills.join(", ")})`;
  return `- ${group.id} (${first}${rest > 0 ? ` +${rest}` : ""}): ${group.when}${skill}`;
}

/**
 * 拼目录段正文。没有任何分组 = 空串（段随之不出现）。
 * `skillNames`：这一轮技能索引里真有的技能名（frontmatter 的 name），决定哪些组能指向 skill。
 */
export function formatCapabilityCatalog(groups: readonly CatalogGroup[], skillNames: readonly string[]): string {
  const live = groups.filter((group) => group.tools.length > 0);
  if (live.length === 0) return "";
  const available = new Set(skillNames);
  const pointers = live.map((group) => skillsOf(group, available));
  const lines = live.map((group, index) => groupLine(group, pointers[index] ?? []));
  const hint = pointers.some((skills) => skills.length > 0) ? [SKILL_HINT] : [];
  return ["<capability-catalog>", HEADER, ...hint, ...lines, "</capability-catalog>"].join("\n");
}
