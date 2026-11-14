/**
 * Office 的能力面（主进程持有）—— 渲染、读取、批改、改动清单与回退。
 *
 * **为什么批改在主进程**：备份要落在会话工作台（`workbench/office-backups/`），改动清单
 * 要跨多次工具调用聚合，两条都是「会话级、进程级只有一份」的状态；agent 进程每轮都是新的，
 * 放在那里第二遍就会丢。同理 OfficeCLI 的定位与验活也只做一次（`OfficeCliResolver` 缓存）。
 *
 * **写盘纪律**：
 *   1. 一次编辑先备份（**这批改动的第一次**编辑时做，之后追加到同一份清单里）；
 *   2. 改前的旧值用一条独立的 `--best-effort` 读批次取（读不改盘，空格子的 get 失败
 *      不该把整批回滚）；
 *   3. 真正的写批次用 officecli 默认的 atomic（任何一项失败整批不落盘）；
 *   4. 同一份文件的编辑排队（一次只跑一批）——用户可能在两个窗口里同时点；
 *   5. 落盘后广播 `office:changed`，面板重新渲染 + 网格重读。
 */
import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import {
  buildOfficeBatch,
  officeChangesFromBatch,
  OFFICE_BATCH_TIMEOUT_MS,
  officeFormatOf,
  parseOfficeBatchReport,
  type OfficeAgentOutcome,
  type OfficeBatchResultItem,
  type OfficeBinSource,
  type OfficeChanges,
  type OfficeChange,
  type OfficeOp,
  type OfficeRenderResult,
  type OfficeRevertResult,
  type OfficeStatus,
} from "../../shared/office.ts";
import { fillMissingFormulaCaches, formulaCellKey, isNumericValue } from "./xlsx-cache.ts";
import {
  getOfficeText,
  renderOfficeHtml,
  resolveOfficeCli,
  runOfficeBatch,
  runOfficeCli,
  type OfficeCandidate,
  type OfficeRunResult,
  type OfficeRunner,
} from "./cli.ts";

/** 一份文件这一批改动的账（备份 + 累积的清单） */
interface ChangeBatch {
  /** 这批改动开始前的备份；null = 备份失败 / 会话没有工作台（清单照记，但不能回退） */
  backup: string | null;
  items: OfficeChange[];
  startedAt: number;
}

/**
 * 备份旁边的清单（`<backup>.json`）：`{ file, startedAt, items }`。
 * 进程内存记着同一份；落盘是为了**重启应用后「回退这批改动」还在**——备份本来就在盘上，
 * 清单只活在内存里的话，重启后那一堆备份就是没人认领的孤儿。adopt() 按 file 认领。
 */
interface ChangeBatchFile {
  file: string;
  startedAt: number;
  items: OfficeChange[];
}

export interface OfficeServiceDeps {
  /** 设置里的显式路径（每次现读：设置改了下一次渲染就生效） */
  configuredPath: () => Promise<string | undefined>;
  /** 按显式路径 / 环境 / 安装位置现算候选（顺序见 cli.ts） */
  candidatesFor: (configuredPath: string | undefined) => readonly OfficeCandidate[];
  /** 会话工作台的备份目录；返回 null = 这个会话没有可用的工作台（不备份、不可回退） */
  backupDir: (sessionId: string) => Promise<string | null>;
  /** 改动落盘后通知界面（主进程广播 office:changed） */
  notify?: (file: string) => void;
  /** 测试注入：换掉真 spawn / 时间 */
  run?: OfficeRunner;
  now?: () => number;
}

/**
 * 可用性缓存：一次进程内只验活一次（`--version` 是冷启动级别的开销）。
 * 设置里的显式路径变了立刻作废；失败带 10 秒 TTL（用户刚装好不必重启应用）。
 */
interface ProbeResult {
  bin: string;
  version: string;
  source: OfficeBinSource;
}

export class OfficeService {
  private readonly deps: OfficeServiceDeps;
  private readonly batches = new Map<string, ChangeBatch>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private probe: ProbeResult | null = null;
  private miss: { detail: string; at: number } | null = null;
  private probedFor = "";

  constructor(deps: OfficeServiceDeps) {
    this.deps = deps;
  }

  /** 设置改了 / 用户点「重新检测」：丢掉验活缓存 */
  invalidate(): void {
    this.probe = null;
    this.miss = null;
  }

