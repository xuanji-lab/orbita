/**
 * 执行一次 LaTeX 编译 —— spawn latexmk、等它结束、读 .log、判定结果。
 *
 * 四条定死的决定，改之前先读：
 *
 * 1. **多轮交给 latexmk**（见 shared/latex.ts 的文件头）。我们只给它一条 argv。
 * 2. **成功判据是「退出码 0 **且** PDF 不早于主文件」**。它判的是「磁盘上的 PDF 是不是
 *    这份源码的产物」，**不是**「这一次重新排了版」：源文件没改时 latexmk 说
 *    "Nothing to do"、PDF 的 mtime 不动，仍然算成功（PDF 确实是最新的，评审 A1）。
 *    它拦住的是两种假成功——`-outdir` 不可写 / 命令写错让 latexmk 什么都没做却回 0，
 *    以及 PDF 比源码还旧。本次是否真的写了一张新 PDF 由 `pdfFresh` 单独表示
 *    （mtime ≥ 本次 spawn 时刻），模型文案靠它区分「这一次的 PDF」与「上一次留下的」。
 * 3. **读 .log，不读 stdout**（理由见 parse-log.ts）。日志位置不假定在 outDir：
 *    自定义 recipe 可以不带 -outdir，产物就落在主文件旁边；先按 outDir 找，再按
 *    argv 里的 -outdir、主文件目录找，PDF 还认日志里的 `Output written on`。
 *    **日志按新旧分辨，不删旧日志**：spawn 前记 mtime，运行后只把「变了 / 新出现」
 *    的那份当本次日志；一份都不是本次的就退回最近的一份并标记 `logStale`——
 *    errors / warnings 照常返回（它多半就是失败原因），但 pages 不从那里取。
 *    删旧日志的写法在「latexmk 判定无事可做、失败退出且不重写日志」时会把诊断
 *    信息一起删掉（同一份坏文档连编两次就看不到错）。
 * 4. **并发上限按内存定**：同一项目互斥（两次 latexmk 抢同一组 .aux 会互相写坏），
 *    全局上限由 `os.totalmem()` 决定——> 16 GiB 跑 2 个，≤ 16 GiB 只跑 1 个
 *    （无风扇机型两个引擎一起跑会降频，反而更慢）。**满了就明确拒绝，不排队**：
 *    排队会让模型以为工具卡住，也让「一次只跑一个」的降频意图落空。
 *    被拒不是编译结局，走 `{ ok: false, reason }`——那时我们连进程都没起。
 * 5. **超时看日志静默，不看总时长**：日志连续 LATEX_IDLE_TIMEOUT_MS（300 秒）没有
 *    新的落盘变化才判卡住，另加 LATEX_TOTAL_TIMEOUT_MS（10 分钟）总时长封顶。
 *    阈值不是 90 秒：TeX 的 .log 按 4 KiB 块落盘，实测合法的 lualatex 编译可以
 *    连续 105 秒 stat 不动、最终 256.8 秒成功；90 秒会在 93.1 秒误杀它。
 *    判活信号只认产物日志的增长 / mtime：stdout 不能当信号（latexmk 在结束前
 *    几乎不说话），日志被轮换或还没生成时按进程存活处理（交给总时长闸）。
 *
 * 超时 / 取消都杀**整棵进程树**：latexmk 只是 Perl 驱动，真正干活的是 pdflatex /
 * bibtex 子进程；只杀 latexmk 会留下孤立的引擎进程继续占 CPU 与 .aux。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  LATEX_MAX_OUTPUTS,
  LATEX_CLEAN_TIMEOUT_MS,
  LATEX_IDLE_TIMEOUT_MS,
  LATEX_LOG_TAIL_LIMIT,
  LATEX_MAX_LOG_BYTES,
  LATEX_TOTAL_TIMEOUT_MS,
  latexMaxConcurrent,
  type LatexBuildProgress,
  type LatexBuildStep,
  type LatexCleanOutcome,
  type LatexCleanResult,
  type LatexCommand,
  type LatexCompileRequest,
  type LatexEngine,
  type LatexEngineSource,
  type LatexIssue,
  type LatexLogRef,
  type LatexLogTail,
  type LatexOutput,
  type LatexProbeRequest,
  type LatexProbeResult,
  type LatexResolvedPackage,
  type LatexResult,
  type LatexRunOutcome,
  type LatexStatus,
  type LatexTimeoutKind,
} from "../../shared/latex.ts";
import { createLatexProbe, type LatexProbe } from "./probe.ts";
import { parseBlg } from "./parse-blg.ts";
import { hasContentWarnings, parseLatexLog, type LoggedOutputItem } from "./parse-log.ts";
import { createLatexPackageLookup, type LatexPackageLookup } from "./packages.ts";
import { resolveLatexPlan, type LatexPlan } from "./resolve.ts";

/** 超时杀掉之后，等 close 事件的宽限。任务管理器杀不掉的进程不该让调用方永远等下去 */
const KILL_GRACE_MS = 5000;

/** 失败时附带的 stderr 长度（latexmk 的 stderr 通常只有一句 "Latexmk: … failed"） */
const STDERR_LIMIT = 2000;

interface ProcessOutcome {
  code: number | null;
  /** 非 null = 被超时杀掉。idle 与 total 的下一步动作不同（改源码 vs 拆文档），要带出去 */
  timeout: TimeoutInfo | null;
  cancelled: boolean;
  spawnError: string | null;
  stderr: string;
}

/** 多步链里真起过的一步（工具名 + 时序） */
interface StepRun {
  tool: string;
  startedAtMs: number;
  durationMs: number;
}

interface TimeoutInfo {
  kind: LatexTimeoutKind;
  /** 被停时的日志静默时长 */
  silentMs: number;
  /** 从 spawn 到被停的总时长 */
  elapsedMs: number;
  /** 整个运行期间见过任何候选日志吗。false = 自定义 recipe 没写 .log，文案要说清 */
  sawLog: boolean;
}

/** 构造参数只给测试留口：超时值要能在测试里缩到几百毫秒 */
export interface LatexRunnerOptions {
  /** 日志静默上限；默认 LATEX_IDLE_TIMEOUT_MS（300 秒） */
  idleTimeoutMs?: number;
  /** 总时长硬上限；默认 LATEX_TOTAL_TIMEOUT_MS（10 分钟） */
  totalTimeoutMs?: number;
  /** 看日志 mtime 的间隔；默认 1 秒。测试调小，不必靠真等 90 秒做唯一覆盖 */
  pollIntervalMs?: number;
  /** 本机总内存（字节）；默认 os.totalmem()。测试注入，覆盖 ≤16 GiB 与 >16 GiB */
  totalMemoryBytes?: number;
  /**
   * 看门狗用的时钟；默认 Date.now。**只影响超时判定**，不参与产物 mtime 比较
   * （pdfFresh 要拿文件系统时间戳比，不能跟着假时钟走）。
   *
   * 测试注入它的理由：日志增长与时间前进在同一个同步回合里完成，看门狗无论何时
   * tick 都只能看到「刚有增长」，于是结果不再取决于宿主负载 / 子进程调度。
   */
  now?: () => number;
  /**
   * 设置里显式指定的 latexmk 路径（每轮现读）。缺席 = 只靠 PATH 与常见安装根。
   * 生产传 `() => settings.read().then((s) => s.latexmkPath)`。
   */
  explicitPath?: () => Promise<string | undefined>;
}

