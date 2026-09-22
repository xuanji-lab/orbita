/**
 * Proma pi 会话导入的契约 —— IPC 四层的第 1 层（与引擎同 PR 落地，消费者纪律）。
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

/** 一条待导入会话（扫描产出，执行按它落盘）。 */
export interface ImportPlanItem {
  /** Proma 索引里的会话 id */
  sourceId: string;
  sourceKind: ImportSourceKind;
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
   * 这条落盘时的 orbita 会话 id。**扫描期就铸好**（同 ImportWorkspacePlan.id 的理由）：
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
  pinned: boolean;
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
  imported: number;
  skipped: number;
  /** 只有失败的条目进这里（成功的计数就够了，明细是给排障的） */
  failed: ImportRunItemResult[];
  createdWorkspaces: { id: string; name: string; path: string }[];
  /** 合并挂上的既有工作区 id（去重） */
  mergedWorkspaceIds: string[];
}
