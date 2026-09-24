/**
 * 迁移（设置 › Migration）的契约 —— IPC 四层的第 1 层（与引擎同 PR 落地，消费者纪律）。
 * 三个通道：探测（只 stat）→ 扫描（dry-run，只读勾选的来源）→ 执行（按用户的选择落盘）。
 *
 * 通路背景（调研 2026-09-21）：Proma 的 pi 真源（`~/.proma-dev/sdk-config/sessions/`，
 * header version 3）与 orbita 锁定的 pi 0.84.3 同版本同格式——这层导入是**同构复制 +
 * 元数据映射**，无 LLM 参与。本文件只定义「扫描报告 / 执行报告」的形状与跳过原因的
 * 词汇；映射规则（工作区三规则、模型归一化）在引擎里，`src/main/session/importer.ts`。
 *
 * **扫描与执行分离**：扫描（dry-run）只读两侧磁盘产出汇总；执行重新扫描一遍再落盘
 * （不接收 renderer 回传的计划——载荷可过期可篡改，重扫的两次结果在数据没变时一致，
 * 数据变了就该以新的为准）。
 */

/**
 * 迁移来源。本刀只有 Proma；Claude Code / Kimi Code / opencode 各自一刀再加进来
 * （2026-09-24 裁决：暂不支持的来源不列，支持了再出现）。
 */
export type ImportSourceId = "proma";

/**
 * 一个来源的探测结果。打开 Migration 页就跑，**只 stat，不读内容**。
 *
 * `paths` 是扫描时会读的全部路径，页面原样列出——这张清单就是隐私声明：
 * 用户看得到 orbita 会碰哪些文件，没勾的来源一个字节都不读。
 */
export interface ImportSourceProbe {
  id: ImportSourceId;
  /** 给人看的名字 */
  label: string;
  /** 产品形态：桌面应用 / 命令行工具 / 多家共用的目录（Sources 行的副标题） */
  kind: "app" | "cli" | "folder";
  /** 扫描会读的路径（绝对路径；显示时用 ImportDetectResult.home 缩成 ~） */
  paths: string[];
  /** 主数据文件在不在（stat 成功即 true）。false 的来源不可勾 */
  found: boolean;
}

/** `import:detect` 的返回。home 随行：页面把路径里的家目录缩成 ~，渲染层自己拿不到它。 */
export interface ImportDetectResult {
  home: string;
  sources: ImportSourceProbe[];
}

/** 扫描请求：只扫勾选的来源。空数组 = 什么都不读，返回空报告。 */
export interface ImportScanInput {
  sources: ImportSourceId[];
}

/**
 * 一组会话的去向，按源侧文件夹整组改（2026-09-24 裁决：每组一个去向菜单）。
 * 子会话永远跟着母会话走，不单独设去向。
 */
export type ImportDestination =
  | { kind: "tasks" }
  | { kind: "workspace"; workspaceId: string }
  /** 按文件夹新建工作区。文件夹为 null、或文件夹已经是某个工作区时没有这个选项 */
  | { kind: "new-workspace" };

export interface ImportDestinationChoice {
  /** 组键：ImportPlanItem.folder（null = 没有文件夹的那一组） */
  folder: string | null;
  destination: ImportDestination;
}

/**
 * 执行请求。**仍然不接收计划**：主进程按同样的来源重扫，再用这里的选择过滤——
 * 选择是用户意图（勾了哪些、改了哪组的去向），计划是数据，数据以执行时的盘为准。
 * 选中但重扫时已不在计划里的条目（比如刚被别处导入）静默不导。
 */
export interface ImportRunInput {
  sources: ImportSourceId[];
  /**
   * 勾选的会话，按 sourceFile（幂等键）列。只列**可选条目**：根会话，以及母会话不在
   * 本次计划里的子会话（母会话此前已导入）。母会话在计划里的子会话跟着母会话走
   */
  sessions: string[];
  /** 改过去向的组；没列的组走扫描给的默认去向 */
  destinations: ImportDestinationChoice[];
}

