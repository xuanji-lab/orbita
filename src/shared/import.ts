/**
 * 从别的工具导入**配置**（技能、MCP servers）的契约 —— IPC 四层的第 1 层。设置 › 外部来源页
 * 的第 2–4 步用它：扫描（dry-run，只读勾选的来源）→ 执行（按用户的选择落盘），外加自定义
 * 数据目录的三个通道（添加 / 移除 / 目录选择框，见 ImportCustomRoot）。
 *
 * **聊天记录不再导入**（2026-11 用户裁决：别家的聊天记录留在源头，read_task 只读读取，见
 * shared/external-sources.ts）。此前导入进来的会话、imports.jsonl、meta 里的 importedFrom 都是
 * 历史事实，原样保留（shared/session.ts 照旧解析 importedFrom）。
 *
 * **扫描与执行分离**：执行重新扫描一遍再落盘（不接收 renderer 回传的计划——载荷可过期可篡改）。
 */

/**
 * 来源。技能 / MCP 导入按它分（proma、claude-code、kimi-code、opencode、agent-skills 有配置可导）；
 * 自定义数据目录（ImportCustomRoot）也按它记——那些目录同时是外部会话只读读取的数据目录
 * （shared/external-sources.ts）。下面的说明写的是各来源的数据在哪；会话部分现在只读，不导入。
 *
 * - proma：Proma 桌面应用。数据根是家目录下的 `.proma`（自动定位只认它——名字变体
 *   `.proma-dev`、`.proma-dev-fork` 这类是开发实例，不自动扫，理由见 import-locate.ts 模块头；
 *   散落的历史数据目录走设置 › 外部来源的自定义数据目录手动添加）
 * - claude-code：Claude Code 的会话存储（~/.claude/projects），命令行与 Claude 桌面应用共用；
 *   桌面应用的会话清单只用来认出「被续接取代的旧文件」与取它显示的标题；另有 ~/.claude/skills
 * - kimi-code：Kimi Code 命令行（~/.kimi-code）：会话在 sessions/<工作区>/<会话>/ 下，对话是
 *   agents/main/wire.jsonl 这份事件流；另有 mcp.json。skills 用的是共用目录（归 agent-skills）
 * - opencode：opencode 命令行：会话在它的 SQLite 库（~/.local/share/opencode/opencode.db，只读打开），
 *   MCP 在 ~/.config/opencode/opencode.json
 * - reasonix：Reasonix 桌面版（Electron userData 的 reasonix/projects：Win %APPDATA%、
 *   mac ~/Library/Application Support、Linux ~/.config）：只导会话——projects/<项目>/sessions/
 *   下的旧 JSONL。skills 是共用目录（~/.agents/skills）的链接子集（归 agent-skills）、MCP 只有
 *   TOML 里一台、hooks 双方都没有，都不迁（2026-09-27 裁决）；v5 二进制帧容器另立一刀
 * - zcode：ZCode（~/.zcode/cli/db/db.sqlite，只读打开）：只导会话——会话库与 opencode 同源同形
 *   （session/message/part），转换走 opencode 同一条路。skills 是共用目录（~/.agents/skills）
 *   的 symlink 子集（归 agent-skills）、没有 mcpServers 配置、memories/plugins 是 ZCode 私有
 *   概念无落点，都不迁（2026-09-28 裁决）
 * - agent-skills：多家 agent 共用的 skills 目录（~/.agents/skills），只有 skills，没有会话
 */
export type ImportSourceId = "proma" | "claude-code" | "kimi-code" | "opencode" | "reasonix" | "zcode" | "codex" | "agent-skills";

// ---------------------------------------------------------------------------
// 自定义来源路径
// ---------------------------------------------------------------------------

