/**
 * 插件契约 —— IPC 四层的第 1 层。
 *
 * **插件 = 一个目录**（Claude Code 兼容）：`.claude-plugin/plugin.json`（ZCode 官方插件用
 * `.zcode-plugin/plugin.json`）里写元数据，`skills/<slug>/SKILL.md` 与 `.mcp.json` 是默认位置。
 * 清单可选。用户只看到「插件」这一种单位：里面有技能、有 MCP、有脚本，只是丰富度不同。
 * 原来的技能和 MCP 不搬文件，界面上各自显示成「只有一样东西的插件」（`origin` 区分来源）。
 *
 * **谁的状态在哪**（不开第二份真相）：
 * - 真插件：`<userData>/plugins.json` 的安装记录（范围、配置值）+ `<userData>/plugins/<name>/` 的副本
 *   （链接安装只记源路径）；
 * - 旧技能：`skill-links/` 的链接表；旧 MCP：`mcp.json` 的 `disabled` 与 `workspaces` 白名单。
 *   视图（PluginView）是读出来的结果，不落盘。
 *
 * 解析规格对照 https://code.claude.com/docs/en/plugins/manifest-reference ：
 * 能加载的只有 skills 与 mcpServers，其余组件解析出来列为「暂不支持」，不加载但不静默丢。
 */

/** 插件名：和 Claude Code 一样当标识用（目录名、服务名前缀、记录键），所以从严。 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isPluginName(value: string): boolean {
  return PLUGIN_NAME_PATTERN.test(value);
}

/**
 * 清单文件的认法与顺序：先 Claude Code 的，再 ZCode 的。
 * 相对插件根，正斜杠（Windows 上由调用方 join）。
 */
export const PLUGIN_MANIFEST_PATHS = [".claude-plugin/plugin.json", ".zcode-plugin/plugin.json"] as const;

/** 启用范围：停用 / 所有工作区 / 只在这些工作区（含没有工作区的会话不算：它没有 id）。 */
export type PluginScope =
  | { kind: "off" }
  | { kind: "global" }
  | { kind: "workspaces"; ids: string[] };

/** 停用前的位置（停用的行仍落在原来的组里，开关一拨就回原位）。 */
export type PluginPlacement = Exclude<PluginScope, { kind: "off" }>;

/**
 * 这个范围对归属为 `workspaceId` 的会话是否生效。`null` = 会话不属于任何工作区（Home）：
 * 只有「所有工作区」覆盖它——与 MCP 白名单、skill 链接同一口径。
 * **开轮装配与界面分组共用这一份**，两处各写一遍就会走出「列表说在、开轮却没带」的分叉。
 */
export function scopeApplies(scope: PluginScope, workspaceId: string | null): boolean {
  if (scope.kind === "global") return true;
  if (scope.kind === "workspaces") return workspaceId !== null && scope.ids.includes(workspaceId);
  return false;
}

// ---------- 配置项（userConfig） ----------

export type PluginConfigType = "string" | "number" | "boolean" | "directory" | "file";

export type PluginConfigValue = string | number | boolean | string[];

/** 清单里声明的一个配置项（解析后的规范形状；ZCode 清单缺 title / required，按键名与 false 补）。 */
export interface PluginConfigField {
  key: string;
  type: PluginConfigType;
  title: string;
  description: string;
  required: boolean;
  /** 敏感值走系统密钥库，永不进 plugins.json，也永不进 renderer */
  sensitive: boolean;
  default: PluginConfigValue | null;
  /** string 型的固定选项（选择器） */
  options: string[] | null;
  multiple: boolean;
  min: number | null;
  max: number | null;
}

/** 一个配置项此刻的状态。敏感项 `value` 恒为 null，只告诉有没有填（`isSet`）。 */
export interface PluginConfigState {
  field: PluginConfigField;
  value: PluginConfigValue | null;
  isSet: boolean;
}

// ---------- 里面有什么 ----------

/** 暂不支持的组件种类：解析出来列给用户看，不加载。 */
export type PluginUnsupportedKind =
  | "commands"
  | "agents"
  | "hooks"
  | "lsp"
  | "output-styles"
  | "monitors"
  | "bin"
  | "panel"
  | "channels"
  | "workflows"
  | "themes"
  | "settings"
  | "mcp-bundle"
  | "dependencies";