export class LatexRunner {
  private readonly probe: LatexProbe;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly pollIntervalMs: number;
  /** 这台机器允许的同时编译数：构造时按总内存定死（运行中内存不会变） */
  private readonly maxConcurrent: number;
  private readonly totalMemoryBytes: number;
  /** 看门狗时钟（注入点）。spawn 时刻与每次 tick 都用它算静默 / 总时长 */
  private readonly now: () => number;
  /**
   * 设置里显式指定的 latexmk 路径（每轮现读）。缺席 = 只靠 PATH 与常见安装根。
   * 用函数而不是构造时的字符串：用户在引导卡里刚选完，不该等一次重启才生效。
   */
  private readonly explicitPath: (() => Promise<string | undefined>) | null;
  /** 正在编的项目（规范化后的目录）：同项目互斥的唯一真源 */
  private readonly active = new Set<string>();
  /** 正在跑的 latexmk 进程（key = 项目）。取消与退出清理都认它 */
  private readonly children = new Map<string, ChildProcess>();
  private readonly cancelled = new Set<string>();
  private running = 0;
  /** 编译中的进度（latexmk stdout 的 `Run number N of rule 'x'`）；key = 项目 */
  private readonly progress = new Map<string, { step: string | null; run: number | null }>();
  /**
   * 缺包反查（`latex_packages`）。**不碰编译路径**：一条反查要起 tlmgr（本机实测
   * 3 个名字 5.2 秒），只有模型按需调用时才走到这里。缓存由 packages.ts 管。
   */
  private packageLookup: LatexPackageLookup | null = null;

  /** deps 只给测试与将来换探测实现留口；生产默认走真盘 + 真 execFile */
  constructor(probe: LatexProbe = createLatexProbe(), options: LatexRunnerOptions = {}) {
    this.probe = probe;
    this.idleTimeoutMs = options.idleTimeoutMs ?? LATEX_IDLE_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? LATEX_TOTAL_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
    this.maxConcurrent = latexMaxConcurrent(this.totalMemoryBytes);
    this.now = options.now ?? Date.now;
    this.explicitPath = options.explicitPath ?? null;
  }

  /**
   * 编一次。`request.dir` 是项目目录（相对路径按调用方解析；主进程侧已保证绝对）。
   * 任何路径都返回结果或明确拒绝——调用方（agent 工具）没有第二份超时。
   */
  async compile(request: LatexCompileRequest): Promise<LatexRunOutcome> {
    const started = Date.now();
    const dirInput = (request.dir ?? "").trim();
    if (dirInput === "") {
      return { ok: false, error: "dir is required — pass the directory that holds the .tex file." };
    }
    const dir = resolve(dirInput);
    const key = projectKey(dir);
    if (this.active.has(key)) {
      return {
        ok: false,
        reason: "same-project",
        error: `A LaTeX build is already running in ${dir}. Wait for it to finish, then compile again.`,
      };
    }
    if (this.running >= this.maxConcurrent) {
      // 明确拒绝：低内存机的第二个编译会跟第一个一起降频，排队只会让两边都慢。
      // 文案走给模型的英文，与同项目互斥那条一致；工具侧再按 reason 区分「稍后重试」与「改参数」。
      const memoryGb = this.totalMemoryBytes / 1024 ** 3;
      return {
        ok: false,
        reason: "busy",
        error:
          `LaTeX is busy: ${String(this.maxConcurrent)} build(s) already running on this machine ` +
          `(${memoryGb.toFixed(1)} GiB total, so at most ${String(this.maxConcurrent)} at a time). ` +
          "Wait for one to finish, then retry — do not queue.",
      };
    }
    this.active.add(key);
    this.running += 1;
    this.progress.set(key, { step: null, run: null });
    try {
      return { ok: true, result: await this.build(request, dir, key, started) };
    } finally {
      this.active.delete(key);
      this.cancelled.delete(key);
      this.progress.delete(key);
      this.running -= 1;
    }
  }

  /**
   * 编译中的进度。**只报真观察到的信号**（latexmk stdout 每跑一轮引擎 / bibtex 打一行）；
   * 没有信号（自定义 recipe 不打印）时 `step` 为 null，界面退回「编译中…」。
   */
  buildProgress(dirInput: string): LatexBuildProgress {
    const dir = (dirInput ?? "").trim();
    const key = projectKey(dir === "" ? process.cwd() : resolve(dir));
    const running = this.active.has(key);
    const entry = this.progress.get(key);
    return {
      running,
      step: running ? (entry?.step ?? null) : null,
      run: running ? (entry?.run ?? null) : null,
    };
  }

  /** 应用退出：杀掉所有在跑的进程树。结果按 cancelled 回报给还在等的调用方 */
  cancelAll(): void {
    for (const [key, child] of this.children) {
      this.cancelled.add(key);
      killTree(child);
    }
  }

  /**
   * 取消**一个项目**的编译（编译条的「取消」）。没有在跑的编译就回 false。
   * 与 cancelAll 同一套语义：杀整棵进程树，等着的 compile() 以 cancelled 结局收尾
   * ——不是抛错，界面据此显示「已取消」而不是一次失败的编译。
   */
  cancel(dirInput: string): boolean {
    const dir = resolve(dirInput);
    const key = projectKey(dir);
    if (!this.active.has(key)) return false;
    this.cancelled.add(key);
    const child = this.children.get(key);
    if (child !== undefined) killTree(child);
    return true;
  }

  /** 本机 latexmk / 引擎探测（缓存由 createLatexProbe 管，界面点开 chip 时现问） */
  async probeEnvironment(request: LatexProbeRequest = {}): Promise<LatexProbeResult> {
    // refresh = 用户说「装好了，再看一眼」：不作废缓存就会拿到启动时（或上一次）的结论
    if (request.refresh === true) this.probe.refresh();
    return this.probe.probe(await this.explicitPathOf());
  }

  /**
   * 缺的文件名 → 发行版包名与安装命令（`latex_packages` 工具与界面的
   * `latex:packages` 通道同一份实现）。**按需调用**：每一条都要起 kpsewhich / tlmgr。
   */
  async lookupPackages(missing: readonly string[]): Promise<LatexResolvedPackage[]> {
    if (this.packageLookup === null) {
      this.packageLookup = createLatexPackageLookup(async () => (await this.probeEnvironment()).latexmk);
    }
    return this.packageLookup.resolve(missing);
  }

  /**
   * 现验一个候选路径是不是能跑的 latexmk（「指定位置」用）。
   * **只认它自己**：`probe(explicit)` 在验不活时会退回 PATH，那时可能回 ok——那说明
   * 「机器上有 latexmk」，但用户刚选的那个文件并不是，不能把它写进设置。
   */
  async verifyLatexmkPath(path: string): Promise<boolean> {
    const result = await this.probe.probe(path);
    return result.ok && result.source === "setting";
  }

  private async explicitPathOf(): Promise<string | undefined> {
    if (this.explicitPath === null) return undefined;
    try {
      return await this.explicitPath();
    } catch (cause) {
      // 读设置失败不该让编译变成 not-installed：记一句，走 PATH 与常见根
      console.warn("[latex] 读不到设置里的 latexmk 路径，改从 PATH 与常见安装位置找", cause);
      return undefined;
    }
  }