/**
 * 一条用户手动指定的来源数据目录（第 1 步的「自定义路径」入口）。
 *
 * 背景：proma 的自动定位只认 canonical（开源后名字变体是开发实例，见 import-locate.ts
 * 模块头）；其它来源的自动定位也可能漏掉用户手上散落的历史目录（改过名、挪过地方的
 * 备份）。用户自己找到目录、粘进来，经该来源的 validate（聊天记录在不在）检查后，
 * 这个目录作为该来源的额外数据目录参与探测 / 扫描 / 导入，与自动定位到的目录并列出现
 * 在扫描会读的路径清单里（隐私声明同样覆盖它）。
 *
 * agent-skills 没有定位规格（它是单一共用目录，不在 DATA_ROOT_SPECS 里），不支持
 * 自定义路径。
 */
export interface ImportCustomRoot {
  source: Exclude<ImportSourceId, "agent-skills">;
  /** resolve 后的绝对路径（添加时已展开开头的 ~、过该来源的 validate） */
  dir: string;
}

/** 添加 / 移除的入参。dir 原样传（renderer 不碰文件系统；~ 开头在主进程展开）。 */
export interface ImportCustomRootInput {
  source: Exclude<ImportSourceId, "agent-skills">;
  dir: string;
}

/** 添加失败的原因（词汇进错误码，UI 按它给文案）。 */
export type ImportCustomRootInvalidReason =
  /** 目录不存在，或不足目录（断链也算） */
  | "not-found"
  /** 该来源的 validate 不过：里面没有可识别的聊天记录 */
  | "no-data"
  /** 同一来源已经添加过同一个目录 */
  | "duplicate";

/**
 * `import:custom-roots:add` 失败时抛的稳定错误码（附 ImportCustomRootInvalidReason 原文，
 * 如 `IMPORT_CUSTOM_ROOT_INVALID:no-data`）——主进程只给稳定码、不猜界面语言，renderer
 * 按码翻文案。
 */
export const IMPORT_CUSTOM_ROOT_INVALID_CODE = "IMPORT_CUSTOM_ROOT_INVALID:";

/** 扫描请求：只扫勾选的来源。空数组 = 什么都不读，返回空报告。 */
export interface ImportScanInput {
  sources: ImportSourceId[];
}

/** 执行请求：按扫描时同样的来源重扫，再按勾选落盘。 */
export interface ImportRunInput {
  sources: ImportSourceId[];
  /** 勾选的 skill（ImportSkillItem.dir） */
  skills: string[];
  skillMode: ImportSkillMode;
  /** 按组改过的作用域（没改的组用默认：全部会话） */
  skillScopes: ImportSkillScopeChoice[];
  /** 勾选的 MCP server 名 */
  mcp: string[];
}

