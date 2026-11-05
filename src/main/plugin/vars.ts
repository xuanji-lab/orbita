/**
 * 插件 MCP 配置里的变量替换。作用域是 command / args / env / cwd / url / headers 的每个字符串
 * （一个都不漏——漏一个就是「用户以为写对了、实际没生效」，同 `substituteWorkspaceFolder`）。
 *
 * 认的变量：
 * - `${CLAUDE_PLUGIN_ROOT}`：插件根的绝对路径（复制 / git = userData 里的副本，链接 = 源目录）；
 * - `${CLAUDE_PLUGIN_DATA}`：`<userData>/plugin-data/<name>/`，跨更新保留的数据目录；
 * - `${user_config.KEY}`：用户填的配置值（敏感项来自密钥库）；
 * - `${CLAUDE_PROJECT_DIR}`：项目根 = 工作区根，换成已有的 `${workspaceFolder}` 占位，
 *   由开轮装配的 `resolveServersForWorkspace` 统一解析（Home 会话没有工作区根时它会跳过这台 server）。
 * ZCode 官方清单把前缀写成 `ZCODE_`（`ZCODE_PLUGIN_ROOT` / `ZCODE_PLUGIN_DATA` / `ZCODE_PROJECT_DIR`），
 * 第二期市场要装它们，按同义认。
 *
 * **认不得的变量不替换也不猜**：原样留着并记一个 `unknown-variable` 问题——这台 server 不进开轮装配，
 * 界面上说明原因。塞一个猜的值正是 server 静默空转 / 串号的来源（同 aw-mcp 的教训）。
 */
import { isHttpServer, WORKSPACE_FOLDER_VAR, type McpServer } from "../../shared/mcp.ts";
import type { PluginConfigField, PluginConfigValue, PluginMcpProblem } from "../../shared/plugin.ts";

export interface VarContext {
  root: string;
  dataDir: string;
  fields: readonly PluginConfigField[];
  /** 已存的非敏感值 + 敏感值（来自密钥库）。键 = 配置键 */
  values: Readonly<Record<string, PluginConfigValue>>;
  /** 敏感值是否掩码：预览 / 详情展示用 true，真正装配给 agent 进程用 false */
  mask: boolean;
}

/** 敏感值在展示用命令行里的样子。 */
export const MASKED_VALUE = "••••••";

const PATTERN = /\$\{([^}]*)\}/g;

const ROOT_NAMES = new Set(["CLAUDE_PLUGIN_ROOT", "ZCODE_PLUGIN_ROOT"]);
const DATA_NAMES = new Set(["CLAUDE_PLUGIN_DATA", "ZCODE_PLUGIN_DATA"]);
const PROJECT_NAMES = new Set(["CLAUDE_PROJECT_DIR", "ZCODE_PROJECT_DIR"]);

/** 值怎么变成命令行里的一段文字：数组用逗号连，布尔 / 数字照字面。 */
function renderValue(value: PluginConfigValue): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** 替换一个字符串里的全部变量；碰到第一个问题就记下（其余照常替换，方便展示）。 */
export function substituteString(text: string, context: VarContext): { value: string; problem: PluginMcpProblem | null } {
  let problem: PluginMcpProblem | null = null;
  const value = text.replace(PATTERN, (whole, rawName: string) => {
    const name = rawName.trim();
    if (ROOT_NAMES.has(name)) return context.root;
    if (DATA_NAMES.has(name)) return context.dataDir;
    if (PROJECT_NAMES.has(name)) return WORKSPACE_FOLDER_VAR;
    // 已有的工作区变量不归这里管：留给开轮装配
    if (name === "workspaceFolder") return whole;
    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      const field = context.fields.find((each) => each.key === key);
      if (field === undefined) {
        problem ??= { kind: "unknown-variable", variable: name };
        return whole;
      }
      const actual = context.values[key] ?? field.default;
      if (actual === null || actual === undefined || actual === "") {
        // 必填而没填：这台 server 起不来；非必填缺省 = 空串（ZCode 的 sdk_path 就是默认空串）
        if (field.required) {
          problem ??= { kind: "config-missing", key };
          return whole;
        }
        return "";
      }
      return field.sensitive && context.mask ? MASKED_VALUE : renderValue(actual);
    }
    problem ??= { kind: "unknown-variable", variable: name };
    return whole;
  });
  return { value, problem };
}

/** 替换一台 server 的全部字符串字段，返回新对象（不改入参）与遇到的第一个问题。 */
export function substituteServer(server: McpServer, context: VarContext): { server: McpServer; problem: PluginMcpProblem | null } {
  let problem: PluginMcpProblem | null = null;
  const sub = (text: string): string => {
    const result = substituteString(text, context);
    problem ??= result.problem;
    return result.value;
  };
  const subBag = (bag: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(bag).map(([key, value]) => [key, sub(value)]));
  if (isHttpServer(server)) {
    return {
      server: { ...server, url: sub(server.url), ...(server.headers === undefined ? {} : { headers: subBag(server.headers) }) },
      problem,
    };
  }
  const next: McpServer = {
    ...server,
    command: sub(server.command),
    ...(server.args === undefined ? {} : { args: server.args.map(sub) }),
    ...(server.env === undefined ? {} : { env: subBag(server.env) }),
    ...(server.cwd === undefined ? {} : { cwd: sub(server.cwd) }),
  };
  return { server: next, problem };
}

/**
 * 给人看的一行完整命令行：`命令 参数…`，含空白或引号的参数加双引号。http 就是 URL。
 * 它是**展示**，不是拿去过 shell 的——agent 进程是直接 spawn（command + args 数组），不经 shell。
 */
export function formatCommandLine(server: McpServer): string {
  if (isHttpServer(server)) return server.url;
  const quote = (part: string): string =>
    part === "" || /[\s"'\\]/.test(part) ? `"${part.replace(/(["\\])/g, "\\$1")}"` : part;
  return [server.command, ...(server.args ?? [])].map(quote).join(" ");
}
