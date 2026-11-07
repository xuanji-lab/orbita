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
import type { PluginBoardInfo, PluginExternal, PluginIo, PluginWaitKind } from "./plugin-board.ts";

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
 * 卸载归档里的一条（`plugins-archive/<name>-<时间戳>.json` 的只读投影）。
 * `id` 是归档文件名去掉 `.json`，只当不透明句柄；`global` / `workspaces` 是卸载前的位置
 * （placement，停用的也有），界面按它回答「原来在哪个工作区能用」。本契约**只读**——没有恢复通道。
 */
export interface PluginArchiveEntry {
  id: string;
  name: string;
  archivedAt: number;
  global: boolean;
  workspaces: string[];
}

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
  | "dependencies"
  /** 清单 `orbita` 对象里除 workflow / io / external / board / tuned 之外的子键（Orbita 还不认识的扩展）：items 是键名 */
  | "orbita";

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
 * 清单 `orbita.workflow` 的一步（Orbita 的清单扩展：给人看的「这个插件怎么做事」，不执行）。
 * 数组顺序即步骤顺序。`skill` 写技能的 name 或 slug，解析时对上本插件的某条技能。
 */
export interface PluginWorkflowStep {
  title: string;
  /** 清单里写的技能（name 或 slug）；没写为 null */
  skill: string | null;
  /** 对上了本插件哪条技能（它的 slug：`/skill:` 点名与只读查看用）；没写 skill 或对不上为 null——写了却为 null 就是「找不到这个技能」 */
  skillSlug: string | null;
  detail: string | null;
  /** 这一步产出的文件（相对路径，只展示不读取） */
  output: string | null;
  /** 这一步等用户：「board」= 在看板上点，「chat」= 在对话里回；不写 / null = 自动往下走 */
  wait: PluginWaitKind | null;
}

