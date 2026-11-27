/**
 * 状态卡摘要的主进程一侧（2026-11-27，「主进程算好摘要」）：每条会话一份
 * `sessions/<id>.status.json`，内存里每条会话一份 fold 状态（shared/status-digest.ts）。
 *
 * ## 推进（与落盘同一处）
 * SessionStore.record() 每追加一条记录就调 `touch(id)`（同一条路径，见 store.ts 的
 * onRecordAppended）：touch 把「从 logOffset 增量扫到新 EOF」排进这条会话的链——
 * 内存里的摘要每条都推进；status.json 节流落盘（默认 1s，脏才写），取摘要时也会先补到最新。
 *
 * ## 旧会话首次补算（backfill）
 * 没有 status.json / 校验失败 / 见到 revert 记录 → 全量重算。**不整份读进堆**：
 * - pass 1 只读行首（jsonl-scan 的 HEAD_BYTES）：每行取 id（行首键），revert 行整行留下
 *   取 targetMessageId；模拟 foldReverts 得生效行集（与 store.readLog 同一语义）；
 * - pass 2 折生效行：role=tool 且不是摘要工具的行**不解析整行**——行首取 toolCallId 做
 *   「解决」折叠（read_file / bash 这类几 MB 的大行全省；它们对摘要的唯一影响是
 *   「解决一次调用」，见 shared/status-digest.ts 的 activity 段）；摘要工具
 *   （update_plan / update_goal / delegate / terminal_execute / show_plugin_board /
 *   slides_* / doc_open / doc_export）与其余 role 整行解析。
 * 按 8ms 时间片让步（timeSlicer），不长时间占主进程。
 *
 * ## 指纹与失效（绝不显示错的）
 * 指纹 = { logOffset, lastId, records }。重启后首次摸一条会话：
 * - 日志比 logOffset 小（被截断 / 换过）→ 重算；
 * - 一样大 → 信任（同大小换内容只剩「应用外手改」一种，与任务账本同一套接受口径）；
 * - 大了 → 从 logOffset 增量补（terminatedOnly：半截行留给下一次）。
 * 回退（revert 记录）fold 不可逆 → 一律全量重算；导入更新（commitImportUpdate 整份换日志）
 * → invalidate；分支 / 导入（commitBranch / commitImported）内存里已有记录 → seed 直接播种；
 * 删会话 → remove 连 status.json 一起删。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { headStringField, scanJsonlLines, timeSlicer } from "../jsonl-scan.ts";
import { isNotFound } from "../fs-errors.ts";
import {
  emptyStatusDigestState,
  foldStatusRecord,
  parseStatusDigestState,
  type StatusDigestState,
} from "../../shared/status-digest.ts";
import { GOAL_TOOL_NAME } from "../../shared/goal.ts";
import { PLAN_TOOL_NAME } from "../../shared/plan.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { isSessionId, parseLogLine } from "./store.ts";

/** 摘要工具：这些 tool 记录整行解析（别的 tool 行只从行首取 toolCallId 做「解决」折叠） */
const FOLD_TOOLS: ReadonlySet<string> = new Set([
  PLAN_TOOL_NAME,
  GOAL_TOOL_NAME,
  "delegate",
  "terminal_execute",
  "show_plugin_board",
  "slides_create",
  "slides_write",
  "slides_edit",
  "slides_insert_image",
  "doc_open",
  "slides_export",
  "doc_export",
]);

const STATUS_VERSION = 1;
/** status.json 节流落盘的间隔（内存每条都推进，落盘不必） */
const PERSIST_DELAY_MS = 1000;

interface Entry {
  state: StatusDigestState;
  /** 摘要覆盖到日志的哪个字节（只推进到「已折的最后一个完整行」之后） */
  logOffset: number;
  /** 已从盘装载 / 补算过（false = 下次摸之前先 ensureLoaded） */
  loaded: boolean;
  /** 这条会话的写入链：touch / digests / invalidate / remove 都排它，互不踩 */
  chain: Promise<void>;
  /** 有没落盘的改动 */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** 最近一次被摸的时刻（逐出用） */
  touchedAt: number;
}

