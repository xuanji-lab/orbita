/**
 * 插件 MCP 服务的命名：模型看到的服务名统一 `plugin_<插件名>_<服务名>`，工具叫
 * `mcp__plugin_<插件名>_<服务名>__<工具>`。
 *
 * 为什么要规整：服务名要满足 `isMcpServerName`（`^[a-zA-Z0-9_-]{1,64}$`，OpenAI 的工具名字符集），
 * 而插件名允许 `.`、服务名更是什么都可能有（`image_search`、`my.server`）。两件事要顾：
 * - 非法字符一律换成 `_`，连续的 `_` 收成一个——`__` 是工具名里服务与工具的分隔符
 *   （`parseQualifiedToolName`），名字里留着它会把分隔拆错；
 * - 超过 64 位时截短两段并附一段哈希，**稳定且不撞**：同一对（插件, 服务）永远得到同一个名字，
 *   不同的对哪怕被截成同一个前缀，哈希也区分它们。
 * 规整可能让两个不同的原名落到同一个结果（`a.b` 与 `a_b`），所以安装时要查重（见 store 的冲突检测）。
 */
import { createHash } from "node:crypto";
import { PLUGIN_SERVER_PREFIX } from "../../shared/mcp.ts";

const MAX_NAME = 64;
/** 截短时每段保留的字符数：7（plugin_）+ 22 + 1 + 22 + 1 + 6（哈希）= 59 ≤ 64 */
const SEGMENT_KEEP = 22;
const HASH_LENGTH = 6;

/**
 * 把任意字符串规整成能安全拼进服务名的一段。**段首段尾的下划线也剥掉**：段与段之间本来就隔着
 * 一个 `_`，段尾再带一个就拼出 `__`（`plugin_p__x`）——正是要避开的分隔符。剥光了给 `x`。
 */
export function nameSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "x" : cleaned;
}

export function qualifiedPluginServerName(plugin: string, server: string): string {
  const p = nameSegment(plugin);
  const s = nameSegment(server);
  const full = `${PLUGIN_SERVER_PREFIX}${p}_${s}`;
  if (full.length <= MAX_NAME) return full;
  const hash = createHash("sha1").update(`${plugin}\0${server}`).digest("hex").slice(0, HASH_LENGTH);
  return `${PLUGIN_SERVER_PREFIX}${p.slice(0, SEGMENT_KEEP)}_${s.slice(0, SEGMENT_KEEP)}_${hash}`;
}