/** 一条会话为什么进不了导入计划。词汇进报告，UI 按它给文案。 */
export type ImportSkipReason =
  /** 索引条目没有可识别的会话源（旧扁平格式 / draft——PR-3 或放弃） */
  | "no-pi-session"
  /** 幂等命中：这条源文件已经导入过（按 meta.importedFrom 判重） */
  | "already-imported"
  /** 源文件指向的文件不在盘上 */
  | "missing-file"
  /** 打不开/读不懂：header 缺失、version 超前、文件本身坏 */
  | "bad-session-file"
  /** agent-sessions.json 里这条索引本身坏了（缺 id / 路径不是字符串等） */
  | "bad-index-entry"
  /** 能读但转不出可续聊内容：claude legacy 文件里没有 assistant 消息
   *  （纯旧扁平 / 空 draft——pi 只在有 assistant 消息时才落盘文件） */
  | "unsupported-format";

export interface ImportSkipItem {
  /** Proma 索引里的会话 id；坏到连 id 都没有时用文件内序号顶上（报告要对得上数） */
  sourceId: string;
  /** 会话标题（报告里给人看是哪条；坏条目可能没有） */
  title: string | null;
  reason: ImportSkipReason;
  /** 补充细节（如失效文件路径、版本号）——UI 的次要行，可缺席 */
  detail?: string;
}

/**
 * 扫描期就铸好的工作区计划。**id 提前铸**是为了让 ImportPlanItem.workspaceId 在
 * 扫描与执行两个阶段都是真 id（执行时按 id 落盘），不用「占位符→真值」两套语义。
 */
export interface ImportWorkspacePlan {
  /** 执行时新建的工作区 id；merged=true 时是既有工作区的 id */
  id: string;
  name: string;
  path: string;
  /** true = 挂到既有工作区（同址合并），执行时不动工作区表 */
  merged: boolean;
}

/** 源的形态：决定执行侧走哪条灌入通路。 */
export type ImportSourceKind =
  /** Proma 的 pi 真源（sdk-config/sessions/）：同构复制 + 派生 */
  | "pi"
  /** Claude Code 时代渲染 JSONL（agent-sessions/<id>.jsonl）：转换构造 pi 文件 */
  | "claude-legacy";

/**
 * 一条计划条目相对 orbita 的状态（再次导入，wafo 2026-09-24 23:55 裁决）。
 *
 * 「导过没有、后来谁动过」不另存快照：orbita 的 pi 副本就是导入那一刻的源文件，
 * 两份按 entry id 对齐，公共部分之后源里多出来的是 Proma 的新消息、副本里多出来的是在
 * orbita 接着聊的。只有「导过、后来在 orbita 删了」要靠导入清单（imports.jsonl）才认得出。
 *
 * 导入之后 Proma 侧的标题、归档、星标变化一律不跟（迁移的边界是聊天记录，
 * 会话进了 orbita 由 orbita 自己管生命周期）。
 */
export type ImportChange =
  /** 从没导过 */
  | "new"
  /** 导过；Proma 里有新消息，orbita 这边没接着聊 → 新消息追加进同一条 orbita 会话（默认勾） */
  | "updated"
  /** 导过；两边都接着聊了 → 合不了，勾上就把 Proma 那一份另导成一条新会话（默认不勾） */
  | "diverged"
  /** 导过、后来在 orbita 里删了 → 勾上就重新导入（默认不勾） */
  | "deleted";