  /**
   * 清理辅助文件：`latexmk -c`（删 .aux / .log / .fdb_latexmk 等，**保留 PDF**）。
   *
   * 三件事固定下来：
   *
   * 1. **与编译抢同一把锁**：清理动的是正在被 latexmk 读写的那组 .aux；在编时
   *    按 same-project 拒绕（理由与 compile 同一条，不是一次清理失败）。
   * 2. **报告差集而不是 latexmk 的自述**：`-c` 只回一句 Cleaned，不报删了哪几份。
   *    清理前后列一遍产物目录，removed / kept 都是磁盘事实，toast 才有资格说
   *    「删了 6 个文件，PDF 还在」。目录不存在时直接回空（没编过就没东西可清）。
   * 3. **固定用 latexmk，不用 recipe 的可执行文件**：`-c` 是 latexmk 的功能，
   *    自定义 recipe 指向的工具（tectonic / 自写脚本）未必认这个参数。
   *
   * 超时只留总时长一道（60 秒）：清理是读 .fdb_latexmk + 删文件，没有「日志在长」
   * 这种进度信号可看，走日志静默判定只会把「很快就完了」拖成 5 分钟。
   */
  async clean(dirInput: string): Promise<LatexCleanOutcome> {
    const started = Date.now();
    const input = (dirInput ?? "").trim();
    if (input === "") {
      return { ok: false, error: "dir is required — pass the directory that holds the .tex file." };
    }
    const dir = resolve(input);
    const key = projectKey(dir);
    if (this.active.has(key)) {
      return {
        ok: false,
        reason: "same-project",
        error: `A LaTeX build is running in ${dir}. Wait for it to finish, then clean again.`,
      };
    }
    if (this.running >= this.maxConcurrent) {
      return {
        ok: false,
        reason: "busy",
        error: "LaTeX is busy with another project on this machine. Wait for it to finish, then clean again.",
      };
    }
    const probe = await this.probeEnvironment();
    if (!probe.ok || probe.latexmk === null) return { ok: false, error: probe.message };
    const plan = resolveLatexPlan(dir, {});
    if (plan.status !== "ok") return { ok: false, error: plan.detail };
    // -c 是 latexmk 的功能：手写链 / 单次编译的配方下没有它可用（界面也会禁用这一项）
    if (!plan.cleanable) {
      return {
        ok: false,
        error: "This recipe does not use latexmk, so it has no `latexmk -c` to clean with. Pick a latexmk recipe to use Clean.",
      };
    }

    const target = cleanDirOf(plan);
    const before = listFiles(target);
    if (before === null) {
      // 产物目录还没有：没编过，没什么可清。不 spawn 一个必然空转的 latexmk。
      return { ok: true, result: { dir: target, removed: [], kept: [], durationMs: Date.now() - started } };
    }

    this.active.add(key);
    this.running += 1;
    try {
      const outcome = await this.spawnLatexmk(
        probe.latexmk,
        cleanArgv(target, plan.mainName),
        plan.dir,
        key,
        [],
        // 清理没有步骤可言（只跑一条 latexmk -c），也不收集时序
        null,
        // 两道闸都设成 60 秒：没有日志可看时 idle 只会被 total 兑掉（见 spawnLatexmk 的说明）
        { idle: LATEX_CLEAN_TIMEOUT_MS, total: LATEX_CLEAN_TIMEOUT_MS },
      );
      if (this.cancelled.has(key)) return { ok: false, error: "Clean was cancelled." };
      if (outcome.spawnError !== null) {
        return { ok: false, error: `latexmk could not be started: ${outcome.spawnError}` };
      }
      if (outcome.timeout !== null) {
        return { ok: false, error: `latexmk -c did not finish within ${seconds(LATEX_CLEAN_TIMEOUT_MS)}, so it was stopped.` };
      }
      if (outcome.code !== 0) {
        return { ok: false, error: `latexmk -c exited with code ${String(outcome.code)}.${stderrTail(outcome.stderr)}` };
      }
      const after = listFiles(target) ?? [];
      return { ok: true, result: cleanResult(target, before, after, Date.now() - started) };
    } finally {
      this.active.delete(key);
      this.cancelled.delete(key);
      this.progress.delete(key);
      this.running -= 1;
    }
  }

