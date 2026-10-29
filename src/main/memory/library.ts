/**
 * 记忆库的读面装配 —— **纯模块**：不 import electron，可被 `node --test` 直接测
 * （requests.ts 的同一条纪律）。数据在 `<userData>/memory/` 的 JSONL 里，读直接用
 * 服务进程的那套纯存储模块（单一真相：文件格式只有一份解析）；会话标题、工作区
 * 名字这些「只有主进程知道」的连接属性经 deps 注入。
 *
 * 写不走这里——写操作经记忆服务进程（唯一写者，见 service-core 的 mutate）；
 * 读不会跟写打架：追加是单次 appendFile（半截行按坏行跳过），整层重写走临时文件
 * + rename（读者看到旧的或新的完整文件）。
 *
 * 四个读法对应四条 IPC（scopes / entries / session / pending），形状在
 * shared/memory.ts。
 */
import { MemoryEntryStore } from "../../memory/entries.ts";
import { EpisodeStore } from "../../memory/episodes.ts";
import {
  MEMORY_USER_TOKEN,
  type MemoryEntriesRequest,
  type MemoryEntry,
  type MemoryEntryView,
  type MemoryEpisode,
  type MemoryEvolutionNode,
  type MemoryPendingItem,
  type MemoryScopeSummary,
  type MemorySessionView,
  type MemorySessionTurnView,
  type MemoryUsedHit,
} from "../../shared/memory.ts";

/** 原话片段的截断上限（几百字即可，见契约注释）。 */
const QUOTE_CHARS = 300;

export interface MemoryLibraryDeps {
  /** 出处会话的标题；null = 会话已删 / 读不到 */
  sessionTitleOf: (sessionId: string) => Promise<string | null>;
  /** 工作区表（token = sha1(id) 对得上的归工作区，名字从这里来） */
  workspaces: () => Promise<{ id: string; name: string }[]>;
  /** 会话 meta（解析作用域 token 用） */
  readMeta: (sessionId: string) => Promise<{ workspaceId: string | null; cwd: string } | null>;
}

/** 一个条目层（token + 条目）。 */
interface Layer {
  token: string;
  entries: MemoryEntry[];
}

export class MemoryLibrary {
  private readonly entries: MemoryEntryStore;
  private readonly episodes: EpisodeStore;
  private readonly deps: MemoryLibraryDeps;

  constructor(dir: string, deps: MemoryLibraryDeps) {
    this.entries = new MemoryEntryStore(dir);
    this.episodes = new EpisodeStore(dir);
    this.deps = deps;
  }

  /**
   * 作用域清单：user 层恒在（空也算一行——左栏的「所有工作区」是常驻导航）；
   * 其余层按 token 对工作区表，对得上的归工作区（带名字），对不上是 Home
   * （多个 Home 带短 token 后缀区分，#228 的口径）。工作区按名字排，Home 殿后。
   */
  async scopes(): Promise<MemoryScopeSummary[]> {
    const [layers, workspaces] = await Promise.all([
      this.entries.listLayers(),
      this.deps.workspaces(),
    ]);
    const byToken = new Map(
      workspaces.map((workspace) => [this.entries.tokenOf(workspace.id), workspace.name]),
    );
    const userCount = layers.find((layer) => layer.token === MEMORY_USER_TOKEN)?.count ?? 0;
    const rows: MemoryScopeSummary[] = [
      { token: MEMORY_USER_TOKEN, kind: "user", name: "所有工作区", count: userCount },
    ];
    const workspaceRows: MemoryScopeSummary[] = [];
    const homeRows: MemoryScopeSummary[] = [];
    for (const layer of layers) {
      if (layer.token === MEMORY_USER_TOKEN) continue;
      const name = byToken.get(layer.token);
      if (name !== undefined) {
        workspaceRows.push({ token: layer.token, kind: "workspace", name, count: layer.count });
      } else {
        homeRows.push({ token: layer.token, kind: "home", name: "Home", count: layer.count });
      }
    }
    workspaceRows.sort((a, b) => a.name.localeCompare(b.name));
    if (homeRows.length > 1) {
      for (const row of homeRows) row.name = `Home ${row.token.slice(0, 6)}`;
    }
    return [...rows, ...workspaceRows, ...homeRows];
  }