/** 一条待导入会话（扫描产出，执行按它落盘）。 */
export interface ImportPlanItem {
  change: ImportChange;
  /** updated / diverged：导入之后 Proma 里新增的 user + assistant 消息数；其余为 0 */
  newMessages: number;
  /** Proma 索引里的会话 id */
  sourceId: string;
  /** 来自哪个来源（页面按它给组内的来源分项计数） */
  source: ImportSourceId;
  sourceKind: ImportSourceKind;
  /**
   * 源侧的文件夹，也是页面的分组键与去向的覆盖键。Proma = 所属工作区的
   * projectRootPath；没有（默认工作区 / 无归属 / 工作区已删）= null。母会话在计划里的
   * 子会话取母会话的。以后的来源按各自的 cwd 填，同一文件夹的不同来源并成一组
   */
  folder: string | null;
  /** 源文件绝对路径（pi 真源或 claude 渲染 JSONL）——同时是幂等键（meta.importedFrom 存它） */
  sourceFile: string;
  title: string;
  /** 适配后的目标工作区 id；null = TASKS（无归属 / 已删 / 收容区） */
  workspaceId: string | null;
  /** 本条落进去的 cwd（三规则的产物） */
  cwd: string;
  /** 模型映射的结果（miss 时是默认兜底） */
  providerId: string;
  modelId: string;
  /** 源应用记录的原始模型 id。渠道名不可信，只有 id 值得留 */
  importedModel: string | null;
  /**
   * 这条落盘时的 orbita 会话 id；updated = 被追加的那条既有会话的 id。**扫描期就铸好**（同 ImportWorkspacePlan.id 的理由）：
   * 子会话的 parentId 要指向母会话的 orbita id，母会话可能就在同一份计划里——
   * 执行时才铸就得在执行期维护一张映射表，扫描报告也说不出「谁挂在谁下」。
   */
  sessionId: string;
  /**
   * 母会话的 orbita id；null = 根会话。源里有父但父不可导（无 pi 文件 / 坏文件 /
   * 索引里已不存在）时也是 null——按根会话导，数据不丢，计入 orphanedSubSessions。
   */
  parentId: string | null;
  /** false = 没有匹配到已注册模型，用了默认兜底 */
  modelMatched: boolean;
  /** Proma 侧的归档态照搬——归档过的会话导进来还是归档的 */
  archived: boolean;
  /** Proma 的置顶（`pinned`）→ orbita 的置顶 */
  pinned: boolean;
  /**
   * Proma 的星标（`starred`）→ orbita 的星标。两个是独立字段：Proma 07-21 加的星标
   * 「仅用于侧栏快速识别，不影响排序或置顶」，不能当置顶导（2026-09-24 全量导入时发现）
   */
  starred: boolean;
  createdAt: number;
  updatedAt: number;
  /** 源 pi 文件字节数（体量估算的原料） */
  bytes: number;
}

/** 扫描报告（dry-run 的全部产出）。 */
export interface ImportScanReport {
  plan: ImportPlanItem[];
  /** 要新建的工作区（merged=false 的那些）；merged=true 的不进这里 */
  newWorkspaces: ImportWorkspacePlan[];
  /** 同址合并挂上的既有工作区 id（去重；UI 显示数量用 length） */
  mergedWorkspaceIds: string[];
  skipped: ImportSkipItem[];
  /** 没有可识别会话源的索引条数（旧扁平 / draft——PR-3 或放弃的范围）。
   * 不进 skipped 清单：它们不是失效，是另一条路的正常分母 */
  withoutPiSession: number;
  /** plan 里全部源文件的字节总和 */
  totalBytes: number;
  /** 模型映射 miss（用默认兜底）的条数 */
  modelFallbackCount: number;
  /** plan 里 parentId 非 null 的条数：导进来后折叠在母会话下、不进左栏的那些 */
  subSessionCount: number;
  /** 源里有父但父不可导、只好按根会话导的条数（不应该发生，发生了要让人看见） */
  orphanedSubSessions: number;
  /** 导入清单里最近一次导入的时刻；从没导过（或只有清单出现之前的补记）为 null */
  lastImportAt: number | null;
}

/** 执行阶段一条会话的结果。 */
export interface ImportRunItemResult {
  sourceId: string;
  /** 成功时是落盘的 orbita 会话 id；失败为 null */
  sessionId: string | null;
  /** 失败原因（ok=false 时必有） */
  error?: string;
}