  private async build(
    request: LatexCompileRequest,
    dir: string,
    key: string,
    started: number,
  ): Promise<LatexResult> {
    const requestedEngine = request.engine;

    const probe = await this.probeEnvironment();
    if (!probe.ok || probe.latexmk === null) {
      return emptyResult(
        "not-installed",
        requestedEngine ?? "pdf",
        started,
        [issue(probe.message)],
        [],
        requestedEngine === undefined ? "auto" : "request",
      );
    }

    const plan = resolveLatexPlan(dir, {
      ...(request.main === undefined ? {} : { main: request.main }),
      ...(request.file === undefined ? {} : { file: request.file }),
      ...(requestedEngine === undefined ? {} : { engine: requestedEngine }),
      ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
    });
    if (plan.status !== "ok") {
      const candidates = plan.candidates.length === 0 ? "" : ` Candidates: ${plan.candidates.join(", ")}.`;
      return emptyResult(
        plan.status,
        requestedEngine ?? "pdf",
        started,
        [issue(`${plan.detail}${candidates}`)],
        plan.candidates,
        requestedEngine === undefined ? "auto" : "request",
      );
    }

    if (this.cancelled.has(key)) {
      return cancelledResult(plan.root, plan.engine, started, requestedEngine === undefined ? "auto" : "request");
    }

    /*
     * 日志与产物的位置不假定在 outDir：自定义 recipe 可以不带 -outdir，那时产物就
     * 落在主文件旁边；-jobname 会把它们改名，所以日志名与产物名都用 jobBase。
     * 候选顺序 = 项目 outDir → argv 里的 -outdir → 主文件目录。
     */
    const outDirs = outputDirs(plan);
    const jobBase = plan.jobname ?? basename(plan.mainName, extname(plan.mainName));
    const logCandidates = outDirs.map((candidate) => join(candidate, `${jobBase}.log`));
    /*
     * M3（二版）：**不删旧日志**。删掉它的那次修复引出了更糟的回归——同一份坏文档
     * 连编两次时，latexmk 读 .fdb_latexmk 判定无事可做、直接以非零码退出，**不会重写
     * .log**；删了旧日志就既没有新日志也没有旧日志，第二次的错误信息全丢。
     *
     * 现在的做法：spawn 前记下每份候选日志的 mtime，运行后取「mtime 变了 / 新出现」
     * 的那份作为本次日志（pages 只信它）；一份都不是本次的，则退回最近的一份并标记
     * 为 stale：errors / warnings 照常解析（它多半就是这次失败的原因），但 pages 与
     * 日志里的产物路径不用（那是上一轮的事实）。同项目互斥保证没有第二个写者。
     *
     * 产物快照与日志快照在同一时刻拍：**「新出现 / mtime 变了」比「mtime ≥ 本次
     * spawn」更耐时钟偏移**（系统时间被校准时，新写的文件也可能早于 spawn 时刻）。
     */
    const logBefore = new Map<string, number | null>(logCandidates.map((path) => [path, mtimeOf(path)]));
    const outputsBefore = snapshotOutputs(outDirs);

    /*
     * 产物目录要先存在：latexmk 自己会 mkdir，**裸 pdflatex / xelatex / biber 不会**——
     * 缺目录时 TeX 会把产物悄悄写回主文件旁边（-outdir 只对已存在的目录生效），
     * 于是回执里的产物位置与 -outdir 对不上（真机实测：single-pass 的 PDF 落在项目根）。
     */
    if (plan.preset !== null) {
      try {
        mkdirSync(plan.outDir, { recursive: true });
      } catch (cause) {
        console.warn(`[latex] 建不了产物目录 ${plan.outDir}：`, cause);
      }
    }

    const runStartedAt = Date.now();
    const spawnStartedAt = this.now();
    const rawSteps: RawStep[] = [];
    /*
     * 配方预设可能是**多步链**（latexmk → makeindex → latexmk / xelatex → biber → xelatex）。
     * 顺序起，前一步非零 / 超时 / 起不来就停在那里——后面的步骤对着半份产物跑只会
     * 制造更难读的错误。单步（默认链 / 自定义 recipe / 推荐的三条）走同一条路。
     */
    const chain: StepRun[] = [];
    let outcome: ProcessOutcome | null = null;
    for (const [index, step] of plan.steps.entries()) {
      if (this.cancelled.has(key)) {
        outcome = { code: null, timeout: null, cancelled: true, spawnError: null, stderr: "" };
        break;
      }
      // 多步链的进度：报「正在跑哪个工具」，run 留空（latexmk 的轮次只对它自己有意义）
      if (plan.steps.length > 1) this.progress.set(key, { step: step.tool, run: null });
      const stepStartedAt = this.now() - spawnStartedAt;
      const result = await this.spawnLatexmk(
        step.command ?? probe.latexmk,
        step.argv,
        plan.dir,
        key,
        logCandidates,
        // 多步链里每一趟 latexmk 的轮次都从 1 重新数，混在一起会拼出假的轮次
        plan.steps.length === 1 ? rawSteps : null,
      );
      chain.push({
        tool: step.tool,
        startedAtMs: stepStartedAt,
        durationMs: this.now() - spawnStartedAt - stepStartedAt,
      });
      outcome = result;
      if (result.cancelled || result.timeout !== null || result.spawnError !== null || result.code !== 0) break;
    }
    if (outcome === null) {
      return cancelledResult(plan.root, plan.engine, started, plan.engineSource);
    }
    /** 停下来的那一步（多步链的报错要说清是谁失败了，不能一律写 latexmk） */
    const failedTool = chain[chain.length - 1]?.tool ?? "latexmk";
    /** 实际起过的最后一步：回执的 command 只说真跑过的东西（plan.steps 至少一步） */
    const ranStep = plan.steps[Math.max(0, chain.length - 1)] ?? plan.steps[0] ?? { tool: "latexmk", command: null, argv: plan.argv };
    /*
     * 步骤时序：单步（默认链 / 自定义 recipe / 推荐的三条）沿用旧口径——只认
     * stdout 里 `Run number N of rule 'x'` 的真轮次（不打印时为空数组，与自定义
     * recipe 的历史语义一致）。多步链的每一趟都会从 1 重新数，混在一起是假轮次，
     * 所以改用我们真起过的步骤（工具 + 时长）。
     */
    const observedRuns = plan.steps.length === 1;
    const steps = observedRuns
      ? finalizeSteps(rawSteps, Math.max(0, this.now() - spawnStartedAt))
      : chain.map((entry, index) => ({
          rule: entry.tool,
          run: null,
          startedAtMs: entry.startedAtMs,
          durationMs: entry.durationMs,
          end: index === chain.length - 1 ? ("last" as const) : ("ran" as const),
        }));

    const picked = pickLog(logBefore);
    const logFile = picked.path === null ? null : readLogFile(picked.path);
    const logText = logFile?.text ?? "";
    const parsed = parseLatexLog(logText);
    const logStale = picked.stale;

    /*
     * .blg：bibtex / biber 的真根因只在里面（`Illegal end of database file---line 5 of
     * file refs.bib`）。回执以前连这个文件的存在都不提，模型只能猜「是 .bib 写坏了还是
     * 没跑 bibtex」。同目录多份产物目录时按 outDirs 顺序取第一份存在的——那与本轮
     * 引擎的 -outdir 同序。
     */
    const blg = findBlg(outDirs, jobBase);
    const merged = mergeDiagnostics(parsed.diagnostics, blg === null ? [] : parseBlg(readTextLimited(blg)));
    /*
     * 日志属于**最后一次引擎跑轮**（latexmk 每轮重写同一份 .log）：本次写出日志时，
     * 把 log 诊断的 step 标成最后一步算子。陈旧日志不标：那几行是上一轮的事实，
     * 拿本轮的步骤去安在它头上就是编造。
     */
    const engineStep = logStale ? null : lastEngineRule(steps);
    const diagnostics =
      engineStep === null
        ? merged
        : merged.map((entry) =>
            entry.source === "log" && (entry.step === null || entry.step === undefined)
              ? { ...entry, step: engineStep }
              : entry,
          );

    const collected = collectOutputs({
      // 陈旧日志里的 Output written 是上一轮的产物位置，不当本次证据
      logged: logStale ? [] : parsed.outputs,
      dirs: outDirs,
      dir: plan.dir,
      before: outputsBefore,
      runStartedAt,
      primaryName: jobBase,
      outDir: plan.outDir,
      mainDir: dirname(plan.mainPath),
    });
    const primary = collected.outputs.find((output) => output.primary) ?? null;
    const pdfPath = primary !== null && primary.kind === "pdf" ? primary.path : null;
    const pdfFresh = primary !== null && primary.kind === "pdf" && primary.fresh;
    // 回 0 却没 PDF 时要知道「其实写出了中间格式」（dvi-only / 只有 .xdv 的 recipe 不是白编）：
    // 这条只查日志给的路径，**不进 outputs**（.xdv / .dvi 不是给用户开的产物）
    const nonPdfOutput =
      pdfPath === null ? firstNonPdf(logStale ? [] : parsed.outputs, outDirs, plan.dir) : null;
    const upToDate = pdfIsCurrent(pdfPath, plan.mainPath);
    const errors = diagnostics.filter((entry) => entry.kind === "error");
    const warnings = diagnostics.filter((entry) => entry.kind !== "error");

    /** 状态判定补上的合成诊断（超时 / 起不来 / 非零退出）；追加在真诊断之后 */
    const synthetic: LatexIssue[] = [];
    const add = (message: string): void => {
      const entry = issue(message);
      synthetic.push(entry);
      if (entry.kind === "error") errors.push(entry);
      else warnings.push(entry);
    };

    let status: LatexStatus;
    let timeoutKind: LatexTimeoutKind | null = null;
    if (outcome.cancelled) {
      status = "cancelled";
    } else if (outcome.timeout !== null) {
      status = "timeout";
      timeoutKind = outcome.timeout.kind;
      // 静默超时与总时长封顶对模型的下一步不同，文案上就必须分开
      add(timeoutMessage(outcome.timeout));
    } else if (outcome.spawnError !== null) {
      status = "compile-error";
      add(`${failedTool} could not be started: ${outcome.spawnError}`);
    } else if (outcome.code !== 0) {
      status = "compile-error";
      // 陈旧错误不能代替「这一次也失败了」的事实：本次的非零退出码照样要说一遍
      if (errors.length === 0 || logStale) {
        add(`${failedTool} exited with code ${String(outcome.code)}.${stderrTail(outcome.stderr)}`);
      }
    } else if (!upToDate) {
      status = "compile-error";
      if (pdfPath !== null) {
        add(`${pdfPath} was not regenerated (it is older than ${plan.mainName}), so this build produced nothing new.`);
      } else {
        add(missingPdfMessage(nonPdfOutput, outDirs));
      }
    } else if (errors.length > 0) {
      // nonstopmode 会带着错继续排版，latexmk 在部分发行版上仍回 0：log 里的错就是事实
      status = "compile-error";
    } else {
      status = hasContentWarnings(warnings) ? "warning-only" : "ok";
    }

    return {
      status,
      engine: plan.engine,
      engineSource: plan.engineSource,
      root: plan.root,
      command: {
        executable: ranStep.command ?? probe.latexmk,
        args: [...ranStep.argv],
        source: plan.config.recipe === undefined ? "default" : "config",
        cwd: plan.dir,
      },
      steps,
      diagnostics: [...diagnostics, ...synthetic],
      omitted: { ...parsed.omitted },
      outputs: collected.outputs,
      outputsTruncated: collected.truncated,
      candidates: [],
      log:
        picked.path === null || logFile === null
          ? null
          : {
              path: picked.path,
              bytes: logFile.bytes,
              lines: logFile.lines,
              fresh: !picked.stale,
              modifiedAt: logFile.modifiedAt,
              parseTruncated: logFile.truncated,
            },
      main: plan.mainName,
      pdf: pdfPath,
      pdfFresh,
      // 页数只信本次写出的日志：陈旧日志里的页数是上一轮的事实（评审 M3 二版）
      pages: logStale ? null : (primary?.pages ?? null),
      durationMs: Date.now() - started,
      errors,
      warnings,
      // 只有编译失败才带日志尾巴：成功时几千行日志进模型上下文是纯浪费
      logTail: status === "compile-error" ? tailLines(logText, LATEX_LOG_TAIL_LIMIT) : null,
      timeoutKind,
    };
  }