  /** 当前二进制（已验活）；不可用时 detail 说明试过哪儿 */
  private async current(): Promise<{ ok: true } & ProbeResult | { ok: false; detail: string }> {
    const configured = (await this.deps.configuredPath())?.trim() ?? "";
    if (this.probedFor !== configured) {
      this.probe = null;
      this.miss = null;
      this.probedFor = configured;
    }
    if (this.probe !== null) return { ok: true, ...this.probe };
    const now = this.now();
    if (this.miss !== null && now - this.miss.at < 10_000) return { ok: false, detail: this.miss.detail };
    const resolved = await resolveOfficeCli(
      this.deps.candidatesFor(configured === "" ? undefined : configured),
      this.runner,
    );
    if (!resolved.ok) {
      this.miss = { detail: resolved.detail, at: now };
      return { ok: false, detail: resolved.detail };
    }
    this.probe = { bin: resolved.candidate.path, version: resolved.version, source: resolved.candidate.source };
    this.miss = null;
    return { ok: true, ...this.probe };
  }

  async status(): Promise<OfficeStatus> {
    const current = await this.current();
    if (!current.ok) {
      return { available: false, version: null, source: null, bin: null, detail: current.detail };
    }
    return { available: true, version: current.version, source: current.source, bin: current.bin, detail: null };
  }

  /**
   * 渲染一份 .xlsx / .pptx（调用方已过文件面板的白名单）。OfficeCLI 不可用 / 超时 /
   * 输出不像 HTML 都回 `unavailable` + 一句人话——面板据此退回网格 / 大纲。
   */
  async render(file: string): Promise<OfficeRenderResult> {
    const current = await this.current();
    if (!current.ok) return { kind: "unavailable", detail: current.detail };
    const rendered = await renderOfficeHtml(current.bin, file, this.runner);
    if (!rendered.ok) return { kind: "unavailable", detail: rendered.detail };
    return { kind: "html", html: rendered.html, version: current.version, elapsedMs: rendered.elapsedMs };
  }

  /** 读一个 DOM 子树给 agent（路径语法与预览里的 data-path 同源） */
  async read(file: string, path: string, depth: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const current = await this.current();
    if (!current.ok) return { ok: false, error: this.missingHint(current.detail) };
    const result = await getOfficeText(current.bin, file, path, depth, this.runner);
    if (!result.ok) return { ok: false, error: result.detail };
    return { ok: true, text: result.text };
  }

  /** 改动清单（没有改动时 items 为空；重启后从备份旁的清单认领） */
  async changesOf(sessionId: string, file: string): Promise<OfficeChanges> {
    const batch = await this.adopt(sessionId, file);
    return {
      file,
      items: batch?.items ?? [],
      backup: batch?.backup ?? null,
      startedAt: batch?.startedAt ?? null,
    };
  }