export interface PluginUnsupported {
  kind: PluginUnsupportedKind;
  /** 里面的名字（命令名、智能体名……）；最多列前几个，数量以 `count` 为准 */
  items: string[];
  count: number;
}

export interface PluginSkillInfo {
  /** 技能目录名：`/skill:<slug>` 点名用它 */
  slug: string;
  /** SKILL.md 头里的 name（pi 拿它当 prompt 标识）；没写就是 slug */
  name: string;
  description: string;
}

/**
 * 一台 MCP 为什么起不来。`command-missing` 只是提醒（照常装配，连不上由 MCP 状态如实报）。
 * `invalid.reason` 是稳定的代码（`unsupported-shape`），不是句子——界面按语言出文案。
 */
export type PluginMcpProblem =
  | { kind: "unknown-variable"; variable: string }
  | { kind: "config-missing"; key: string }
  | { kind: "invalid"; reason: string }
  | { kind: "command-missing"; command: string };

/** 起不来的问题会让这台 server 不进开轮装配；提醒类不拦。 */
export function isBlockingMcpProblem(problem: PluginMcpProblem | null): boolean {
  return problem !== null && problem.kind !== "command-missing";
}

export interface PluginMcpInfo {
  /** 清单里的服务名 */
  name: string;
  /** 模型看到的服务名：`plugin_<插件名>_<服务名>`，工具叫 `mcp__<它>__<工具>` */
  qualified: string;
  transport: "stdio" | "http";
  /** 会在本机启动的**完整命令行**（变量已替换；来自敏感配置的值掩码）或远端 URL */
  commandLine: string;
  problem: PluginMcpProblem | null;
}

/**
 * 解析清单与目录时碰到的、值得告诉用户的事（不挡安装）。`detail` 是路径、键名或系统错误原文，
 * 语言中立；说明这件事的句子由界面按语言出（主进程不拼用户可见的句子）。
 */
export interface PluginProblem {
  kind:
    | "manifest-unreadable"
    | "manifest-invalid"
    | "path-escape"
    | "path-missing"
    | "skill-unreadable"
    /** SKILL.md 没有 description：pi 不加载它，模型看不到 */
    | "skill-no-description"
    /** userConfig 的键名不合法，这一项被跳过 */
    | "config-key-invalid"
    | "mcp-unreadable"
    /** 链接安装的源目录没了（用户挪走 / 删了）：记录还在，内容读不到 */
    | "root-missing";
  detail: string;
}

/** 装不上 / 起不来的冲突。重名一律拒装，由用户去改名（不自动改名、不静默丢一个）。 */
export type PluginConflict =
  | { kind: "skill-name"; skill: string; with: { origin: "user-skill" | "plugin"; name: string } }
  | { kind: "skill-duplicate"; skill: string }
  | { kind: "plugin-exists"; name: string }
  | { kind: "mcp-name"; server: string; qualified: string; with: string };

// ---------- 安装 ----------

export type PluginSource = { kind: "folder"; path: string } | { kind: "git"; url: string };

/** 文件夹来源的两种装法；git 来源恒为克隆副本。 */
export type PluginInstallMode = "copy" | "link";

export type PluginSourceRecord =
  | { kind: "copy"; from: string }
  | { kind: "link"; path: string }
  | { kind: "git"; url: string; commit: string };

export interface PluginInstallInfo {
  source: PluginSourceRecord;
  /** `${CLAUDE_PLUGIN_ROOT}`：复制 / git 是 userData 里的副本，链接是用户的源目录 */
  root: string;
  /** `${CLAUDE_PLUGIN_DATA}` */
  dataDir: string;
  installedAt: number;
  updatedAt: number;
}

/** 安装前给用户看的确认内容：它带了什么、MCP 在本机起的命令行、配置项、不支持的、冲突。 */
export interface PluginPreview {
  /** 复制 / git 的暂存目录句柄（确认前先拷出来，确认的就是装上的）；链接为 null */
  previewId: string | null;
  name: string;
  displayName: string;
  version: string | null;
  description: string;
  author: string | null;
  license: string | null;
  source: PluginSource;
  mode: "copy" | "link" | "git";
  /** 清单文件（相对插件根）；没有清单为 null */
  manifestFile: string | null;
  /** 装好后的根目录（= `${CLAUDE_PLUGIN_ROOT}`） */
  root: string;
  hasScripts: boolean;
  skills: PluginSkillInfo[];
  mcp: PluginMcpInfo[];
  unsupported: PluginUnsupported[];
  config: PluginConfigField[];
  conflicts: PluginConflict[];
  problems: PluginProblem[];
}