  /**
   * 条目列表：按作用域（"all" = 全部层）+ 类型筛，新在前。每条装配出处会话标题、
   * 原话片段（段快照取最新支撑轮的用户原文头部）与偏好演变链。
   */
  async listEntries(request: MemoryEntriesRequest): Promise<MemoryEntryView[]> {
    const layers = await this.readLayers();
    const pool = layers.flatMap((layer) =>
      layer.entries.map((entry) => ({ entry, token: layer.token })),
    );
    const filtered = pool.filter(
      ({ entry, token }) =>
        (request.token === "all" || token === request.token) &&
        (request.type === undefined || entry.type === request.type),
    );
    const [episodes, titles] = await Promise.all([this.readEpisodes(), this.resolveTitles(pool)]);
    const byId = new Map(pool.map((item) => [item.entry.id, item.entry]));
    const newerOf = buildReverseIndex(pool.map((item) => item.entry));
    return filtered
      .sort((a, b) => b.entry.at - a.entry.at)
      .map(({ entry, token }) => ({
        entry,
        token,
        sessionTitle: entry.sessionId === "" ? null : (titles.get(entry.sessionId) ?? null),
        quote: quoteOf(entry, episodes),
        evolution: evolutionOf(entry, byId, newerOf),
      }));
  }

  /**
   * 某会话的按轮视图：轮集合 = 注入账本 ∪ 本会话新增条目的轮，新在前。
   * 「用到」带注入时刻的正文快照（旧行没有快照时回当前正文，再没有给空串）；
   * organizing = 有未收尾 / 提取中的事件段。
   */
  async sessionView(sessionId: string): Promise<MemorySessionView> {
    const meta = await this.deps.readMeta(sessionId).catch(() => null);
    const token =
      meta === null
        ? null
        : meta.workspaceId !== null
          ? this.entries.tokenOf(meta.workspaceId)
          : this.entries.tokenOf(meta.cwd);
    const [records, layers, pending, open] = await Promise.all([
      this.entries.listInjections(),
      this.readLayers(),
      this.pending(),
      this.episodes.listAll(),
    ]);
    const pool = layers.flatMap((layer) => layer.entries);
    const mine = pool.filter((entry) => entry.sessionId === sessionId);
    const injectedOfTurn = new Map(
      records.filter((record) => record.sessionId === sessionId).map((record) => [record.turn, record]),
    );
    const rememberedOfTurn = new Map<number, MemoryEntry[]>();
    for (const entry of mine) {
      for (const turn of entry.turns) {
        const bucket = rememberedOfTurn.get(turn) ?? [];
        bucket.push(entry);
        rememberedOfTurn.set(turn, bucket);
      }
    }
    const turns: MemorySessionTurnView[] = [...new Set([...injectedOfTurn.keys(), ...rememberedOfTurn.keys()])]
      .sort((a, b) => b - a)
      .map((turn) => {
        const record = injectedOfTurn.get(turn);
        const used: MemoryUsedHit[] = (record?.hits ?? []).map((hit) => ({
          id: hit.id,
          text: hit.text ?? pool.find((entry) => entry.id === hit.id)?.text ?? "",
          score: hit.score,
          ...(hit.pinned ? { pinned: true } : null),
        }));
        return {
          turn,
          at: record?.at ?? fallbackAt(rememberedOfTurn.get(turn) ?? []),
          used,
          remembered: rememberedOfTurn.get(turn) ?? [],
        };
      });
    const organizing =
      open.open.some((episode) => episode.sessionId === sessionId) ||
      open.pending.some((episode) => episode.sessionId === sessionId);
    const pendingCount = pending.filter(
      (item) =>
        item.resolution === undefined &&
        (token === null || item.token === token || item.token === MEMORY_USER_TOKEN),
    ).length;
    return { sessionId, token, turns, organizing, pendingCount };
  }

  /**
   * 待确认清单：pendingPromote 与 conflictWith 的条目，**已拍板的也返**（done 卡与
   * 撤销键的来处）。冲突的 ask 要求旧条目还在且是 active——旧条已删 / 已 muted 的
   * 没什么可拍板。新在前。
   */
  async pending(): Promise<MemoryPendingItem[]> {
    const layers = await this.readLayers();
    const pool = layers.flatMap((layer) => layer.entries.map((entry) => ({ entry, token: layer.token })));
    const byId = new Map(pool.map((item) => [item.entry.id, item.entry]));
    const items: MemoryPendingItem[] = [];
    for (const { entry, token } of pool) {
      if (entry.pendingPromote === true || entry.promoteResolution !== undefined) {
        items.push({
          kind: "promote",
          entry,
          token,
          old: null,
          ...(entry.promoteResolution !== undefined ? { resolution: entry.promoteResolution } : null),
        });
      }
      if (entry.conflictWith !== undefined) {
        const old = byId.get(entry.conflictWith) ?? null;
        const decided = entry.conflictResolution !== undefined;
        const askable = !decided && old !== null && (old.status ?? "active") === "active";
        if (decided || askable) {
          items.push({
            kind: "conflict",
            entry,
            token,
            old,
            ...(decided ? { resolution: entry.conflictResolution } : null),
          });
        }
      }
    }
    return items.sort((a, b) => b.entry.at - a.entry.at);
  }