  /**
   * 起 latexmk 并等结果。stdout 只扫进度行（排空管道也防止子进程被背压卡住）。
   *
   * 超时判据是**候选日志的「大小 + mtime」有没有变**（见文件头第 5 条）：任何一份
   * 变了就算活跃；日志被删（轮换）或一份都还没生成时按进程存活处理——那种沉默
   * 不能算在进程头上，交给总时长闸。
   */
  private spawnLatexmk(
    command: string,
    argv: string[],
    cwd: string,
    key: string,
    logPaths: readonly string[],
    /** 步骤时序的收集器（只记 `Run number N of rule 'x'`，不判成败）；清理时为 null */
    steps: RawStep[] | null = null,
    /** 超时闸。默认实例级（300 秒静默 / 10 分钟总长）；清理用同一个 spawn 管线但不看日志 */
    timeouts: { idle: number; total: number } = { idle: this.idleTimeoutMs, total: this.totalTimeoutMs },
  ): Promise<ProcessOutcome> {
    return new Promise((resolvePromise) => {
      let settled = false;
      let stalled = false;
      let timeout: TimeoutInfo | null = null;
      let sawLog = false;
      let watcher: ReturnType<typeof setInterval> | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      /** 各候选日志上一次看到的「大小:mtime」；文件不存在时没有条目 */
      const seen = new Map<string, string>();

      const child = spawn(command, argv, {
        cwd,
        windowsHide: true,
        // POSIX 上自成进程组：杀的时候一次带走 latexmk + 引擎 + bibtex
        detached: process.platform !== "win32",
        // stdout 只用来读进度（latexmk 的 "Run number N of rule 'x'"），其余丢弃
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.set(key, child);

      const spawnedAt = this.now();
      let lastActivityAt = spawnedAt;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
      });
      /*
       * 进度只认 latexmk 每跑一轮打印的 `Run number N of rule 'xelatex'`（引擎与
       * bibtex 各算一轮）。总轮数不可知，所以不编造分母；自定义 recipe 不打印时
       * step 保持 null，界面退回「编译中…」。产物的 stdout 其余内容一律不读
       * （格式随版本变，且一行 .log 已经够诊断）。
       */
      let stdoutTail = "";
      /** 已经记过的最晚一轮（tail 会重复匹配同一条；轮次是 latexmk 的全局计数） */
      let recordedRun: number | null = null;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-4096);
        const matches = [...stdoutTail.matchAll(/Run number (\d+) of rule '([^']+)'/g)];
        for (const match of matches) {
          const run = Number(match[1]);
          if (steps === null || (recordedRun !== null && run <= recordedRun)) continue;
          recordedRun = run;
          steps.push({ rule: match[2] ?? "", run, startedAtMs: this.now() - spawnedAt });
        }
        const last = matches[matches.length - 1];
        if (last === undefined) return;
        this.progress.set(key, { step: last[2] ?? null, run: Number(last[1]) });
      });

      const finish = (outcome: ProcessOutcome): void => {
        if (settled) return;
        settled = true;
        if (watcher !== null) clearInterval(watcher);
        if (graceTimer !== null) clearTimeout(graceTimer);
        this.children.delete(key);
        resolvePromise(outcome);
      };

      const stall = (kind: LatexTimeoutKind, silentMs: number): void => {
        if (stalled) return;
        stalled = true;
        timeout = { kind, silentMs, elapsedMs: this.now() - spawnedAt, sawLog };
        killTree(child);
        // 进程树可能杀不干净（权限 / 句柄）：宽限之后照常回报，别把 agent 的工具调用挂死
        graceTimer = setTimeout(() => {
          finish({
            code: null,
            timeout,
            cancelled: this.cancelled.has(key),
            spawnError: null,
            stderr,
          });
        }, KILL_GRACE_MS);
      };

      watcher = setInterval(() => {
        if (settled) return;
        // 已经自己退出了：等 close 事件，别把「刚好在这时结束」误报成超时
        if (child.exitCode !== null || child.signalCode !== null) return;
        const now = this.now();
        let active = false;
        for (const path of logPaths) {
          const signature = logSignature(path);
          if (signature === null) {
            // 日志被轮换 / 还没生成：删掉记录，不算沉默
            if (seen.delete(path)) active = true;
            continue;
          }
          if (seen.get(path) !== signature) active = true;
          seen.set(path, signature);
          sawLog = true;
        }
        // 一份日志都不存在时按进程存活处理：沉默的起点还没有依据
        if (active || seen.size === 0) lastActivityAt = now;
        const elapsedMs = now - spawnedAt;
        if (elapsedMs >= timeouts.total) {
          stall("total", now - lastActivityAt);
        } else if (now - lastActivityAt >= timeouts.idle) {
          stall("idle", now - lastActivityAt);
        }
      }, this.pollIntervalMs);

      child.on("error", (error: Error) => {
        finish({
          code: null,
          timeout,
          cancelled: this.cancelled.has(key),
          spawnError: error.message,
          stderr,
        });
      });
      child.on("close", (code: number | null) => {
        finish({
          code,
          timeout,
          cancelled: this.cancelled.has(key),
          spawnError: null,
          stderr,
        });
      });
    });
  }
}

function projectKey(dir: string): string {
  // Windows 文件系统大小写不敏感：同一项目的两次请求不该绕过互斥
  return process.platform === "win32" ? dir.toLowerCase() : dir;
}

/**
 * 清理要落的目录。默认产物目录；**自定义 recipe 没写 -outdir 时 aux 在主文件旁边**
 * （与 outputDirs 的候选同源）——到 build/ 去清一个空目录等于什么都没做。
 */
function cleanDirOf(plan: LatexPlan): string {
  const hasOutdir = plan.argv.some((arg) => arg === "-outdir" || arg.startsWith("-outdir="));
  return hasOutdir || plan.rootConfig.recipe === undefined ? plan.outDir : dirname(plan.mainPath);
}

/** `latexmk -c` 的 argv。`-outdir` 必须与编译时一致，否则它找不到那组 aux */
export function cleanArgv(targetDir: string, mainName: string): string[] {
  return ["-c", "-interaction=nonstopmode", `-outdir=${targetDir}`, mainName];
}

/** 目录里的文件名（排序）；目录不存在 / 读不了回 null（= 没编过） */
function listFiles(dir: string): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

