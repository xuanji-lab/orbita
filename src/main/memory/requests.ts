/**
 * agent 侧记忆请求（memoryRetrieveRequest / memoryAppend）在主进程的落点——
 * **与 readTaskRequest 同一条边界**：agent 进程不碰 userData，作用域（workspaceId
 * ?? cwd）由主进程按会话归属解析，读写在主进程。纯核在 store / retrieve，
 * 这里只剩「解析作用域 → 调 store」一跳。
 *
 * 另一半是**设置 › 记忆库的管理面**（memory:scopes / memory:entries / …）：用户本人
 * 翻自己的记忆库，作用域按 token 寻址（MemoryScopeToken，scopeId 单向哈希后的
 * 文件名——见 store.ts 头注释）。那条路子的入参校验也住这里——ipc.ts import
 * electron，判断放那里就没法被 `node --test` 直接测（files/list.ts 的同款先例）。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  MEMORY_GLOBAL_SCOPE,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryExcerptItem,
  type MemoryHit,
  type MemoryInjectionRecord,
  type MemoryLibraryItem,
  type MemoryRetrieveOutcome,
  type MemoryScopeInfo,
  type MemorySessionTurnsResponse,
  type MemoryTurnAdded,
  type MemoryTurnInjected,
  type MemoryTurnSummary,
} from "../../shared/memory.ts";
import { pickPinned, retrieveMemories } from "./retrieve.ts";
import { memoryScopeOf, type MemoryStore } from "./store.ts";
import type { MemoryUsageStore } from "./usage.ts";

type AgentEventOf<T extends string> = Extract<AgentEvent, { type: T }>;

/**
 * 会话归属的最小只读视图（read-task.ts 的 SessionStoreReader 同一条纪律：
 * 收窄到只用得到的字段）。SessionStore 结构化满足本接口，测试给 stub。
 */
export interface SessionScopeReader {
  readMeta(id: string): Promise<{ workspaceId: string | null; cwd: string; title?: string } | null>;
}

/**
 * 这条会话的记忆作用域；null = 会话的 meta 读不到（新会话首轮可能还没落 meta、
 * 或会话已被删）。
 *
 * **读不到不是错误**：新会话第一轮的召回就落在这里——那一刻盘上本来就没有它的
 * 记忆，答「没有可注入的」与答「出错了」对调用方是同一结果（都不注入），
 * 但前者不会在每条新会话的首轮刷一条错误日志。
 */
async function scopeOfSession(sessions: SessionScopeReader, sessionId: string): Promise<string | null> {
  const meta = await sessions.readMeta(sessionId);
  if (meta === null) {
    console.warn("[memory] 读不到会话 meta，这一轮没有可注入/可追加的记忆", sessionId);
    return null;
  }
  return memoryScopeOf(meta);
}