/** 插件里一条技能的 SKILL.md 原文（只读查看用）。 */
export interface PluginSkillFile {
  slug: string;
  /** 绝对路径 */
  path: string;
  content: string;
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
    | "root-missing"
    /** 旧技能：链接还在、真身目录没了（在 Orbita 之外被挪走 / 改名）。detail 是技能目录名；详情里提示可清理断链引用 */
    | "skill-folder-missing"
    /** `orbita.workflow` 写得不对（不是数组、某一步没有 title）：detail 是哪一步 / 哪个字段，那一步被跳过 */
    | "workflow-invalid"
    /** `orbita.io` 写得不对（不是对象、某项没有 path）：detail 是哪一项，那一项被跳过 */
    | "io-invalid"
    /** `orbita.external` 写得不对（不是数组、某项没有 name / kind 不认识）：同上 */
    | "external-invalid"
    /** `orbita.board` 写得不对（卡的 id 重复 / 尺寸不认识 / 缺 template……）：detail 是哪张卡 / 哪个字段，那张卡被跳过 */
    | "board-invalid"
    /** 清单还在写已作废的 `orbita.panel`：它已改名为 `orbita.board`，不再渲染 */
    | "panel-renamed"
    /** `orbita.tuned` 不是 true / false */
    | "tuned-invalid";
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
  /** Orbita 随应用带的插件：内容在安装包的资源目录里，随版本更新；可停用，不可卸载 */
  | { kind: "builtin" }
  | { kind: "copy"; from: string }
  | { kind: "link"; path: string }
  | { kind: "git"; url: string; commit: string };

export interface PluginInstallInfo {
  source: PluginSourceRecord;
  /** `${CLAUDE_PLUGIN_ROOT}`：复制 / git 是 userData 里的副本，链接是用户的源目录，内置是安装包资源目录里的那份 */
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
  /** 清单 `orbita.workflow` 解析后的步骤；没写为空数组 */
  workflow: PluginWorkflowStep[];
  io: PluginIo;
  external: PluginExternal[];
  board: PluginBoardInfo | null;
  tuned: boolean;
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
  /** 清单 `orbita.workflow` 解析后的步骤；没写（或旧技能 / 旧 MCP）为空数组，详情页不显示这一块 */
  workflow: PluginWorkflowStep[];
  /** 清单 `orbita.io`：读什么、写到哪（给人看）；没写为两个空数组 */
  io: PluginIo;
  /** 清单 `orbita.external`：外接的服务 / 命令行（给人看）；没写为空数组 */
  external: PluginExternal[];
  /** 清单 `orbita.board` 解析后的看板；没写（或写坏了整块）为 null */
  board: PluginBoardInfo | null;
  /** 清单 `orbita.tuned`：用户和插件磨合好了（会话里调用时只出一行 + 卡，不解释） */
  tuned: boolean;
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

// ---------- agent 的 install_plugin / list_plugins / preview_plugin ----------

/** agent 工具里的范围：只有两个字，「workspace」= 这条会话所在的工作区（主进程按会话归属解析）。 */
export type PluginAgentScope = "workspace" | "global";

/**
 * 对话里「装上插件」那一行的数据。**它是 install_plugin 工具结果的 `details.pluginInstall`**——
 * 工具结果本来就随会话落盘，所以这一行重开会话、隔很久都在，不另开一种会话记录。
 *
 * 一行有两种来历：
 * - `installed`：这次调用直接装上了（低风险：工作区内、链接安装、不带 MCP、范围是工作区、无冲突，
 *   且会话不在 manual 档）；
 * - `pending`：需要用户看一眼，工具已立即返回，装不装等用户点这一行的「安装」。`reason` 说为什么。
 * 行上显示「已装上」还是「安装」**不看 state，看渲染时的已装列表**：用户后来卸载了、或在别处装了，
 * 行都照实说（state 只是它被画出来时的样子）。
 */
export interface PluginInstallRow {
  state: "installed" | "pending";
  /** pending 的原因：带 MCP（会在本机启动程序）/ 范围是所有工作区 / manual 档（每个动作都要用户点头）；installed 为 null */
  reason: "mcp" | "global" | "manual" | null;
  /** 插件名（plugin.json 的 name；已装列表里按它找） */
  name: string;
  displayName: string;
  /** 插件文件夹（已 realpath）。点「安装」时主进程会重新校验它仍在这条会话的工作区内 */
  path: string;
  scope: PluginAgentScope;
  /** scope 为 workspace 时的工作区名（行上写「只在 XX」） */
  workspaceName: string | null;
  /** 技能 slug */
  skills: string[];
  /** 会在本机启动的完整命令行（每台 MCP 一条，敏感值已掩码）；空 = 不带 MCP */
  commands: string[];
  /**
   * 用户看到的东西的指纹（名字 + 范围 + 技能 + MCP 命令行）。点「安装」时主进程重新读文件夹再算一遍，
   * 对不上（用户看到这一行之后文件夹里的命令改了）就拒装，请用户让智能体重新提交。
   */
  fingerprint: string;
}

/** 工具结果的 details 里取出那一行；形状不对为 null（旧会话、别的工具、坏数据都当没有）。 */
export function parsePluginInstallRow(details: unknown): PluginInstallRow | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["pluginInstall"];
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;
  const state = row["state"];
  const reason = row["reason"];
  const scope = row["scope"];
  const skills = strings(row["skills"]);
  const commands = strings(row["commands"]);
  if (state !== "installed" && state !== "pending") return null;
  if (reason !== null && reason !== "mcp" && reason !== "global" && reason !== "manual") return null;
  if (scope !== "workspace" && scope !== "global") return null;
  if (skills === null || commands === null) return null;
  const { name, displayName, path, fingerprint, workspaceName } = row;
  if (typeof name !== "string" || name === "" || typeof displayName !== "string" || typeof path !== "string" || path === "") return null;
  if (typeof fingerprint !== "string" || (workspaceName !== null && typeof workspaceName !== "string")) return null;
  return { state, reason, name, displayName, path, scope, workspaceName, skills, commands, fingerprint };
}

/**
 * install_plugin 的结果（主进程 → agent 进程，形状即契约）。**立即返回，不等用户**。成功三种：
 * - `installed`：直接装上了（`row` 留在对话里）；
 * - `pending`：需要用户看一眼，已在对话里留了带「安装」的一行，agent 应结束这一轮（`row` 同上）；
 * - `already`：这个文件夹早已链接安装，没有新的一行，改动下一轮自动生效。
 * 失败的 `error` 原样成为工具失败原因给模型看，要写成它照着能改的话。
 */
export type PluginAgentInstallOutcome =
  | {
      ok: true;
      kind: "installed" | "already";
      name: string;
      scope: PluginAgentScope;
      skills: string[];
      mcp: string[];
      /** `${CLAUDE_PLUGIN_DATA}`：插件的数据目录。看板卡上的动作（orbita:action）追加在这里的 actions.jsonl，插件自己的脚本下一轮去读它 */
      dataDir: string;
      /** installed 时有；already 没有行 */
      row: PluginInstallRow | null;
    }
  | { ok: true; kind: "pending"; name: string; scope: PluginAgentScope; skills: string[]; mcp: string[]; row: PluginInstallRow }
  | { ok: false; error: string };

/**
 * 用户点对话里那一行的「安装」（renderer → 主进程）。主进程**不信这些字段**：会话、路径、范围逐项重验，
 * 文件夹现读现算指纹，对得上才装。
 */
export interface PluginRowInstallRequest {
  sessionId: string;
  path: string;
  scope: PluginAgentScope;
  fingerprint: string;
}

/** 点「安装」的结局。`reason` 是稳定的代码，句子由界面按语言出；`detail` 是路径 / 系统错误原文这类语言中立的东西。 */
export type PluginRowInstallResult =
  | { ok: true; name: string }
  | {
      ok: false;
      reason:
        /** 会话不在了 */
        | "no-session"
        /** 文件夹不在了 / 不在这条会话的工作区内 / 不是插件 */
        | "not-found"
        /** 用户看到这一行之后，文件夹里会启动的命令（或技能、名字）变了 */
        | "changed"
        /** 清单有问题 / 重名冲突：detail 说是什么 */
        | "invalid"
        | "failed";
      detail: string;
    };

/** preview_plugin 里一个看板文件的检查：清单 `orbita.board` 写了它，文件在不在（路径在插件根内才算）。 */
export interface PluginDraftFile {
  /** `spec` 是看板级的（card 为 null），其余三种属于某张卡 */
  card: string | null;
  key: "template" | "spec" | "sample" | "data";
  /** 清单里写的路径（原样） */
  path: string;
  exists: boolean;
}

/**
 * preview_plugin 的结果：只扫描、不安装。`issues` 是装之前要修的东西（agent 能照着改），
 * 不是失败——草稿没做完时有 issues 很正常，右栏照样显示。
 */
export type PluginAgentPreviewOutcome =
  | {
      ok: true;
      name: string;
      /** 已转成真实路径的插件文件夹（右栏的「正在做」视图读它） */
      path: string;
      skills: string[];
      workflow: string[];
      boardFiles: PluginDraftFile[];
      issues: string[];
      /** 同名插件此刻已装上（草稿是在改一个已装的插件） */
      installed: boolean;
    }
  | { ok: false; error: string };

/**
 * 草稿预览的扫描结果（`plugin:draft-load`，轮询）：还没安装的插件文件夹，用与已装页同一形状的视图给出——
 * 「正在做」就是同一张详情长页。草稿没有启用范围与安装记录（`scope` 为 off、`install` 为 null）。
 * `stamp` 是内容签名：没变回 unchanged。
 */
export type PluginDraftSnapshot =
  | { kind: "unchanged" }
  | { kind: "unavailable"; stamp: string; reason: "not-found" | "outside-workspace" }
  | { kind: "ready"; stamp: string; view: PluginView };

/**
 * 「正在做」列表的一行（`plugin:drafts`）：某个工作区 `plugins/<文件夹>/` 下**有清单、但还没安装**的插件文件夹。
 * 用户中途离开、之后回来「有空把它做完」的入口——草稿没有别的存在形式（只是磁盘上的一个文件夹）。
 * 路径是 realpath 之后落在该工作区根内的真实路径（可以原样交给 `plugin:draft-load`）。
 */
export interface PluginDraftEntry {
  workspaceId: string;
  /** 插件文件夹的真实路径 */
  path: string;
  /** 清单 name；没写用文件夹名（小写） */
  name: string;
  /** 清单 displayName；没写同 name */
  displayName: string;
  description: string;
  /** 文件夹里最近一次改动的时间（毫秒时间戳） */
  updatedAt: number;
  /** 最近一次对它 preview_plugin 的会话；没记过 / 会话已删为 null */
  sessionId: string | null;
  /** 那条会话的标题；会话没了、或还没有标题为 null */
  sessionTitle: string | null;
  /** 清单读不出来 / 写坏了的原文（草稿还在写时常见）；清单没问题为 null */
  manifestProblem: string | null;
}

/** list_plugins 的一行：这条会话能用的真插件（含内置）；旧技能 / 旧 MCP 不列（技能索引里本来就有）。 */
export interface PluginAgentListItem {
  name: string;
  description: string;
  origin: "builtin" | "plugin";
  /** 技能 slug */
  skills: string[];
  /** 清单里的 MCP 服务名 */
  mcp: string[];
  /** workflow 每一步的标题（没写为空） */
  workflow: string[];
  /** 插件根目录（绝对路径）：agent 要改它时去这里 */
  root: string;
  /** 插件数据目录（绝对路径）：看板动作的 actions.jsonl 在这里 */
  dataDir: string;
}

export type PluginAgentListOutcome = { ok: true; plugins: PluginAgentListItem[] } | { ok: false; error: string };

/** 内置插件的名字表：随应用带的、默认对所有工作区启用、不可卸载。内容目录与它同名。 */
export const BUILTIN_PLUGIN_NAMES = ["plugin-creator", "skill-kit", "docs-slides", "terminal"] as const;

export function isBuiltinPluginName(name: string): boolean {
  return (BUILTIN_PLUGIN_NAMES as readonly string[]).includes(name);
}