/** 前后快照 → removed / kept。removed 为空也是合法结局（本来就没辅助文件） */
export function cleanResult(
  dir: string,
  before: readonly string[],
  after: readonly string[],
  durationMs: number,
): LatexCleanResult {
  const kept = new Set(after);
  return {
    dir,
    removed: before.filter((name) => !kept.has(name)),
    kept: [...after],
    durationMs,
  };
}

/**
 * 「磁盘上的 PDF 是不是这份源码的产物」。PDF 必须存在，且 mtime **不早于**主文件。
 * 用 `>=` 而不是 `>`：FAT / 网络盘的 mtime 粒度可能是 2 秒，一次成功编译
 * 的 PDF 与刚改过的源文件会落在同一个时间片（相等，但 PDF 确实是新的）。
 *
 * 注意它**不是**「这一次重排了」：源文件没改时 latexmk 说 Nothing to do，
 * PDF 的 mtime 不动，这里仍然为 true——那是对的，PDF 确实是最新的。
 * 「本次写出来的」由调用方的 pdfFresh（mtime ≥ 本次 spawn 时刻）表示。
 */
function pdfIsCurrent(pdfPath: string | null, mainPath: string): boolean {
  if (pdfPath === null) return false;
  const pdf = mtimeOf(pdfPath);
  const main = mtimeOf(mainPath);
  return pdf !== null && main !== null && pdf >= main;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 产物候选目录。`plan.outDir` 是默认（我们拼的 default argv 一定带 -outdir），
 * 但自定义 recipe 可能用别的 -outdir 或干脆不传：后两种情况下 log/pdf 在主文件旁边。
 */
function outputDirs(plan: LatexPlan): string[] {
  const dirs: string[] = [plan.outDir];
  for (let index = 0; index < plan.argv.length; index += 1) {
    const arg = plan.argv[index] ?? "";
    if (arg === "-outdir") {
      const next = plan.argv[index + 1];
      if (next !== undefined) dirs.push(resolve(plan.dir, next));
      index += 1;
    } else if (arg.startsWith("-outdir=")) {
      dirs.push(resolve(plan.dir, arg.slice("-outdir=".length)));
    }
  }
  dirs.push(plan.dir);
  return [...new Set(dirs)];
}

/**
 * 产物在哪 —— 日志 + 目录快照两条证据合并。
 *
 * 1. **日志**：`Output written on <path>` 最权威（引擎真正写的文件，可能不在我们
 *    猜的任何一个 outDir 下，评审 M2）。**每一条都收**：一次构建写多份（\include-
 *    standalone / TikZ externalize / 多 target 脚本）时，只认最后一条会把其余产物
 *    藏起来。
 * 2. **目录快照**：只看 outputDirs 的**直接子项**（不递归——递归会在 figures/ 里
 *    捞到旧图，把「本次产物」说错）。它补上「日志里没写、但磁盘上确实变了」的产物
 *    （自定义 recipe / 外部脚本），也让「上一次留下的那份」仍在列表里（fresh:false），
 *    界面才有东西可预览。
 * 3. **primary**：优先 `<outDir>/<jobname|basename>.pdf`（这个 root 的主产物），
 *    否则第一条日志里的 PDF，否则最新 mtime 的 PDF。`-jobname` 编成功时主产物不叫
 *    `<main>.pdf`，所以这里**不再假设文件名**。
 *
 * `.xdv` 不是产物：xelatex 的日志写 `Output written on … .xdv`，随后 xdvipdfmx 写出
 * 同名 `.pdf`；把 xdv 交出去，调用方会拿它当 PDF 打开（xelatex 又是中文主路径）。
 * dvi-only recipe 明确写出 `.dvi` 时给一条 `kind:"other"`，文案复用 missingPdfMessage。
 */
interface CollectedOutputs {
  outputs: LatexOutput[];
  truncated: boolean;
}

interface CollectInput {
  logged: readonly LoggedOutputItem[];
  dirs: readonly string[];
  dir: string;
  /** spawn 前的 PDF 快照：path → mtime（null = 当时不存在） */
  before: ReadonlyMap<string, number | null>;
  runStartedAt: number;
  /** 主产物的名字（jobname，缺省是主文件 basename） */
  primaryName: string;
  outDir: string;
  mainDir: string;
}

function collectOutputs(input: CollectInput): CollectedOutputs {
  const byKey = new Map<string, LatexOutput>();
  const order: string[] = [];
  const freshOf = (path: string): boolean => {
    const mtime = mtimeOf(path);
    if (mtime === null) return false;
    const previous = input.before.get(outputKey(path));
    // 「新出现 / mtime 变了」优先于「mtime ≥ spawn 时刻」：系统时钟被校准时，
    // 刚写的文件也可能早于 spawn 时刻；反过来粗粒度文件系统上两者可能相等。
    return (mtime >= input.runStartedAt) || (previous !== undefined && previous !== null && mtime > previous);
  };

  const put = (path: string, detail: { pages: number | null; bytes: number | null; fromLog: string | null }): void => {
    const key = outputKey(path);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      // 日志比扫描更具体：页数 / 字节数 / 原始写法以日志为准（同一条日志重复写也只会一条）
      if (detail.pages !== null) existing.pages = detail.pages;
      if (detail.bytes !== null) existing.bytes = detail.bytes;
      if (detail.fromLog !== null) existing.fromLog = detail.fromLog;
      return;
    }
    byKey.set(key, {
      path,
      kind: extname(path).toLowerCase() === ".pdf" ? "pdf" : "other",
      primary: false,
      fresh: false,
      pages: detail.pages,
      bytes: detail.bytes,
      modifiedAt: null,
      fromLog: detail.fromLog,
    });
    order.push(key);
  };

  for (const item of input.logged) {
    const resolved = resolveLoggedOutput(item.path, input.dirs, input.dir, freshOf);
    if (resolved === null) continue;
    put(resolved, { pages: item.pages, bytes: item.bytes, fromLog: item.path });
  }
  for (const dir of input.dirs) {
    for (const path of listOutputPdfs(dir)) put(path, { pages: null, bytes: null, fromLog: null });
  }

  for (const output of byKey.values()) {
    output.modifiedAt = mtimeOf(output.path);
    output.fresh = freshOf(output.path);
  }

  const all = order.map((key) => byKey.get(key)).filter((item): item is LatexOutput => item !== undefined);
  const primary = choosePrimary(all, input);
  if (primary !== null) primary.primary = true;

  const sorted = [...all].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    const am = a.modifiedAt ?? 0;
    const bm = b.modifiedAt ?? 0;
    if (am !== bm) return bm - am;
    return a.path.localeCompare(b.path);
  });
  const truncated = sorted.length > LATEX_MAX_OUTPUTS;
  return { outputs: sorted.slice(0, LATEX_MAX_OUTPUTS), truncated };
}

