/**
 * Proma 的会话索引（agent-sessions.json）与工作区表（agent-workspaces.json）的解析 —— 纯模块，
 * `node --test` 直接测。外部来源的只读 adapter 用它列 Proma 的会话。
 */

/** 索引里坏掉的一条：哪一条、为什么。 */
export interface PromaBadEntry {
  sourceId: string;
  title: string | null;
  detail: string;
}

/** Proma 索引（agent-sessions.json）里我们用得上的字段。字段历经五代演进，只认这些。 */
export interface PromaSessionIndexEntry {
  id: string;
  title: string;
  piSessionFile: string;
  workspaceId: string | null;
  modelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  pinned: boolean;
  starred: boolean;
  /** Proma 的 `parentSessionId`：delegation 派出的子会话指向母会话的 Proma id；null = 根会话 */
  parentSourceId: string | null;
}

/** claude legacy 索引条目（无 piSessionFile，源文件按 <promaRoot>/agent-sessions/<id>.jsonl 推导）。 */
export interface PromaClaudeIndexEntry {
  id: string;
  title: string;
  workspaceId: string | null;
  modelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  pinned: boolean;
  starred: boolean;
  parentSourceId: string | null;
}

/** Proma 工作区（agent-workspaces.json）里我们用得上的字段。 */
export interface PromaWorkspaceEntry {
  id: string;
  name: string;
  /** 缺席 = Proma 的默认收容区（杂项），不映射成 orbita 工作区 */
  projectRootPath: string | null;
}

/**
 * 解 agent-sessions.json。**逐条容错**：一条坏了进 bad，
 * 不挡其余 900 多条（与 readLog 的坏行纪律同源）。没有 piSessionFile 的条目分两路：
 * legacyTranscript.sourceRuntime === "claude" 的进 claude 条目（渲染 JSONL 转换导入），
 * 其余（旧扁平 / draft）只计数不进清单——PR-3 或明确放弃的范围。
 */
export function parsePromaSessions(raw: string): {
  entries: PromaSessionIndexEntry[];
  claudeEntries: PromaClaudeIndexEntry[];
  bad: PromaBadEntry[];
  /** 没有可识别会话源的条目 id（几个数据根合起来按 id 去重再计数） */
  withoutPiIds: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("agent-sessions.json is not valid JSON");
  }
  const list = isRecord(parsed) && Array.isArray(parsed["sessions"]) ? parsed["sessions"] : [];
  const entries: PromaSessionIndexEntry[] = [];
  const claudeEntries: PromaClaudeIndexEntry[] = [];
  const bad: PromaBadEntry[] = [];
  const withoutPiIds: string[] = [];
  list.forEach((item, index) => {
    if (!isRecord(item)) {
      bad.push({ sourceId: `#${index}`, title: null, detail: "not an object" });
      return;
    }
    const id = optionalString(item["id"]);
    if (id === null) {
      bad.push({
        sourceId: `#${index}`,
        title: optionalString(item["title"]),
        detail: "missing id",
      });
      return;
    }
    const common = {
      id,
      title: optionalString(item["title"]) ?? "",
      workspaceId: optionalString(item["workspaceId"]),
      modelId: optionalString(item["modelId"]),
      createdAt: optionalNumber(item["createdAt"]),
      updatedAt: optionalNumber(item["updatedAt"]),
      archived: item["archived"] === true,
      // 两个独立字段：pinned = 置顶；starred = 星标（Proma 07-21 加，「不影响排序或置顶」）。
      // 早先把 starred 也当置顶导，是把它误读成了 pinned 的新名字（本机 pinned=true 0 条、
      // starred=true 55 条，导进来一片置顶）
      //
      // 「不影响排序」这句只说**会话上的** starred（它纯粹是个用户标记，自己不筛任何东西）。
      // 模型上的星标是另一件事：那个会当过滤口径用（模型卡片左栏第一格），
      // 存在设置里（AppSettings.starredModels），跟这条导入路径无关。
      pinned: item["pinned"] === true,
      starred: item["starred"] === true,
      // 只认 delegation 的 parentSessionId。explorationParentSessionId（Proma 的探索分叉）
      // 是从某条消息岔出去的独立会话，不是子会话，照根会话导
      parentSourceId: optionalString(item["parentSessionId"]),
    };
    const piSessionFile = optionalString(item["piSessionFile"]);
    if (piSessionFile === null) {
      const legacy = isRecord(item["legacyTranscript"])
        ? optionalString(item["legacyTranscript"]["sourceRuntime"])
        : null;
      if (legacy === "claude") claudeEntries.push(common);
      else withoutPiIds.push(id);
      return;
    }
    entries.push({ ...common, piSessionFile });
  });
  return { entries, claudeEntries, bad, withoutPiIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 解 agent-workspaces.json。坏条目跳过（它只是映射辅助，不值得拦整批）。 */
export function parsePromaWorkspaces(raw: string): PromaWorkspaceEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("agent-workspaces.json is not valid JSON");
  }
  const list = isRecord(parsed) && Array.isArray(parsed["workspaces"]) ? parsed["workspaces"] : [];
  const out: PromaWorkspaceEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = optionalString(item["id"]);
    const name = optionalString(item["name"]);
    if (id === null || name === null) continue;
    out.push({ id, name, projectRootPath: optionalString(item["projectRootPath"]) });
  }
  return out;
}