  /**
   * 进程里没有这一批时，从会话工作台的备份目录认领：备份旁的 `<backup>.json`
   * 按 `file` 对上就是它。多个（同一文件改了几轮又回退过）取 startedAt 最新的。
   */
  private async adopt(sessionId: string, file: string): Promise<ChangeBatch | null> {
    const key = this.key(sessionId, file);
    const existing = this.batches.get(key);
    if (existing !== undefined) return existing;
    const dir = await this.deps.backupDir(sessionId).catch(() => null);
    if (dir === null) return null;
    const names = await readdir(dir).catch(() => [] as string[]);
    let best: (ChangeBatch & { key: string }) | null = null;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const backup = join(dir, name.slice(0, -".json".length));
      if (!existsSync(backup)) continue;
      let meta: ChangeBatchFile;
      try {
        meta = JSON.parse(await readFile(join(dir, name), "utf8")) as ChangeBatchFile;
      } catch {
        continue;
      }
      if (meta.file !== file || !Array.isArray(meta.items)) continue;
      if (best === null || meta.startedAt > best.startedAt) {
        best = { backup, items: meta.items, startedAt: meta.startedAt, key };
      }
    }
    if (best === null) return null;
    this.batches.set(key, best);
    return best;
  }

  /** 清单变化就落盘（best-effort：写不了不影响编辑本身） */
  private async persist(batch: ChangeBatch, file: string): Promise<void> {
    if (batch.backup === null) return;
    try {
      const payload: ChangeBatchFile = { file, startedAt: batch.startedAt, items: batch.items };
      await writeJsonAtomic(`${batch.backup}.json`, payload);
    } catch {
      // 清单落不了盘：这一轮照常用，重启后认领不到而已
    }
  }

  /** agent 的一次批改（`edit_office`） */
  edit(sessionId: string, file: string, ops: readonly OfficeOp[]): Promise<OfficeAgentOutcome> {
    return this.queue(this.key(sessionId, file), () => this.applyEdits(sessionId, file, ops));
  }

  /** 回退这一批（用备份还原整份文件） */
  revert(sessionId: string, file: string): Promise<OfficeRevertResult> {
    return this.queue(this.key(sessionId, file), () => this.revertBatch(sessionId, file));
  }

  private get runner(): OfficeRunner {
    return this.deps.run ?? runOfficeCli;
  }

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  private key(sessionId: string, file: string): string {
    return `${sessionId}\u0000${file}`;
  }

  /** 「没装 OfficeCLI」时给模型的话：说清装什么、别让它去猜路径 */
  private missingHint(detail: string): string {
    return (
      `${detail} Office rendering / editing needs the bundled OfficeCLI (or a path in settings.officeCliPath / ` +
      "the ORBITA_OFFICECLI environment variable). Tell the user Office editing is unavailable instead of " +
      "editing the file with other tools."
    );
  }

  /** 同一个文件一次只跑一批；不同的文件互不阻塞 */
  private queue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * 写批次成功后补公式缓存值（B9）。OfficeCLI 重算时只写 `<f>` 不写 `<v>`，而网格用缓存值
   * 当显示值——被改的行与汇总行会整格变空。只扫「有公式没缓存」的格，问一次 officecli
   * 要计算值（get 会求值）再写回；没有缺缓存的格就什么都不做（不 spawn、不写盘）。
   * 失败只记一行日志，不影响这次编辑（网格对缺缓存有 `—` 占位兜底）。
   */
  private async fillFormulaCaches(bin: string, file: string): Promise<void> {
    if (officeFormatOf(file) !== "xlsx") return;
    try {
      await fillMissingFormulaCaches(file, async (cells) => {
        const items = cells.map(({ sheet, cell }) => ({ command: "get", path: `/${sheet}/${cell}` }));
        const run = await runOfficeBatch(bin, file, items, this.runner, { bestEffort: true });
        const report = parseOfficeBatchReport(run.stdout);
        const values = new Map<string, string>();
        cells.forEach(({ sheet, cell }, index) => {
          const result = report.results.find((entry) => entry.index === index);
          const text = result?.success === true ? (result.text ?? "").trim() : "";
          if (text !== "" && isNumericValue(text)) values.set(formulaCellKey(sheet, cell), text);
        });
        return values;
      });
    } catch (cause) {
      console.error(`[office] formula cache fill failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async applyEdits(sessionId: string, file: string, ops: readonly OfficeOp[]): Promise<OfficeAgentOutcome> {
    const current = await this.current();
    if (!current.ok) return { ok: false, error: this.missingHint(current.detail) };
    if (officeFormatOf(file) === null) {
      return { ok: false, error: `Not an Office file I can edit (only .xlsx / .pptx): ${file}` };
    }
    const { reads, items } = buildOfficeBatch(ops);
    if (items.length === 0) return { ok: false, error: "No valid operations: each op needs op=set|add|remove and a /-rooted path." };

    const startedAt = this.now();
    const batch = await this.ensureBackup(sessionId, file, startedAt);

    // 1) 读旧值（best-effort：读不改盘，空格子的 get 失败不是错误）
    let readResults: OfficeBatchResultItem[] = [];
    if (reads.length > 0) {
      const readRun = await runOfficeBatch(current.bin, file, reads, this.runner, { bestEffort: true });
      const readReport = parseOfficeBatchReport(readRun.stdout);
      if (readReport.parsed) readResults = readReport.results;
    }

    // 2) 写（默认 atomic）
    const writeRun = await runOfficeBatch(current.bin, file, items, this.runner);
    if (writeRun.timedOut) {
      await this.discardEmptyBackup(batch);
      return {
        ok: false,
        error:
          `OfficeCLI timed out after ${Math.round(OFFICE_BATCH_TIMEOUT_MS / 1000)}s and was killed (nothing was written; ` +
          `a backup is still at ${batch.backup ?? "—"}).`,
      };
    }
    const report = parseOfficeBatchReport(writeRun.stdout);
    if (!report.parsed) {
      // 老版本 / 输出被截断：按退出码判断，逐项结果按「全成功」记（旧值仍是 null）
      if (writeRun.code !== 0) {
        await this.discardEmptyBackup(batch);
        return { ok: false, error: this.describeFailure(writeRun) };
      }
      const synthetic = {
        success: true,
        parsed: false,
        failed: 0,
        results: ops.map((_op, index) => ({
          index,
          success: true,
          text: null,
          addedPath: null,
          error: null,
        })),
      };
      const { items: changes, failures } = officeChangesFromBatch(ops, synthetic, readResults, startedAt);
      await this.fillFormulaCaches(current.bin, file);
      await this.record(sessionId, file, batch, changes);
      this.notify(file, changes.length);
      return {
        ok: true,
        kind: "edit",
        file,
        version: current.version,
        elapsedMs: writeRun.elapsedMs,
        items: changes,
        failures,
        canRevert: batch.backup !== null,
      };
    }
    if (!report.success) {
      await this.discardEmptyBackup(batch);
      return { ok: false, error: this.describeReportFailure(report) };
    }
    const { items: changes, failures } = officeChangesFromBatch(ops, report, readResults, startedAt);
    await this.fillFormulaCaches(current.bin, file);
    await this.record(sessionId, file, batch, changes);
    this.notify(file, changes.length);
    return {
      ok: true,
      kind: "edit",
      file,
      version: current.version,
      elapsedMs: writeRun.elapsedMs,
      items: changes,
      failures,
      canRevert: batch.backup !== null,
    };
  }

  private describeFailure(run: OfficeRunResult): string {
    const detail = (run.stderr.trim() !== "" ? run.stderr : run.stdout).trim().slice(0, 400);
    return `OfficeCLI batch failed (exit ${String(run.code)}). Nothing was written (atomic batch). ${detail}`;
  }

  private describeReportFailure(report: ReturnType<typeof parseOfficeBatchReport>): string {
    const failed = report.results.filter((item) => !item.success).slice(0, 5);
    const lines = failed.map((item) => `#${item.index + 1}: ${item.error ?? "unknown error"}`);
    return `OfficeCLI rejected the batch, so nothing was written (atomic). ${lines.join("; ")}`;
  }

  /** 这一批的第一次编辑：备份原文件（同批后续编辑不再覆盖备份） */
  private async ensureBackup(sessionId: string, file: string, startedAt: number): Promise<ChangeBatch> {
    const key = this.key(sessionId, file);
    const existing = this.batches.get(key);
    if (existing !== undefined) return existing;
    const batch: ChangeBatch = { backup: null, items: [], startedAt };
    try {
      const dir = await this.deps.backupDir(sessionId);
      if (dir !== null) {
        await mkdir(dir, { recursive: true });
        const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
        const backup = join(dir, `${stamp}-${basename(file)}`);
        await copyFile(file, backup);
        batch.backup = backup;
      }
    } catch {
      // 备份失败不改盘也不拦编辑：清单照记，canRevert 如实为 false
    }
    this.batches.set(key, batch);
    return batch;
  }

  /** 一次都没改成（atomic 回滚 / 超时）：这次新做的备份没人需要，删掉别留孤儿 */
  private async discardEmptyBackup(batch: ChangeBatch): Promise<void> {
    if (batch.items.length > 0 || batch.backup === null) return;
    await unlink(batch.backup).catch(() => undefined);
    batch.backup = null;
  }

  private async record(sessionId: string, file: string, batch: ChangeBatch, changes: readonly OfficeChange[]): Promise<void> {
    if (changes.length === 0) return;
    const key = this.key(sessionId, file);
    batch.items.push(...changes);
    this.batches.set(key, batch);
    await this.persist(batch, file);
  }

  private notify(file: string, changes: number): void {
    if (changes === 0) return;
    this.deps.notify?.(file);
  }

  private async revertBatch(sessionId: string, file: string): Promise<OfficeRevertResult> {
    const key = this.key(sessionId, file);
    const batch = this.batches.get(key);
    if (batch === undefined) return { ok: false, error: "No edits to revert for this file", restored: 0 };
    if (batch.backup === null) {
      return { ok: false, error: "This batch has no backup (backup failed or the session has no workbench), so it cannot be reverted", restored: 0 };
    }
    try {
      const bytes = await readFile(batch.backup);
      await writeBytesAtomic(file, bytes);
    } catch (cause) {
      // 文件被 Excel / PowerPoint / 预览进程占着时 Windows 回 EPERM（rename 失败）：
      // 说清是人话，别把 errno 直接甩给用户
      const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : "";
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        return {
          ok: false,
          error: "文件正被另一个程序占用（Excel / PowerPoint / 预览可能开着它），关掉它再回退",
          restored: 0,
        };
      }
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause), restored: 0 };
    }
    const restored = batch.items.length;
    this.batches.delete(key);
    // 回退成功 = 这一批结束：备份与清单一起删掉（留着就是下一轮编辑认领到旧备份）
    if (batch.backup !== null) {
      await unlink(`${batch.backup}.json`).catch(() => undefined);
      await unlink(batch.backup).catch(() => undefined);
    }
    this.deps.notify?.(file);
    return { ok: true, restored };
  }
}