function choosePrimary(outputs: readonly LatexOutput[], input: CollectInput): LatexOutput | null {
  const pdfs = outputs.filter((output) => output.kind === "pdf");
  if (pdfs.length === 0) return null;
  const byName = (dir: string): LatexOutput | undefined => {
    const target = outputKey(join(dir, `${input.primaryName}.pdf`));
    return pdfs.find((output) => outputKey(output.path) === target);
  };
  const freshByName = (dir: string): LatexOutput | undefined => {
    const found = byName(dir);
    return found?.fresh === true ? found : undefined;
  };
  /*
   * 顺序的要点：**本次新写的优先于「名字对得上」**。lualatex 的日志写裸文件名
   * `main.pdf`，而项目根常有一份上一轮留下的 main.pdf；只按 outDir 先到先得，
   * 会把旧文件当主产物、本次真正写出的那份反被忽略（评审 M2 的同一类）。
   */
  const freshInOutDir = freshByName(input.outDir);
  if (freshInOutDir !== undefined) return freshInOutDir;
  const freshInMainDir = freshByName(input.mainDir);
  if (freshInMainDir !== undefined) return freshInMainDir;
  // 本次写出的日志里的 PDF —— 日志顺序就是引擎写出的顺序
  const logged = pdfs.filter((output) => output.fromLog !== null);
  const freshLogged = logged.filter((output) => output.fresh);
  if (freshLogged[0] !== undefined) return freshLogged[0];
  if (logged[0] !== undefined) return logged[0];
  // 最新 mtime（这一轮真写出来的优先）
  const fresh = pdfs.filter((output) => output.fresh).sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  if (fresh[0] !== undefined) return fresh[0];
  return byName(input.outDir) ?? byName(input.mainDir) ?? pdfs[0] ?? null;
}

/**
 * 日志里的产物路径 → 磁盘上真实存在的那个。
 *
 * 绝对路径就它自己。相对路径分两种：带目录前缀（`build/main.pdf`，pdflatex / xelatex
 * 带 -outdir 时的写法）按项目目录解析；**裸文件名**（`main.pdf`，lualatex 就这么写）
 * 既可能在项目目录、也可能在 outdir，所以每个候选目录都试一遍。
 *
 * `.xdv` 跳过，改试同名的 `.pdf`（见 collectOutputs 的注释）。
 */
function resolveLoggedOutput(
  raw: string,
  dirs: readonly string[],
  dir: string,
  freshOf: (path: string) => boolean,
): string | null {
  const candidates = logOutputCandidates(raw, dirs, dir);
  const options: string[] = [];
  for (const candidate of candidates) {
    // `.xdv` 本身不是产物，但它的同名 `.pdf` 是（xdvipdfmx 随后写出）
    if (extname(candidate).toLowerCase() !== ".xdv" && existsSync(candidate)) options.push(candidate);
    const pdf = withPdfExtension(candidate);
    if (pdf !== candidate && existsSync(pdf)) options.push(pdf);
  }
  // 同名候选（build/main.pdf 与 main.pdf）都在时，本次新写的那个才算这次写出的产物
  return options.find(freshOf) ?? options[0] ?? null;
}

/**
 * 日志说「写出了 X」但 X 不是 PDF（dvi-only 的 `.dvi`、只剩中间格式的 `.xdv`）：
 * 把它找出来，好让错误文案说清「编出了东西，只是本应用只收 PDF」。
 */
function firstNonPdf(logged: readonly LoggedOutputItem[], dirs: readonly string[], dir: string): string | null {
  for (const item of logged) {
    for (const candidate of logOutputCandidates(item.path, dirs, dir)) {
      if (!existsSync(candidate)) continue;
      if (extname(candidate).toLowerCase() !== ".pdf") return candidate;
    }
  }
  return null;
}

/** spawn 前的 PDF 快照：outputDirs 的直接子项 → mtime */
function snapshotOutputs(dirs: readonly string[]): Map<string, number | null> {
  const snapshot = new Map<string, number | null>();
  for (const dir of dirs) {
    for (const path of listOutputPdfs(dir)) snapshot.set(outputKey(path), mtimeOf(path));
  }
  return snapshot;
}

/** 目录里的 PDF（直接子项、不递归）；目录不存在 / 读不了回空 */
function listOutputPdfs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".pdf")
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** 产物去重键：Windows 大小写不敏感 */
function outputKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 日志里的产物路径 → 磁盘候选。
 *
 * 绝对路径就它自己。相对路径分两种：带目录前缀（`build/main.pdf`，pdflatex / xelatex
 * 带 -outdir 时的写法）按项目目录解析；**裸文件名**（`main.pdf`，lualatex 就这么写）
 * 既可能在项目目录、也可能在 outdir，所以每个候选目录都试一遍——dirs 里已经含
 * outDir、argv 里的 -outdir 与主文件目录。
 */
function logOutputCandidates(output: string, dirs: readonly string[], dir: string): string[] {
  if (isAbsolute(output)) return [output];
  if (/[\/]/.test(output)) return [resolve(dir, output)];
  return dirs.map((candidate) => join(candidate, output));
}

/** `…/main.xdv` → `…/main.pdf`；本来就是 .pdf（大小写不敏感）的原样返回 */
function withPdfExtension(path: string): string {
  const extension = extname(path);
  if (extension.toLowerCase() === ".pdf") return path;
  return `${path.slice(0, path.length - extension.length)}.pdf`;
}

/**
 * 「回 0 却没有 PDF」到底该说什么。区别很重要：dvi-only 的 recipe 确实编出了东西，
 * 文案要让用户知道不是白编，而不是让他以为引擎什么都没干。
 */
function missingPdfMessage(nonPdfOutput: string | null, dirs: readonly string[]): string {
  if (nonPdfOutput === null) {
    return `latexmk exited with code 0 but no PDF was found (looked in ${dirs.join(", ")}).`;
  }
  return `latexmk exited with code 0 and wrote ${nonPdfOutput}, which is not a PDF — only PDF output is returned (DVI / XDV are intermediate formats). Use pdflatex / xelatex / lualatex, or check the PDF conversion step.`;
}

interface PickedLog {
  path: string | null;
  /** true = 本次没写日志，退回的是上一轮留下的那份 */
  stale: boolean;
}

/**
 * 选要解析的 .log。`before` 是 spawn 前各候选的 mtime（null = 当时不存在）。
 *
 * **不删旧日志、只分辨新旧**：删掉旧日志的写法在「latexmk 判定无事可做、直接失败
 * 退出且不重写日志」时会把诊断信息一起删掉（同一份坏文档连编两次就丢错）。
 * 本次的判据是「mtime 变了或文件新出现」——比拿 `Date.now()` 比更稳：粗粒度文件系统
 * 上重写可能落在同一个时间片，而「stat 过之后再变」不会骗人。
 */