/** 条目按 id 去重：移到全局半路被杀会短暂同存两份（store.move 的头注释），召回合并时兜住。 */
function dedupeById(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const unique: MemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

/** 条目要不要参与召回：只有 active（superseded 被替代、muted 不再注入）。 */
export function isRecallable(entry: MemoryEntry): boolean {
  return (entry.status ?? "active") === "active";
}

/**
 * memoryRetrieveRequest：读该作用域 + 全局的记忆 → 常驻直通 + 词法打分 → 回
 * memoryRetrieveResult，并把这一轮注入了什么落进注入账本（每轮一条，含零命中——
 * 审查面板按轮汇总是从这份账来的）。
 *
 * 任何路径都回执（同 readTaskRequest）：不回答的话 agent 进程里的那次调用永远挂着，
 * 而轮前路径是同步等的，整轮开不了工。账本写失败只记日志——账本是推导材料，
 * 坏一条不该拦召回。
 */
export async function applyMemoryRetrieve(
  sessions: SessionScopeReader,
  memory: MemoryStore,
  usage: MemoryUsageStore,
  event: AgentEventOf<"memoryRetrieveRequest">,
): Promise<MemoryRetrieveOutcome> {
  // 开轮命令自带的 scope 优先（首轮 meta 还没落盘，meta 解析是必输的竞态）；
  // 缺席才退回 meta（旧调用方兼容）。
  const scope =
    event.scope !== undefined ? memoryScopeOf(event.scope) : await scopeOfSession(sessions, event.sessionId);
  const globalToken = memory.tokenOf(MEMORY_GLOBAL_SCOPE);
  let hits: MemoryHit[] = [];
  if (scope !== null) {
    const token = memory.tokenOf(scope);
    const [own, globalEntries] = await Promise.all([memory.list(token), memory.list(globalToken)]);
    const active = dedupeById([...own, ...globalEntries]).filter(isRecallable);
    const pinned = pickPinned(
      active.filter((entry) => entry.pinned === true),
      { usage: await usage.usageOf() },
    );
    const pinnedIds = new Set(pinned.map((entry) => entry.id));
    const lexical = retrieveMemories(
      active.filter((entry) => entry.pinned !== true),
      event.query,
    );
    hits = [
      ...pinned.map((entry): MemoryHit => ({ entry, score: 1, pinned: true })),
      ...lexical.filter((hit) => !pinnedIds.has(hit.entry.id)),
    ];
  }
  const record: MemoryInjectionRecord = {
    sessionId: event.sessionId,
    turn: event.turn,
    at: Date.now(),
    hits: hits.map((hit) => ({ id: hit.entry.id, score: hit.score })),
  };
  await usage.record(record).catch((cause: unknown) => {
    console.error("[memory] 注入记录没落账（审查面板会缺这一轮）", event.sessionId, event.turn, cause);
  });
  return { ok: true, hits };
}

/**
 * memoryAppend：轮后蒸馏出的 draft 落进该会话作用域的 JSONL。**单向、无回执**
 * （契约同 title 事件）——调用方（index.ts 的接线）只负责把失败记进日志：
 * 记忆是易耗品，不该有报错通路打断对话。
 *
 * draft 里的冲突建议（supersedes）先验再落：目标条目得真实存在且还没被替代，
 * 模型引错 id（幻觉）/ 已删的条目不落标——建议指向空气比没有建议更误导。
 */
export async function applyMemoryAppend(
  sessions: SessionScopeReader,
  memory: MemoryStore,
  event: AgentEventOf<"memoryAppend">,
): Promise<void> {
  const scope = await scopeOfSession(sessions, event.sessionId);
  if (scope === null) return;
  const token = memory.tokenOf(scope);
  const pool = dedupeById([
    ...(await memory.list(token)),
    ...(await memory.list(memory.tokenOf(MEMORY_GLOBAL_SCOPE))),
  ]);
  const drafts: MemoryDraft[] = event.entries.map((draft) => {
    if (draft.supersedes === undefined) return draft;
    const target = pool.find((entry) => entry.id === draft.supersedes);
    if (target === undefined || !isRecallable(target)) {
      const { supersedes: _drop, ...rest } = draft;
      return rest;
    }
    return draft;
  });
  await memory.append(token, event.sessionId, event.turn, drafts);
}

/* ---------- 设置 › 记忆库（memory:*）的装配与入参校验 ---------- */

/**
 * 作用域清单：盘上有条目的作用域文件 × 工作区表 = 三类。工作区的 token 是
 * sha1(workspaceId)（memoryScopeOf 的口径），对得上的归工作区；全局 token 固定；
 * 其余都是 Home（workspaceId 为 null 的会话按 cwd 落的盘）。多个 Home 作用域
 * 并列成多行（名字带短 token 后缀区分——cwd 哈希单向，拿不回原名）。
 *
 * 工作区只读 {id, name}——名字是显示用的，管理面不改工作区。
 */
export interface WorkspaceReader {
  list(): Promise<{ id: string; name: string }[]>;
}

export async function listScopes(memory: MemoryStore, workspaces: WorkspaceReader): Promise<MemoryScopeInfo[]> {
  const globalToken = memory.tokenOf(MEMORY_GLOBAL_SCOPE);
  const known = await workspaces.list();
  const byToken = new Map(known.map((workspace) => [memory.tokenOf(workspace.id), workspace.name]));
  const scopes: MemoryScopeInfo[] = [];
  let homeCount = 0;
  const found = await memory.scopes();
  for (const { token, count } of found) {
    if (token === globalToken) {
      scopes.push({ token, kind: "global", name: "global", count });
      continue;
    }
    const workspaceName = byToken.get(token);
    if (workspaceName !== undefined) {
      scopes.push({ token, kind: "workspace", name: workspaceName, count });
      continue;
    }
    homeCount += 1;
    scopes.push({ token, kind: "home", name: "Home", count });
  }
  if (homeCount > 1) {
    for (const scope of scopes) {
      if (scope.kind === "home") scope.name = `Home ${scope.token.slice(0, 6)}`;
    }
  }
  return scopes;
}

/**
 * 记忆库一页：条目 + 使用统计 + 出处会话标题。标题逐会话读一次 meta
 * （同会话的多条只读一次）；meta 读不到 = null（会话已删），照常列条目。
 */
export async function listLibraryItems(
  memory: MemoryStore,
  usage: MemoryUsageStore,
  sessions: SessionScopeReader,
  token: string,
): Promise<MemoryLibraryItem[]> {
  const [entries, usageMap] = await Promise.all([memory.list(token), usage.usageOf()]);
  const titles = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.sessionId === "" || titles.has(entry.sessionId)) continue;
    titles.set(entry.sessionId, (await sessions.readMeta(entry.sessionId))?.title ?? null);
  }
  return entries.map((entry) => ({
    entry,
    usage: usageMap.get(entry.id) ?? { count: 0, lastAt: null },
    sessionTitle: entry.sessionId === "" ? null : (titles.get(entry.sessionId) ?? null),
  }));
}