/** 执行报告。skipped 是执行时重扫得到的（与扫描报告可能差在 already-imported）。 */
export interface ImportRunReport {
  /** 新落盘的会话：new、deleted 的重新导入、diverged 的另导一份 */
  imported: number;
  /** 追加了新消息的既有会话（updated） */
  updated: number;
  skipped: number;
  /** 只有失败的条目进这里（成功的计数就够了，明细是给排障的） */
  failed: ImportRunItemResult[];
  createdWorkspaces: { id: string; name: string; path: string }[];
  /** 合并挂上的既有工作区 id（去重） */
  mergedWorkspaceIds: string[];
}

// ---------------------------------------------------------------------------
// 选择的单位
// ---------------------------------------------------------------------------

/**
 * 计划里**用户能勾的条目**：根会话，以及母会话不在本次计划里的子会话（母会话此前已
 * 导入——它没法跟着谁走，只能自己被勾）。母会话在计划里的子会话不可单独勾，跟着母会话。
 *
 * 主进程按它过滤执行（ImportRunInput.sessions 只认这些），页面按它列行——两边必须是
 * 同一条规则，所以放在契约层。
 */
export function isSelectablePlanItem(item: ImportPlanItem, planSessionIds: ReadonlySet<string>): boolean {
  return item.parentId === null || !planSessionIds.has(item.parentId);
}

// ---------------------------------------------------------------------------
// IPC 边界的入参校验
// ---------------------------------------------------------------------------

const SOURCE_IDS: readonly string[] = ["proma"] satisfies readonly ImportSourceId[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSources(raw: unknown): ImportSourceId[] {
  if (!Array.isArray(raw)) throw new Error("sources must be an array");
  const out: ImportSourceId[] = [];
  for (const id of raw) {
    // 不认识的来源整体拒绝：静默丢掉会让「勾了但没扫」看起来像「扫了但是空的」
    if (typeof id !== "string" || !SOURCE_IDS.includes(id)) throw new Error(`unknown import source: ${String(id)}`);
    if (!out.includes(id as ImportSourceId)) out.push(id as ImportSourceId);
  }
  return out;
}

function parseDestination(raw: unknown): ImportDestination {
  if (!isRecord(raw)) throw new Error("destination must be an object");
  if (raw["kind"] === "tasks") return { kind: "tasks" };
  if (raw["kind"] === "new-workspace") return { kind: "new-workspace" };
  if (raw["kind"] === "workspace" && typeof raw["workspaceId"] === "string" && raw["workspaceId"] !== "") {
    return { kind: "workspace", workspaceId: raw["workspaceId"] };
  }
  throw new Error("bad destination");
}

/**
 * renderer 传来的是 unknown。**坏形状整体拒绝（抛错）**，不挑能用的部分凑合——
 * 这是一次会落盘的操作，改写用户意图比报错更糟。
 */
export function parseImportScanInput(raw: unknown): ImportScanInput {
  if (!isRecord(raw)) throw new Error("scan input must be an object");
  return { sources: parseSources(raw["sources"]) };
}

export function parseImportRunInput(raw: unknown): ImportRunInput {
  if (!isRecord(raw)) throw new Error("run input must be an object");
  const sessions = raw["sessions"];
  if (!Array.isArray(sessions) || !sessions.every((file) => typeof file === "string")) {
    throw new Error("sessions must be an array of source files");
  }
  const destinations = raw["destinations"];
  if (!Array.isArray(destinations)) throw new Error("destinations must be an array");
  return {
    sources: parseSources(raw["sources"]),
    sessions: [...new Set(sessions as string[])],
    destinations: destinations.map((choice) => {
      if (!isRecord(choice)) throw new Error("destination choice must be an object");
      const folder = choice["folder"];
      if (folder !== null && (typeof folder !== "string" || folder === "")) throw new Error("bad folder");
      return { folder, destination: parseDestination(choice["destination"]) };
    }),
  };
}