function pickLog(before: ReadonlyMap<string, number | null>): PickedLog {
  let newest: { path: string; mtime: number } | null = null;
  for (const [path, previous] of before) {
    const mtime = mtimeOf(path);
    if (mtime === null) continue;
    if (previous === null || mtime !== previous) return { path, stale: false };
    if (newest === null || mtime > newest.mtime) newest = { path, mtime };
  }
  if (newest !== null) return { path: newest.path, stale: true };
  return { path: null, stale: false };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * 读一份文本，但**只读尾部 LATEX_MAX_LOG_BYTES**（.log / .blg 共用）。
 * 旧版把整份 .log 无上限读进内存：一份失控的自定义 recipe 能写出几百 MB。
 */
function readTextLimited(path: string): string {
  return readLogFile(path).text;
}

interface ReadLogFile {
  text: string;
  /** 文件大小（字节）；stat 失败时为 0 */
  bytes: number;
  /** 我们解析到的文本有多少行 */
  lines: number;
  modifiedAt: number | null;
  /** true = 文件超过上限，只读了尾部 */
  truncated: boolean;
}

/**
 * 读一份日志 / .blg。超过 `LATEX_MAX_LOG_BYTES` 时只读尾部并置 truncated，
 * 而且丢掉被切开的半行（从第一个换行之后开始）——否则解析器会把半行当成一条诊断。
 */
export function readLogFile(path: string, maxBytes: number = LATEX_MAX_LOG_BYTES): ReadLogFile {
  let bytes = 0;
  let modifiedAt: number | null = null;
  try {
    const stat = statSync(path);
    bytes = stat.size;
    modifiedAt = stat.mtimeMs;
  } catch {
    return { text: "", bytes: 0, lines: 0, modifiedAt: null, truncated: false };
  }
  if (bytes <= maxBytes) {
    const text = readText(path);
    return { text, bytes, lines: lineCount(text), modifiedAt, truncated: false };
  }
  const raw = readTailBytes(path, maxBytes);
  const cut = raw.indexOf("\n");
  const text = cut === -1 ? "" : raw.slice(cut + 1);
  return { text, bytes, lines: lineCount(text), modifiedAt, truncated: true };
}

/** 读文件最后 maxBytes 字节（open/read 分块，不把整份文件映进内存） */
function readTailBytes(path: string, maxBytes: number): string {
  const handle = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const chunk = readSync(handle, buffer, read, buffer.length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(handle);
  }
}

/** 与 parseLatexLog 的 `split(/\r?\n/)` 同一口径，日志行号才对得上 */
function lineCount(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

/**
 * 日志尾巴：**从行首截起**（旧版 `slice(-limit)` 会把第一行切成半句，模型看到
 * `7 compressed objects within 1 object str` 会以为是日志的怪话），并给出 fromLine
 * ——模型据此能 `read offset=fromLine-200` 往前翻。
 */
export function tailLines(text: string, limit: number): LatexLogTail | null {
  if (text === "") return null;
  if (text.length <= limit) return { text, fromLine: 1, truncated: false };
  const cut = text.length - limit;
  const newline = text.indexOf("\n", cut);
  const start = newline === -1 ? cut : newline + 1;
  const body = text.slice(start);
  const total = lineCount(text);
  const count = lineCount(body);
  return { text: body, fromLine: Math.max(1, total - count + 1), truncated: true };
}

/** `.blg` 路径：按产物目录顺序取第一份存在的（与本轮 -outdir 同序） */
function findBlg(outDirs: readonly string[], jobBase: string): string | null {
  for (const dir of outDirs) {
    const candidate = join(dir, `${jobBase}.blg`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 把 .blg 的诊断并进日志诊断：**按（文件，行）合并排序**，未知位置排最后。
 * 同一键保持原来的日志顺序（稳定排序）——模型按位置从上往下修，而 refs.bib:5 与
 * main.tex:3 是两份不同的文件，混在一起按日志文件顺序排反而看不出位置关系。
 */
function mergeDiagnostics(log: readonly LatexIssue[], blg: readonly LatexIssue[]): LatexIssue[] {
  if (blg.length === 0) return [...log];
  return [...log, ...blg]
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => comparePlace(left.issue, right.issue) || left.index - right.index)
    .map((entry) => entry.issue);
}

function comparePlace(left: LatexIssue, right: LatexIssue): number {
  const leftFile = left.file ?? "\uffff";
  const rightFile = right.file ?? "\uffff";
  if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
  return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
}

/** 最后一步里跑引擎的那一轮（日志就是它写的）；没有进度行时为 null */
function lastEngineRule(steps: readonly LatexBuildStep[]): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const rule = steps[index]?.rule ?? "";
    if (/^(?:pdf|xe|lua)?latex$/i.test(rule)) return rule;
  }
  return null;
}

/** 一条还没定出时长的步骤（spawnLatexmk 收集，build 收尾时算时长） */
export interface RawStep {
  rule: string;
  run: number | null;
  startedAtMs: number;
}

/**
 * 把时序事实补全：`durationMs` = 下一步的开始 - 本步的开始；最后一步算到进程退出。
 * **不造 per-step 退出码**：latexmk 不逐轮报，写成 bool 会是一条编造的事实。
 */
export function finalizeSteps(raw: readonly RawStep[], elapsedMs: number): LatexBuildStep[] {
  return raw.map((step, index) => {
    const next = raw[index + 1];
    const durationMs =
      next === undefined ? Math.max(0, elapsedMs - step.startedAtMs) : Math.max(0, next.startedAtMs - step.startedAtMs);
    return {
      rule: step.rule,
      run: step.run,
      startedAtMs: step.startedAtMs,
      durationMs,
      end: next === undefined ? "last" : "ran",
    };
  });
}

function issue(message: string): LatexIssue {
  return { file: null, line: null, message, kind: "error" };
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : ` ${trimmed.slice(-STDERR_LIMIT)}`;
}

function cancelledResult(
  root: LatexResult["root"],
  engine: LatexEngine,
  started: number,
  engineSource: LatexEngineSource = "auto",
): LatexResult {
  return {
    ...emptyResult("cancelled", engine, started, [], [], engineSource),
    root,
    main: root?.path ?? "",
  };
}

/**
 * 「连 latexmk 都没起来 / 没开始编」的结果骨架。root / outputs 留空——
 * 这几个状态要回答的是「为什么没编」，不是「编出了什么」。
 */
function emptyResult(
  status: LatexStatus,
  engine: LatexEngine,
  started: number,
  errors: LatexIssue[],
  candidates: string[] = [],
  engineSource: LatexEngineSource = "auto",
): LatexResult {
  return {
    status,
    engine,
    engineSource,
    root: null,
    command: null,
    steps: [],
    diagnostics: [...errors],
    omitted: { errors: 0, warnings: 0, layout: 0 },
    outputs: [],
    outputsTruncated: false,
    candidates,
    log: null,
    main: "",
    pdf: null,
    pdfFresh: false,
    pages: null,
    durationMs: Date.now() - started,
    errors,
    warnings: [],
    logTail: null,
    timeoutKind: null,
  };
}

/**
 * 日志的判活签名：大小 + mtime。TeX 引擎每写一块日志这两者至少有一个变——
 * 只看 mtime 会在粗粒度文件系统上把「同一秒内的大量输出」当成沉默。
 */
function logSignature(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * 超时的两句文案：只陈述“我们观察到了什么”，不断言原因。
 * - idle：没新日志输出。可能是长时间计算、等交互输入，也可能真是死循环——
 *   日志按 4 KiB 块落盘，合法编译也会长时间不动，所以不能写成“死循环”。
 * - total：到了总时长上限。日志可能一直在长，也可能根本没写（自定义 recipe），
 *   所以按 sawLog 分成两句，不说“它一直在写日志”。
 */
function timeoutMessage(timeout: TimeoutInfo): string {
  if (timeout.kind === "idle") {
    return (
      `编译连续 ${seconds(timeout.silentMs)} 秒没有新的日志输出` +
      "（可能是长时间计算、等待输入，或死循环），已终止整棵进程树。"
    );
  }
  if (!timeout.sawLog) {
    return (
      `编译到达总时长上限（用时 ${seconds(timeout.elapsedMs)} 秒），且没有可用的日志输出` +
      "（自定义 recipe 可能不写 .log），已终止整棵进程树。"
    );
  }
  return (
    `编译到达总时长上限（用时 ${seconds(timeout.elapsedMs)} 秒），已终止整棵进程树：` +
    "文档在这段时间内没有编完。拆小文档或稍后重试。"
  );
}

/**
 * 杀掉整棵进程树。Windows 走 `taskkill /T /F`（同 terminal/runtime.ts 的理由：
 * ConPTY / latexmk 都会 fork 出孙进程）；POSIX 走进程组（spawn 时 detached）。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    // 杀不掉（进程已退出）不是错：close 事件会照常到来
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
