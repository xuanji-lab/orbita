/**
 * 已蒸轮账本（补蒸的地基）——「哪些 (sessionId, turn) 已经蒸馏过」的唯一真相。
 *
 * 为什么要它：补蒸（从历史生成）要跳过已蒸的轮、预估要算 skippedTurns，而
 * 「库里有没有这条记忆」回答不了这个问题——一轮可能蒸出 0 条（没什么可记），
 * 用户还可能手动删过蒸出来的条目。**只有一份按 (sessionId, turn) 记的账能说清
 * 「这轮处理过没有」**。实时蒸馏与补蒸写同一份账：蒸馏调用成功（含蒸出 0 条）
 * 就记一笔；调用失败不记——下次补蒸会再试它。
 *
 * 落盘：`memory/distilled-turns.json`（原子写，临时文件 + rename）。文件小
 * （每轮一个整数），整份重写不心疼。坏文件当空账：读不出导致的最坏结果是
 * 重蒸几轮（store 的逐字去重兜住重复条目），比报错拦住补蒸强。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测（store.ts 同款先例）。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";

/** 账本的文件名（`<userData>/memory/` 目录下）。 */
export const DISTILLED_TURNS_FILE = "distilled-turns.json";

/** 盘上形状。v 是版本号，将来改结构时按它分派。 */
export interface DistilledTurnsFile {
  v: 1;
  /** sessionId → 已蒸的轮号（升序去重） */
  sessions: Record<string, number[]>;
}

/**
 * 盘上 JSON → 内存索引。**宽松解读**：v 不认识 / sessions 不是对象 → 空账；
 * 单个会话的数组里有非正整数 → 丢那个会话的整段（半截账不可信，重蒸兜底），
 * 别的会话照常。
 */
export function parseDistilledTurns(raw: unknown): Map<string, Set<number>> {
  const turns = new Map<string, Set<number>>();
  if (typeof raw !== "object" || raw === null) return turns;
  const suspect = raw as { v?: unknown; sessions?: unknown };
  if (suspect.v !== 1 || typeof suspect.sessions !== "object" || suspect.sessions === null) return turns;
  for (const [sessionId, value] of Object.entries(suspect.sessions)) {
    if (!Array.isArray(value)) continue;
    let ok = true;
    const set = new Set<number>();
    for (const turn of value) {
      if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) {
        ok = false;
        break;
      }
      set.add(turn);
    }
    if (ok && set.size > 0) turns.set(sessionId, set);
  }
  return turns;
}

/** 内存索引 → 盘上形状（轮号升序去重，确定性输出）。 */
export function toDistilledTurnsFile(turns: ReadonlyMap<string, ReadonlySet<number>>): DistilledTurnsFile {
  const sessions: Record<string, number[]> = {};
  for (const [sessionId, set] of turns) {
    if (set.size === 0) continue;
    sessions[sessionId] = [...set].sort((a, b) => a - b);
  }
  return { v: 1, sessions };
}

/**
 * 已蒸轮账本。**load 一次、内存查询、逐笔原子落盘**——补蒸每蒸完一轮记一笔，
 * 实时蒸馏每轮也记一笔，都是小文件整写。
 *
 * 没做并发互斥：同一进程内补蒸与实时蒸馏同时 record，最坏丢一笔（后写覆盖前写），
 * 代价是该轮下次补蒸重蒸一次、条目被逐字去重挡住——为这个加锁不值得。
 */
export class DistilledTurnLedger {
  private readonly file: string;
  private turns = new Map<string, Set<number>>();

  constructor(file: string) {
    this.file = file;
  }

  /** 读盘。文件不存在 = 空账；坏 JSON = 空账（头注释的理由）；权限坏了照抛。 */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) {
        this.turns = new Map();
        return;
      }
      throw cause;
    }
    try {
      this.turns = parseDistilledTurns(JSON.parse(raw));
    } catch {
      console.error("[memory] 已蒸轮账本读不出来，当空账处理（已蒸过的轮可能重蒸一次）", this.file);
      this.turns = new Map();
    }
  }

  /** 这轮蒸过没有。未 load 过也安全（内存里就是空账）。 */
  has(sessionId: string, turn: number): boolean {
    return this.turns.get(sessionId)?.has(turn) ?? false;
  }

  /** 某条会话已蒸的轮号集合（只读视图；收集计划用）。 */
  turnsOf(sessionId: string): ReadonlySet<number> {
    return this.turns.get(sessionId) ?? EMPTY_SET;
  }

  /** 记一笔并落盘。幂等：已存在的轮号安静地不重复。 */
  async record(sessionId: string, turn: number): Promise<void> {
    if (!Number.isInteger(turn) || turn < 1) return;
    let set = this.turns.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.turns.set(sessionId, set);
    }
    if (set.has(turn)) return;
    set.add(turn);
    await writeJsonAtomic(this.file, toDistilledTurnsFile(this.turns));
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set();