export type PluginPreviewError =
  | { kind: "not-a-plugin" }
  | { kind: "invalid-name"; name: string }
  | { kind: "git-url-rejected"; url: string }
  | { kind: "git-failed"; message: string }
  | { kind: "too-large" }
  | { kind: "symlink-escape"; paths: string[] }
  | { kind: "read-failed"; message: string };

export interface PluginPreviewRequest {
  source: PluginSource;
  mode: PluginInstallMode;
}

export type PluginPreviewResult =
  | { ok: true; preview: PluginPreview }
  | { ok: false; error: PluginPreviewError };

export interface PluginInstallRequest {
  preview: PluginPreviewRequest;
  /** 预览给的暂存句柄（复制 / git）；链接为 null */
  previewId: string | null;
  scope: PluginScope;
}

export type PluginInstallResult =
  | { ok: true; id: string }
  | { ok: false; error: PluginPreviewError | { kind: "conflict"; conflicts: PluginConflict[] } | { kind: "stale-preview" } };

// ---------- 已装页的一行 / 详情 ----------

/** 视图的来源：真插件，或原来的技能 / MCP 显示成的「一样东西的插件」。 */
export type PluginOrigin = "plugin" | "user-skill" | "user-mcp";

/**
 * 已装页的一条（列表与详情共用一份）。**id 的前缀决定去哪读写**：
 * `plugin:<name>` 走插件存储，`skill:<slug>` 走 skill 链接表，`mcp:<server>` 走 mcp.json。
 */
export interface PluginView {
  id: string;
  origin: PluginOrigin;
  /** 显示名 */
  name: string;
  description: string;
  author: string | null;
  version: string | null;
  license: string | null;
  /** 有效范围：开关与「装在哪」的真值 */
  scope: PluginScope;
  /** 分组落点：停用的仍落在原位置；null = 没有位置（旧技能全没链，落「未启用」组） */
  placement: PluginPlacement | null;
  /** 一行小字用：技能 N · MCP · 脚本 */
  contents: { skills: number; mcp: number; scripts: boolean };
  skills: PluginSkillInfo[];
  mcp: PluginMcpInfo[];
  unsupported: PluginUnsupported[];
  config: PluginConfigState[];
  /** 此刻的冲突（装好后用户又加了同名技能之类）；有就在详情里亮出来 */
  conflicts: PluginConflict[];
  problems: PluginProblem[];
  /** 仅真插件 */
  install: PluginInstallInfo | null;
  /** 旧技能：真实目录；旧 MCP：它的命令行（给「它能做什么」那一行的副标题） */
  location: string | null;
}

/**
 * 已装页的数据：真插件 + 旧技能 + 旧 MCP 合成一张表。`mcpError` 是 mcp.json 读不出来的原文——
 * 读不出来不能说成「你没有 MCP」（D-3 同款），也不该让整页打不开：其余照常列，错误贴在页上。
 */
export interface PluginListResult {
  plugins: PluginView[];
  mcpError: string | null;
}

export const PLUGIN_ID_PREFIX = { plugin: "plugin:", skill: "skill:", mcp: "mcp:" } as const;

export function pluginViewId(origin: PluginOrigin, key: string): string {
  const prefix = origin === "plugin" ? PLUGIN_ID_PREFIX.plugin : origin === "user-skill" ? PLUGIN_ID_PREFIX.skill : PLUGIN_ID_PREFIX.mcp;
  return `${prefix}${key}`;
}

/** 拆视图 id；不是三种前缀之一返回 null（IPC 入参校验用）。 */
export function parsePluginViewId(id: string): { origin: PluginOrigin; key: string } | null {
  for (const [origin, prefix] of [
    ["plugin", PLUGIN_ID_PREFIX.plugin],
    ["user-skill", PLUGIN_ID_PREFIX.skill],
    ["user-mcp", PLUGIN_ID_PREFIX.mcp],
  ] as const) {
    if (id.startsWith(prefix) && id.length > prefix.length) return { origin, key: id.slice(prefix.length) };
  }
  return null;
}