/**
 * 审查面板 › 记忆页签的数据：这个会话每一轮注入了什么、蒸出了什么。
 * 轮的集合 = 注入账本（每轮一条）∪ 本会话新增条目的轮；轮内新增按落盘顺序、
 * 轮间倒序（最近那轮在最上）。待处理冲突数扫整个作用域（含全局）——页签徽标
 * 的口径是「这个工作区还有几件事等你拍板」，不只这条会话。
 */
export async function sessionTurns(
  sessions: SessionScopeReader,
  memory: MemoryStore,
  usage: MemoryUsageStore,
  sessionId: string,
): Promise<MemorySessionTurnsResponse> {
  const meta = await sessions.readMeta(sessionId);
  if (meta === null) return { turns: [], pendingConflicts: 0, scopeToken: "" };
  const globalToken = memory.tokenOf(MEMORY_GLOBAL_SCOPE);
  const token = memory.tokenOf(memoryScopeOf(meta));
  const ownEntries = await memory.list(token);
  const globalEntries = await memory.list(globalToken);
  const pool = dedupeById([...ownEntries, ...globalEntries]);
  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  // 注入条目在哪个作用域文件（自己的 / 全局的）——面板上的改动要按它寻址
  const tokenOfEntry = new Map<string, string>();
  for (const entry of ownEntries) tokenOfEntry.set(entry.id, token);
  for (const entry of globalEntries) if (!tokenOfEntry.has(entry.id)) tokenOfEntry.set(entry.id, globalToken);

  /** 待处理的冲突建议：判过、没拍板、旧条目还在库里。 */
  const pendingOldOf = (entry: MemoryEntry): MemoryEntry | null => {
    if (entry.supersedes === undefined || entry.conflictResolution !== undefined) return null;
    const old = byId.get(entry.supersedes);
    return old !== undefined && isRecallable(old) ? old : null;
  };
  const pendingConflicts = pool.filter((entry) => pendingOldOf(entry) !== null).length;

  const records = await usage.bySession(sessionId);
  const injectedOfTurn = new Map(records.map((record) => [record.turn, record]));
  const addedOfTurn = new Map<number, MemoryEntry[]>();
  for (const entry of pool) {
    if (entry.sessionId !== sessionId || entry.turn === undefined) continue;
    const bucket = addedOfTurn.get(entry.turn) ?? [];
    bucket.push(entry);
    addedOfTurn.set(entry.turn, bucket);
  }
  const turns = [...new Set([...injectedOfTurn.keys(), ...addedOfTurn.keys()])]
    .sort((a, b) => b - a)
    .map((turn): MemoryTurnSummary => {
      const record = injectedOfTurn.get(turn);
      const added = (addedOfTurn.get(turn) ?? []).map(
        (entry): MemoryTurnAdded => ({ entry, conflictWith: pendingOldOf(entry) }),
      );
      const injected: MemoryTurnInjected[] = (record?.hits ?? []).flatMap((hit) => {
        const entry = byId.get(hit.id);
        if (entry === undefined) return []; // 条目已删：账还在这轮，但没正文可展示
        return [
          {
            id: entry.id,
            text: entry.text,
            timestamp: entry.timestamp,
            score: hit.score,
            pinned: entry.pinned === true,
            token: tokenOfEntry.get(entry.id) ?? globalToken,
          },
        ];
      });
      const fallbackAt = (addedOfTurn.get(turn) ?? []).reduce(
        (latest, entry) => Math.max(latest, entry.timestamp),
        0,
      );
      return { turn, at: record?.at ?? fallbackAt, added, injected };
    });
  return { turns, pendingConflicts, scopeToken: token };
}

/* ---------- 摘抄页签（右栏）：所有作用域的 excerpt 条目 ---------- */

/**
 * 全库摘抄（右栏 › 摘抄 › 全部）：扫每个有条目的作用域，收 source = excerpt 的。
 * 不含 manual（没有出处，跳不回去，留在设置 › 记忆库管理）；新在前
 * （摘抄的典型问题是「我刚才摘的那句在哪」）。
 */