  /* ---------- 内部 ---------- */

  private async readLayers(): Promise<Layer[]> {
    const layers = await this.entries.listLayers();
    return Promise.all(
      layers.map(async (layer) => ({ token: layer.token, entries: await this.entries.listByToken(layer.token) })),
    );
  }

  /** 事件段快照索引（归档 + 待提取——开段还没有条目引用它，读了也无用）。 */
  private async readEpisodes(): Promise<Map<string, MemoryEpisode>> {
    const [archived, all] = await Promise.all([this.episodes.listArchived(), this.episodes.listAll()]);
    const index = new Map<string, MemoryEpisode>();
    for (const episode of [...archived, ...all.pending]) index.set(episode.episodeId, episode);
    return index;
  }

  /** 批量解会话标题（同会话只读一次；manual 的空 sessionId 不查）。 */
  private async resolveTitles(
    pool: readonly { entry: MemoryEntry }[],
  ): Promise<Map<string, string | null>> {
    const titles = new Map<string, string | null>();
    for (const { entry } of pool) {
      if (entry.sessionId === "" || titles.has(entry.sessionId)) continue;
      titles.set(entry.sessionId, await this.deps.sessionTitleOf(entry.sessionId).catch(() => null));
    }
    return titles;
  }
}

/** 原话片段：段快照里最新支撑轮的用户原文头部。段不在（manual / 已清理）为 null。 */
function quoteOf(entry: MemoryEntry, episodes: ReadonlyMap<string, MemoryEpisode>): string | null {
  if (entry.episodeId === "") return null;
  const episode = episodes.get(entry.episodeId);
  if (episode === undefined) return null;
  const supporting = episode.turns.filter((turn) => entry.turns.includes(turn.turn));
  if (supporting.length === 0) return null;
  const latest = supporting.reduce((acc, turn) => (turn.turn > acc.turn ? turn : acc));
  return latest.userText.slice(0, QUOTE_CHARS);
}

/** 冲突链的反向索引：旧 id → 指它的新条目们。 */
function buildReverseIndex(entries: readonly MemoryEntry[]): Map<string, MemoryEntry[]> {
  const index = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (entry.conflictWith === undefined) continue;
    const bucket = index.get(entry.conflictWith) ?? [];
    bucket.push(entry);
    index.set(entry.conflictWith, bucket);
  }
  return index;
}

/**
 * 偏好演变链：沿 conflictWith 串起来的新旧条目，按时间旧 → 新，含自身。
 * 没有冲突关联（自己不指人、也没人指自己）返回空数组。分叉（两条新记忆同时指
 * 一条旧记忆）时前向走**最旧**的新者——链在实践中是线性的，分叉取一条路。
 */
function evolutionOf(
  entry: MemoryEntry,
  byId: ReadonlyMap<string, MemoryEntry>,
  newerOf: ReadonlyMap<string, MemoryEntry[]>,
): MemoryEvolutionNode[] {
  const linked = entry.conflictWith !== undefined || (newerOf.get(entry.id)?.length ?? 0) > 0;
  if (!linked) return [];
  // 找链头：沿 conflictWith 往旧走
  let head = entry;
  const seen = new Set<string>([entry.id]);
  while (head.conflictWith !== undefined) {
    const older = byId.get(head.conflictWith);
    if (older === undefined || seen.has(older.id)) break;
    seen.add(older.id);
    head = older;
  }
  // 从链头向新走（分叉取最旧的新者），产出节点
  const chain: MemoryEvolutionNode[] = [];
  let node: MemoryEntry | undefined = head;
  const visited = new Set<string>();
  while (node !== undefined && !visited.has(node.id)) {
    visited.add(node.id);
    chain.push({
      id: node.id,
      text: node.text,
      at: node.at,
      ...(node.status !== undefined ? { status: node.status } : null),
    });
    const newers: MemoryEntry[] = (newerOf.get(node.id) ?? []).filter(
      (candidate) => !visited.has(candidate.id),
    );
    if (newers.length === 0) break;
    node = newers.reduce((acc: MemoryEntry, candidate: MemoryEntry) =>
      candidate.at < acc.at ? candidate : acc,
    );
  }
  return chain;
}

/** 轮没有注入记录时（只记住了东西的轮），at 取该轮条目的最新时间。 */
function fallbackAt(entries: readonly MemoryEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.at), 0);
}