/** 扫描报告：能导的技能（按源目录分组）与 MCP servers。 */
export interface ImportScanReport {
  skills: ImportSkillGroup[];
  mcp: ImportMcpItem[];
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * 一条源 skill 相对 orbita 的状态。重名按 slug（目录名）认——orbita 的中心存储按它落目录。
 */
export type ImportSkillStatus =
  /** 可导，默认勾 */
  | "new"
  /** 可导，默认不勾：源应用自带的（Proma 的 default-skills），多半调的是那个应用自己的工具 */
  | "built-in"
  /** orbita 里已有同名的，不动它 */
  | "in-orbita"
  /** 前面哪一组已经列过同名的（先到先得） */
  | "duplicate";

export interface ImportSkillItem {
  /** 目录名，落进 orbita 后的 slug */
  slug: string;
  /** SKILL.md frontmatter 的 name，没有就是 slug */
  name: string;
  description: string;
  /** 源目录绝对路径——也是勾选的键 */
  dir: string;
  status: ImportSkillStatus;
  /** duplicate：先列出它的那一组的 dir；其余为 null */
  duplicateOf: string | null;
}

/** 一个源 skills 目录（页面的一组）。 */
export interface ImportSkillGroup {
  source: ImportSourceId;
  /** 来源内的名字（Proma 的工作区名、「synced」之类）；来源只有一个目录时为 null */
  name: string | null;
  /** 源目录绝对路径——也是作用域覆盖的键 */
  dir: string;
  skills: ImportSkillItem[];
}

/** skill 落进 orbita 的方式。copy（默认）：源应用删了也还在；link：跟着源目录的后续修改 */
export type ImportSkillMode = "copy" | "link";

/**
 * 一组 skill 的作用域。global = 对所有会话生效；workspace = 只对该工作区；off = 只放进存储、先不启用。
 * 与 SkillScope 同形再加 off：这是导入页的选择，不是 skill 的状态。
 */
export type ImportSkillScope = { kind: "global" } | { kind: "workspace"; workspaceId: string } | { kind: "off" };

export interface ImportSkillScopeChoice {
  /** ImportSkillGroup.dir */
  dir: string;
  scope: ImportSkillScope;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * 一台源 MCP server 相对 orbita 的状态。按名字认（orbita 的 mcp.json 以名字为键）。
 */
export type ImportMcpStatus =
  /** 可导，默认勾；导进来是停用的 */
  | "new"
  /** orbita 里已有同名的，不动它 */
  | "in-orbita"
  /** orbita 接不了的形态（SSE 传输、名字里有 orbita 不认的字符……），列出来说明原因 */
  | "unsupported";

/** 这台 server 在源里出现在哪（同名的在几个来源都有时，页面把出处都列上）。 */
export interface ImportMcpOrigin {
  source: ImportSourceId;
  /** 源里的位置：Proma 的工作区名、Claude Code 的项目目录；全局配置为 null */
  where: string | null;
}

/**
 * 页面上的一行。**不带配置本体**：headers / env 里常有密钥，渲染层不需要它们；执行时主进程
 * 按名字重扫取配置。同名的多份按来源顺序取第一份，其余只进 origins。
 */
export interface ImportMcpItem {
  name: string;
  transport: "stdio" | "http";
  /** 给人看的一行：stdio 是命令，http 是 URL */
  detail: string;
  /** 配置里有 headers 或 env：会原样带过来（含密钥），页面标出来 */
  carriesSecrets: boolean;
  origins: ImportMcpOrigin[];
  status: ImportMcpStatus;
  /** unsupported 的原因（给人看） */
  reason: string | null;
}

/** 执行报告。 */
export interface ImportRunReport {
  /** 落进 orbita 的 skill 数 */
  skillsImported: number;
  /** 没落进去的 skill（同名刚被别处占了、复制失败……） */
  skillsFailed: { slug: string; error: string }[];
  /** 加进 orbita mcp.json 的 server 数（都是停用的） */
  mcpImported: number;
  mcpFailed: { name: string; error: string }[];
}

// ---------------------------------------------------------------------------
// IPC 边界的入参校验
// ---------------------------------------------------------------------------

/**
 * 运行时认的来源：**按 ImportSourceId 穷尽写成一张表**。此前是 `satisfies readonly ImportSourceId[]`
 * 的数组——它只保证列进去的合法，查不出漏列：Codex 导入器写好了却漏登记，扫描一开始就被
 * 这里以 `unknown import source` 挡掉（樊嘉铭 2026-09-27 修的那个）。写成 Record 之后，
 * 类型里新增来源而这里忘了登记，编译期就报错。
 */
const SOURCE_ID_TABLE: Record<ImportSourceId, true> = {
  proma: true,
  "claude-code": true,
  "kimi-code": true,
  opencode: true,
  reasonix: true,
  zcode: true,
  codex: true,
  "agent-skills": true,
};
const SOURCE_IDS: readonly string[] = Object.keys(SOURCE_ID_TABLE);

/** 自定义路径入口支持的来源（= 有定位规格 DATA_ROOT_SPECS 的那批；agent-skills 不支持）。 */
const CUSTOM_ROOT_SOURCES: readonly Exclude<ImportSourceId, "agent-skills">[] = (
  Object.keys(SOURCE_ID_TABLE) as ImportSourceId[]
).filter((id): id is Exclude<ImportSourceId, "agent-skills"> => id !== "agent-skills");

/** 来源 id 是不是支持自定义路径的那批（IPC 入参校验用；新来源登记进 SOURCE_ID_TABLE
 * 后自动进这里，但主进程的 DATA_ROOT_SPECS 同样会因类型缺它而编译不过——两边都不至遗漏）。 */
export function isCustomRootSource(value: unknown): value is Exclude<ImportSourceId, "agent-skills"> {
  return typeof value === "string" && (CUSTOM_ROOT_SOURCES as readonly string[]).includes(value);
}

/** 来源 id 的运行时判定（IPC 入参校验）。 */
function isImportSourceId(value: unknown): value is ImportSourceId {
  return typeof value === "string" && SOURCE_IDS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSources(raw: unknown): ImportSourceId[] {
  if (!Array.isArray(raw)) throw new Error("sources must be an array");
  const out: ImportSourceId[] = [];
  for (const id of raw) {
    // 不认识的来源整体拒绝：静默丢掉会让「勾了但没扫」看起来像「扫了但是空的」
    if (!isImportSourceId(id)) throw new Error(`unknown import source: ${String(id)}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function parseSkillScope(raw: unknown): ImportSkillScope {
  if (!isRecord(raw)) throw new Error("skill scope must be an object");
  if (raw["kind"] === "global") return { kind: "global" };
  if (raw["kind"] === "off") return { kind: "off" };
  if (raw["kind"] === "workspace" && typeof raw["workspaceId"] === "string" && raw["workspaceId"] !== "") {
    return { kind: "workspace", workspaceId: raw["workspaceId"] };
  }
  throw new Error("bad skill scope");
}

/**
 * renderer 传来的是 unknown。**坏形状整体拒绝（抛错）**，不挑能用的部分凑合——
 * 这是一次会落盘的操作，改写用户意图比报错更糟。
 */
export function parseImportScanInput(raw: unknown): ImportScanInput {
  if (!isRecord(raw)) throw new Error("scan input must be an object");
  return { sources: parseSources(raw["sources"]) };
}

/**
 * 自定义路径的入参：坏形状整体拒绝（与 parseImportScanInput 同款纪律）——静默丢掉
 * 会让「添加了但没生效」看起来像「检查过了但不行」。
 */
export function parseImportCustomRootInput(raw: unknown): ImportCustomRootInput {
  if (!isRecord(raw)) throw new Error("custom root input must be an object");
  const source = raw["source"];
  if (!isCustomRootSource(source)) throw new Error(`unknown import source: ${String(source)}`);
  const dir = raw["dir"];
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("custom root dir must be a non-empty string");
  return { source, dir: dir.trim() };
}

export function parseImportRunInput(raw: unknown): ImportRunInput {
  if (!isRecord(raw)) throw new Error("run input must be an object");
  const skills = raw["skills"];
  if (!Array.isArray(skills) || !skills.every((dir) => typeof dir === "string")) {
    throw new Error("skills must be an array of folders");
  }
  const skillMode = raw["skillMode"];
  if (skillMode !== "copy" && skillMode !== "link") throw new Error("skillMode must be copy or link");
  const skillScopes = raw["skillScopes"];
  if (!Array.isArray(skillScopes)) throw new Error("skillScopes must be an array");
  const mcp = raw["mcp"];
  if (!Array.isArray(mcp) || !mcp.every((name) => typeof name === "string")) {
    throw new Error("mcp must be an array of server names");
  }
  return {
    sources: parseSources(raw["sources"]),
    skills: [...new Set(skills as string[])],
    skillMode,
    mcp: [...new Set(mcp as string[])],
    skillScopes: skillScopes.map((choice) => {
      if (!isRecord(choice) || typeof choice["dir"] !== "string" || choice["dir"] === "") {
        throw new Error("skill scope choice must name a folder");
      }
      return { dir: choice["dir"], scope: parseSkillScope(choice["scope"]) };
    }),
  };
}