export async function listExcerpts(
  memory: MemoryStore,
  sessions: SessionScopeReader,
  currentSessionId: string,
): Promise<MemoryExcerptItem[]> {
  const titles = new Map<string, string | null>();
  const items: MemoryExcerptItem[] = [];
  for (const { token } of await memory.scopes()) {
    for (const entry of await memory.list(token)) {
      if (entry.source !== "excerpt") continue;
      if (!titles.has(entry.sessionId)) {
        titles.set(entry.sessionId, (await sessions.readMeta(entry.sessionId))?.title ?? null);
      }
      items.push({
        entry,
        token,
        sessionTitle: titles.get(entry.sessionId) ?? null,
        current: entry.sessionId === currentSessionId,
      });
    }
  }
  return items.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
}

/* ---------- 入参校验（renderer 过来的都是不可信数据） ---------- */

/** token 只认 sha1 形状（40 位 hex）：形状不对当场抛，别让它拼出奇怪的路。 */
export function parseScopeToken(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error("memory request needs a 40-hex scope token");
  }
  return raw;
}

function asRequestObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new Error("memory request must be an object");
  return raw as Record<string, unknown>;
}

function stringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`memory request needs an array ${field}`);
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error(`memory request ${field} must be strings`);
    ids.push(item);
  }
  return ids;
}

export function parseBatchTarget(raw: unknown): { token: string; entryIds: string[] } {
  const req = asRequestObject(raw);
  return { token: parseScopeToken(req.token), entryIds: stringList(req.entryIds, "entryIds") };
}

export function parsePatchRequest(raw: unknown): {
  token: string;
  entryId: string;
  text?: string;
  pinned?: boolean;
  status?: "active" | "superseded" | "muted";
  stance?: "position" | "agree" | "doubt" | "oppose";
} {
  const req = asRequestObject(raw);
  const entryId = req.entryId;
  if (typeof entryId !== "string" || entryId === "") throw new Error("memory request needs a string entryId");
  const text = req.text;
  const pinned = req.pinned;
  const status = req.status;
  const stance = req.stance;
  if (text !== undefined && typeof text !== "string") throw new Error("memory patch text must be a string");
  if (pinned !== undefined && typeof pinned !== "boolean") throw new Error("memory patch pinned must be a boolean");
  if (status !== undefined && status !== "active" && status !== "superseded" && status !== "muted") {
    throw new Error("memory patch status is invalid");
  }
  if (stance !== undefined && stance !== "position" && stance !== "agree" && stance !== "doubt" && stance !== "oppose") {
    throw new Error("memory patch stance is invalid");
  }
  return {
    token: parseScopeToken(req.token),
    entryId,
    ...(text !== undefined ? { text } : null),
    ...(pinned !== undefined ? { pinned } : null),
    ...(status !== undefined ? { status } : null),
    ...(stance !== undefined ? { stance } : null),
  };
}

export function parseResolveRequest(raw: unknown): {
  token: string;
  newId: string;
  oldId: string;
  resolution: "replace" | "keep-both" | "drop-new";
  undo: boolean;
} {
  const req = asRequestObject(raw);
  const newId = req.newId;
  const oldId = req.oldId;
  const resolution = req.resolution;
  const undo = req.undo;
  if (typeof newId !== "string" || newId === "") throw new Error("memory resolve needs a string newId");
  if (typeof oldId !== "string" || oldId === "") throw new Error("memory resolve needs a string oldId");
  if (resolution !== "replace" && resolution !== "keep-both" && resolution !== "drop-new") {
    throw new Error("memory resolve resolution is invalid");
  }
  if (undo !== undefined && typeof undo !== "boolean") throw new Error("memory resolve undo must be a boolean");
  return {
    token: parseScopeToken(req.token),
    newId,
    oldId,
    resolution,
    undo: undo === true,
  };
}

export function parseExcerptRequest(raw: unknown): {
  sessionId: string;
  verbatim: string;
  role: "user" | "assistant";
  turn: number;
  stance: "position" | "agree" | "doubt" | "oppose";
} {
  const req = asRequestObject(raw);
  const sessionId = req.sessionId;
  const verbatim = req.verbatim;
  const role = req.role;
  const turn = req.turn;
  const stance = req.stance;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("memory excerpt needs a string sessionId");
  if (typeof verbatim !== "string" || verbatim.trim() === "") throw new Error("memory excerpt needs a non-empty verbatim");
  if (role !== "user" && role !== "assistant") throw new Error("memory excerpt role is invalid");
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) {
    throw new Error("memory excerpt needs a positive integer turn");
  }
  if (stance !== "position" && stance !== "agree" && stance !== "doubt" && stance !== "oppose") {
    throw new Error("memory excerpt stance is invalid");
  }
  return { sessionId, verbatim, role, turn, stance };
}

export function parseAddManualRequest(raw: unknown): { token: string; text: string } {
  const req = asRequestObject(raw);
  const text = req.text;
  if (typeof text !== "string" || text.trim() === "") throw new Error("memory add-manual needs a non-empty text");
  return { token: parseScopeToken(req.token), text };
}