/** 盘上形状（sessions/<id>.status.json） */
interface StatusFile {
  version: number;
  logOffset: number;
  state: StatusDigestState;
}

export class StatusDigestStore {
  private readonly dir: string;
  private readonly persistDelayMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(sessionsDir: string, options?: { persistDelayMs?: number }) {
    this.dir = sessionsDir;
    this.persistDelayMs = options?.persistDelayMs ?? PERSIST_DELAY_MS;
  }

  private logPath(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  private statusPath(id: string): string {
    return join(this.dir, `${id}.status.json`);
  }

  private entryOf(id: string): Entry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = {
        state: emptyStatusDigestState(),
        logOffset: 0,
        loaded: false,
        chain: Promise.resolve(),
        dirty: false,
        timer: null,
        touchedAt: Date.now(),
      };
      this.entries.set(id, entry);
    }
    entry.touchedAt = Date.now();
    return entry;
  }

  /** 排进这条会话的链；链上某一环失败不卡死后续（存回去的是吃掉异常的那一支） */
  private enqueue(id: string, task: (entry: Entry) => Promise<void>): Promise<void> {
    const entry = this.entryOf(id);
    const next = entry.chain.then(() => task(entry), () => task(entry));
    entry.chain = next.then(
      () => undefined,
      (cause: unknown) => console.error("[status-digest] 任务失败", id, cause),
    );
    return next;
  }

  /**
   * 有新记录落盘（SessionStore.record 的追加回调）：把增量补扫排进链。
   * 同步返回——落盘路径不等摘要。
   */
  touch(id: string): void {
    if (!isSessionId(id)) return;
    void this.enqueue(id, async (entry) => {
      await this.ensureLoaded(id, entry);
      await this.catchUp(id, entry);
    });
  }

  /**
   * 批量取摘要（状态卡：主会话 + 全部子会话一次取）。每条先补到最新（自愈：
   * 监听器漏了 / 进程重启都从盘上补齐）再回内存态。会话连 meta 都没有（已删）= null。
   */
  async digests(ids: readonly string[]): Promise<Record<string, StatusDigestState | null>> {
    const out: Record<string, StatusDigestState | null> = {};
    await Promise.all(
      ids.map(async (id) => {
        if (!isSessionId(id)) {
          out[id] = null;
          return;
        }
        await this.enqueue(id, async (entry) => {
          await this.ensureLoaded(id, entry);
          await this.catchUp(id, entry);
        });
        const entry = this.entries.get(id);
        if (entry === undefined) {
          out[id] = null;
          return;
        }
        // 日志与 meta 都不在 = 会话已删（空摘要是「新会话」，null 是「没了」）
        if (entry.state.meta.records === 0 && entry.logOffset === 0 && (await this.gone(id))) {
          out[id] = null;
          return;
        }
        out[id] = entry.state;
      }),
    );
    return out;
  }

  /** 日志被整份替换（导入更新 commitImportUpdate）：丢掉重算（下次摸时；盘上 status.json 一并删） */
  invalidate(id: string): void {
    if (!isSessionId(id)) return;
    void this.enqueue(id, async (entry) => {
      entry.state = emptyStatusDigestState();
      entry.logOffset = 0;
      entry.loaded = false;
      entry.dirty = false;
      await this.deleteStatusFile(id);
    });
  }

  /**
   * 分支 / 导入落盘时直接播种（records 是新会话的初始 transcript，调用方内存里已有，
   * 省一次全量扫）。logBytes = 写盘的字节数（指纹起点）。
   */
  seed(id: string, records: readonly SessionRecord[], logBytes: number): void {
    if (!isSessionId(id)) return;
    void this.enqueue(id, async (entry) => {
      const state = emptyStatusDigestState();
      for (const record of records) foldStatusRecord(state, record);
      entry.state = state;
      entry.logOffset = logBytes;
      entry.loaded = true;
      entry.dirty = true;
      this.schedulePersist(id, entry);
    });
  }

  /** 删会话：清内存 + 删 status.json（排在链上，等在途任务落定） */
  async remove(id: string): Promise<void> {
    if (!isSessionId(id)) return;
    await this.enqueue(id, async (entry) => {
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.entries.delete(id);
      await this.deleteStatusFile(id);
    });
  }

  /** 退出前把脏的落盘（index.ts 的 before-quit 调） */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.entries.entries()].map(([id, entry]) =>
        this.enqueue(id, async (e) => {
          if (e.dirty) await this.persist(id, e);
        }),
      ),
    );
  }

  private async gone(id: string): Promise<boolean> {
    const meta = await stat(join(this.dir, `${id}.meta.json`)).then(() => true).catch(() => false);
    if (meta) return false;
    const log = await stat(this.logPath(id)).then(() => true).catch(() => false);
    return !log;
  }

  // ───────────────────────── 装载与补扫 ─────────────────────────

  /** 首次摸：读 status.json，按指纹决定信任 / 增量补 / 重算 */
  private async ensureLoaded(id: string, entry: Entry): Promise<void> {
    if (entry.loaded) return;
    entry.loaded = true;
    const logSize = await stat(this.logPath(id))
      .then((s) => s.size)
      .catch((cause: unknown) => {
        if (isNotFound(cause)) return null;
        throw cause;
      });
    if (logSize === null) {
      // 没有日志：空摘要（新会话还没说话 / 会话已删——digests 另判 gone）
      entry.state = emptyStatusDigestState();
      entry.logOffset = 0;
      return;
    }
    const parsed = await this.readStatusFile(id);
    if (parsed === null || parsed.logOffset > logSize) {
      await this.recompute(id, entry);
      return;
    }
    entry.state = parsed.state;
    entry.logOffset = parsed.logOffset;
    if (logSize > parsed.logOffset) await this.catchUp(id, entry);
  }

  private async readStatusFile(id: string): Promise<{ logOffset: number; state: StatusDigestState } | null> {
    let raw: string;
    try {
      raw = await readFile(this.statusPath(id), "utf8");
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const file = value as Record<string, unknown>;
    if (file["version"] !== STATUS_VERSION) return null;
    if (typeof file["logOffset"] !== "number" || file["logOffset"] < 0) return null;
    const state = parseStatusDigestState(file["state"]);
    if (state === null) return null;
    return { logOffset: file["logOffset"], state };
  }

  /**
   * 增量补扫：从 logOffset 折到新 EOF。见到 revert 记录（fold 不可逆）→ 全量重算。
   * 只折完整行（terminatedOnly）：半截行（崩溃写了一半）留给下一次。
   */
  private async catchUp(id: string, entry: Entry): Promise<void> {
    const path = this.logPath(id);
    const size = await stat(path)
      .then((s) => s.size)
      .catch((cause: unknown) => {
        if (isNotFound(cause)) return null;
        throw cause;
      });
    if (size === null) return; // 日志没了（会话刚删）：保持现状，remove 会收
    if (size < entry.logOffset) {
      await this.recompute(id, entry);
      return;
    }
    if (size === entry.logOffset) return;
    const slice = timeSlicer();
    let sawRevert = false;
    const consumed = await scanJsonlLines(
      path,
      (head) => this.keepLine(entry, head, () => {
        sawRevert = true;
      }),
      (line) => this.foldLine(entry, line),
      slice,
      { start: entry.logOffset, terminatedOnly: true },
    );
    if (sawRevert) {
      await this.recompute(id, entry);
      return;
    }
    entry.logOffset = consumed;
    entry.dirty = true;
    this.schedulePersist(id, entry);
  }

  /**
   * 全量重算（补算 / revert / 指纹对不上）。两遍流式扫，不整份进堆：
   * pass 1 出行首 id 序列 + revert 记录，模拟 foldReverts 得生效行集；pass 2 折生效行。
   */
  private async recompute(id: string, entry: Entry): Promise<void> {
    const path = this.logPath(id);
    const slice = timeSlicer();
    // pass 1：行首取 id / role；revert 行与行首缺 id 的行整行留下解析（都极小）
    const lineIds: (string | null)[] = [];
    const reverts = new Map<number, string>();
    await scanJsonlLines(
      path,
      (head) => {
        const id = headStringField(head, "id");
        const role = headStringField(head, "role");
        if (id === undefined || role === "revert") return true;
        lineIds.push(id);
        return false;
      },
      (line) => {
        const record = parseLogLine(line);
        const index = lineIds.length;
        lineIds.push(record?.id ?? null);
        if (record !== undefined && record.role === "revert") reverts.set(index, record.targetMessageId);
      },
      slice,
    );
    // 模拟 foldReverts（store.ts）：revert 把生效列表截到 target 之前，界碑自己留下
    const survivors: number[] = [];
    const posOf = new Map<string, number>();
    for (let index = 0; index < lineIds.length; index += 1) {
      const target = reverts.get(index);
      if (target !== undefined) {
        const at = posOf.get(target);
        if (at !== undefined) {
          for (const removed of survivors.splice(at)) {
            const removedId = lineIds[removed];
            if (removedId !== null && removedId !== undefined) posOf.delete(removedId);
          }
        }
      }
      const id = lineIds[index];
      if (id !== null && id !== undefined) posOf.set(id, survivors.length);
      survivors.push(index);
    }
    // pass 2：只折生效行（revert 界碑本身也是生效记录，照常折——它的截断已由生效行集表达）
    const alive = new Set(survivors);
    const state = emptyStatusDigestState();
    let index = -1;
    const consumed = await scanJsonlLines(
      path,
      (head) => {
        index += 1;
        if (!alive.has(index)) return false;
        return this.keepLine({ state }, head, null);
      },
      (line) => this.foldLine({ state }, line),
      slice,
    );
    entry.state = state;
    // 指纹只覆盖到最后一个完整行（半截行留给增量补扫，与 readLogEntries 跳过它对齐）
    entry.logOffset = consumed;
    entry.dirty = true;
    this.schedulePersist(id, entry);
  }

  /**
   * 行首分类（keep 判定）。要整行解析的留下；非摘要工具的 tool 行不解析——
   * 行首取 toolCallId 做「解决」折叠（对摘要的唯一影响是解决一次调用），并推进 records 计数。
   * **跳过解析的行不推进 lastId / recentIds**：lastId 必须指向生效视图里真实在的记录
   * （坏行 / 被折掉的行不在），否则 renderer 叠尾巴时拿它当界会丢活记录。
   * onRevert 非空（增量补扫）时 revert 行不折、报给调用方重算；为空（重算的 pass 2）时 revert
   * 界碑照常留下整行解析折叠。
   */
  private keepLine(entry: Pick<Entry, "state">, head: string, onRevert: (() => void) | null): boolean {
    const role = headStringField(head, "role");
    if (role === "revert" && onRevert !== null) {
      onRevert();
      return false;
    }
    if (role === "tool") {
      const toolName = headStringField(head, "toolName");
      if (toolName !== undefined && !FOLD_TOOLS.has(toolName)) {
        const callId = headStringField(head, "toolCallId");
        if (callId !== undefined) {
          // 「解决」折叠：batch 的 childActivityOf 对任何非 running 的 tool 记录都 resolved.add
          entry.state.activity.pending = entry.state.activity.pending.filter(([pendingId]) => pendingId !== callId);
          entry.state.meta.records += 1;
          return false;
        }
      }
    }
    return true;
  }

  /** 整行解析并折叠；坏行（半截 JSON / 字段不齐）跳过——与 readLogEntries 同一兜底 */
  private foldLine(entry: Pick<Entry, "state">, line: string): void {
    const record = parseLogLine(line);
    if (record === undefined) return;
    foldStatusRecord(entry.state, record);
  }

  // ───────────────────────── 落盘 ─────────────────────────

  private schedulePersist(id: string, entry: Entry): void {
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.enqueue(id, async (e) => {
        if (e.dirty) await this.persist(id, e);
      });
    }, this.persistDelayMs);
  }

  private async persist(id: string, entry: Entry): Promise<void> {
    const file: StatusFile = { version: STATUS_VERSION, logOffset: entry.logOffset, state: entry.state };
    await writeJsonAtomic(this.statusPath(id), file);
    entry.dirty = false;
  }

  private async deleteStatusFile(id: string): Promise<void> {
    await rm(this.statusPath(id), { force: true });
  }
}
