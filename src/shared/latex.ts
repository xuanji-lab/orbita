/**
 * LaTeX 编译域契约 —— 也是 agent 工具 `compile_latex` 的载荷形状。
 *
 * 一条链路、一个内核（main/latex/）：agent 进程 → `latexRequest` / `latexResult`
 * （shared/agent-ipc.ts，terminalRequest 同款）。renderer 的 IPC 面（`latex:compile` /
 * `latex:probe`）与 preload 等 PR3 有界面时再加——现在没有调用点，按消费者纪律
 * 不进仓（评审 M6）。
 *
 * **编译在主进程**：latexmk 是外部进程，产物落在项目目录里（`build/`），
 * agent 进程既不碰 fs 策略也不该持有一份「哪个项目在编」的并发状态。主进程是
 * 唯一真源，agent 进程只剩「工具定义 → requestId 问答」一层薄包装——
 * 与 browser_* / terminal_* 同一条边界。
 *
 * 为什么内核交给 latexmk，而不是自己数「先 pdflatex、再 bibtex、再 pdflatex×2」：
 * 文献 / 交叉引用 / 索引的轮次由 latexmk 按 .aux/.bbl 的依赖自己判断，我们手写的
 * 轮次表在真实论文上一会儿漏 bibtex、一会儿多跑一遍；而 latexmk 的 `-pvc` 之外
 * 的行为在三大发行版上一致，出问题时它的 .log 与我们的解析器是同一份证据。
 */

/**
 * 引擎只是 latexmk 的一个开关（-pdf / -xelatex / -lualatex）。
 * 名字取开关的后半段，便于直接拼 argv。
 */
export const LATEX_ENGINES = ["pdf", "xelatex", "lualatex"] as const;
export type LatexEngine = (typeof LATEX_ENGINES)[number];

export function isLatexEngine(value: unknown): value is LatexEngine {
  return typeof value === "string" && (LATEX_ENGINES as readonly string[]).includes(value);
}

/**
 * 一次编译的结局。**没有 "busy"**：并发被拒（同项目在编 / 全局已满）不是编译结局，
 * 走 `LatexRunOutcome` 的 `{ ok: false, reason }` 分支——那时我们连 latexmk 都没起，
 * 把它报成某个 status 会让界面显示一次不存在的编译。
 */
export type LatexStatus =
  | "ok"
  /** 出了 PDF，但有非版式类告警（缺字体、未定义引用……） */
  | "warning-only"
  /** latexmk 非零退出，或退出 0 但没产出新 PDF */
  | "compile-error"
  /** 超时被杀。**为什么超时看 `timeoutKind`**：日志静默卡住 vs 总时长封顶 */
  | "timeout"
  /** 被取消（应用退出：runner.cancelAll） */
  | "cancelled"
  /** 本机没有 latexmk（探测失败） */
  | "not-installed"
  /** 找不到主文件，或候选不唯一 */
  | "no-main-file";

/**
 * 日志里的一条。`kind` 是**给界面/模型看的分类**，不改变它待在哪个数组里：
 * - "error"：真错（`!` 开头的 TeX 错、`file:line:`、Emergency stop / Fatal error）
 * - "warning"：LaTeX/Package 告警、缺字符、缺字体
 * - "layout"：Overfull / Underfull \hbox|\vbox
 *
 * 版式问题单列 kind 的理由：真实论文几乎每一篇都有 Overfull hbox，
 * 若把它算进 `warning-only`，status 就永远是 warning-only，那个状态失去信息量。
 * 它仍然留在 warnings 数组里（模型/界面一处就能读全），只是不决定 status。
 */
export type LatexIssueKind = "error" | "warning" | "layout";

export interface LatexIssue {
  /** 相对项目目录的文件名（如 "main.tex" / "sections/intro.tex"）；归属不明时 null */
  file: string | null;
  /** 1 基行号；日志没给时 null（缺包一类的错常常只有文件没有行） */
  line: number | null;
  message: string;
  kind: LatexIssueKind;
}

/** 一次编译结果。主进程组装，agent 工具直接消费 */
export interface LatexResult {
  status: LatexStatus;
  engine: LatexEngine;
  /** 主文件名（相对项目目录），如 "main.tex" */
  main: string;
  /**
   * 磁盘上的 PDF **绝对路径**；根本没有时 null。它可能是**上一次编译**留下的——
   * 判断「这一次写出来的」看 `pdfFresh`，不要看它是否为 null。
   */
  pdf: string | null;
  /**
   * `pdf` 是否由本次编译写出（mtime ≥ 本次 spawn 时刻）。false + pdf 非 null =
   * 磁盘上是旧产物（可能已过期）；模型文案靠它区分「这一次的 PDF」与「上一次的」。
   */
  pdfFresh: boolean;
  /**
   * 日志里 `Output written on … (N pages` 的 N，**只来自本次编译写出的 .log**。
   * 本次没写日志（logStale）时为 null——上一轮的页数不是这一次的事实。
   */
  pages: number | null;
  durationMs: number;
  errors: LatexIssue[];
  warnings: LatexIssue[];
  /**
   * 本次编译没有写出新的 .log，errors / warnings 来自上一轮留下的那份。
   * 典型场景：同一份坏文档连编两次——latexmk 读 .fdb_latexmk 判定无事可做、
   * 直接失败退出且不重写日志。错误照常返回（它多半就是失败原因），但模型要知道
   * 证据的来源；pages 不会从陈旧日志里取。
   */
  logStale: boolean;
  /**
   * 编译失败时的日志尾巴（≤ 8 KB，见 LATEX_LOG_TAIL_LIMIT）。**只在
   * status === "compile-error" 时非 null**——成功时把几千行日志塞进模型上下文
   * 是纯浪费（warnings 已经足够）。
   */
  logTail: string | null;
  /**
   * 超时的具体原因，`status === "timeout"` 时非 null：
   * - "idle"：日志连续 LATEX_IDLE_TIMEOUT_MS 没有新的落盘变化 —— 可能是长时间
   *   计算、等交互输入，或真的死循环。**不能据此断言是死循环**：TeX 的 .log 按
   *   4 KiB 块落盘，合法但耗时的编译可以让 stat 连续几分钟不变（见常量注释）
   * - "total"：总时长到达 LATEX_TOTAL_TIMEOUT_MS —— 文档在这段时间内没编完；
   *   日志可能一直在长，也可能根本没写（自定义 recipe）
   *
   * 两者对模型的下一步动作不同（先判断是不是真卡住 vs 拆文档/换机器），
   * 所以不能只报 timeout。
   */
  timeoutKind: LatexTimeoutKind | null;
}

/** 超时的两种原因，见 LatexResult.timeoutKind */
export type LatexTimeoutKind = "idle" | "total";

/**
 * 编译请求。`dir` 是**项目目录**（.tex 所在目录）：agent 侧相对会话 cwd 解析，
 * `main` / `engine` 是显式覆盖——缺席时由 .orbita/latex.json > magic comment >
 * 目录里的 main.tex > 唯一 .tex 决定。
 */
export interface LatexCompileRequest {
  dir?: string;
  main?: string;
  engine?: LatexEngine;
}

/**
 * 并发被拒的原因。**它不是 LatexStatus**（同 LatexStatus 的注释：那时连 latexmk
 * 都没起），但界面 / 工具要能区分「等一会儿再试」与「参数不对」：
 * - "same-project"：同一项目已有编译在跑，两次 latexmk 抢同一组 .aux 会互相写坏
 * - "busy"：全局并发已满。低内存机（≤ 16 GiB）上限是 1，宽内存机是 2。
 *   **明确拒绝，不排队**：排队会让模型以为工具卡住，且两个 latexmk 在无风扇机型上
 *   会一起被降频，比直接拒绝慢得多。
 */
export type LatexRejectReason = "same-project" | "busy";

/**
 * 编译的对外结局。**并发被拒、目录不存在一类"没开始编"的失败走这里**，
 * 不伪装成一次编译结果（同 LatexStatus 的注释）。
 *
 * `reason` 只在「请求本身合法、但当前不能编」时给（并发被拒）；参数 / 授权校验
 * 失败没有它——那种失败不是「稍后重试」能解决的。
 */
export type LatexRunOutcome =
  | { ok: true; result: LatexResult }
  | { ok: false; error: string; reason?: LatexRejectReason };

/**
 * 探测结果。`latexmk` 是发现的可执行文件：PATH 命中时就是名字本身（spawn 时由
 * OS 再解析一次），常见根命中时是绝对路径。`source` 说明它从哪来。
 */
export interface LatexProbeResult {
  ok: boolean;
  latexmk: string | null;
  /** `latexmk --version` 里的版本那一行（找不到时 null） */
  version: string | null;
  /** 与 latexmk 同目录 / PATH 上找到的引擎。空数组 + ok=true 只可能是发行版缺组件 */
  engines: LatexEngine[];
  source: "path" | "common" | "setting" | null;
  /** 失败原因（给界面与模型看的一句话） */
  message: string;
}

/**
 * 判「卡住」的静默上限：日志连续这么久没有新的落盘变化就终止整棵进程树。
 *
 * **为什么是 300 秒而不是 issue 里写的 90 秒**：90 秒已被真机实测证伪。TeX 把
 * .log 按 **4 KiB 块** 落盘（不是每行 flush），合法但耗时的编译可以在几十分钟内
 * 一直看着“没动静”：评审用真 lualatex `\directlua` 文档实测，编译期间 stat
 * 连续 **105 秒恒为 4096 字节、mtime 不动**，结束时才变；同一文档 idle=590s 时
 * **256.8 秒成功出 PDF**，idle=90s 时 **93.1 秒被杀并误报“死循环”**。
 * 所以宁可在 5 分钟后才判卡，也不误杀一次四分钟的合法编译。
 *
 * 判活信号仍是日志的增长 / mtime，但结论只能是“没有新输出”，不是“死循环”
 * （文案与 timeoutKind 都按这个写）；总时长闸（LATEX_TOTAL_TIMEOUT_MS）兜底。
 */
export const LATEX_IDLE_TIMEOUT_MS = 300_000;

/**
 * 单次编译的总时长上限。静默判定之外的第二道闸：一直有输出也不能永远编下去
 * （超大文档、递归 \input）。真实论文（含 bibtex 多轮）通常 10–60 秒量级。
 */
export const LATEX_TOTAL_TIMEOUT_MS = 10 * 60_000;

/** 失败时回给模型的日志尾巴长度 */
export const LATEX_LOG_TAIL_LIMIT = 8 * 1024;

/** 日志解析的条目上限（errors / warnings 各自）。坏日志可以有上万条 Overfull */
export const LATEX_MAX_ISSUES = 200;

/**
 * 「低内存机」阈值：16 GiB。
 *
 * 单位换算写清（这里差一个数量级就是误判）：硬件标称的 16 GB 指 16 GiB =
 * 16 × 1024³ = 17,179,869,184 字节，而 `os.totalmem()` 报的也是字节——但固件 /
 * 内核会保留一点，**16 GB 机器实测报值略小于 17.18e9**。所以阈值按 16 GiB 取、
 * 用 `<=` 判；要是按十进制的 16,000,000,000 判，真正的 16 GB 机器会漏过去、
 * 32 GB 机器（34.36e9）也不会被误判。
 */
const LOW_MEMORY_BYTES = 16 * 1024 ** 3;

/** 宽内存机（> 16 GiB）同时编译的项目数。两个 latexmk 已经能把笔记本 CPU 吃满 */
const MAX_CONCURRENT_WIDE = 2;

/** 低内存机（≤ 16 GiB）同时编译的项目数：无风扇机型跑两个会降频，宁可拒绝也不排队 */
const MAX_CONCURRENT_LOW_MEMORY = 1;

/**
 * 这台机器能同时跑几个编译。判据只有 `os.totalmem()`（不去读硬件型号：同一型号
 * 有不同的内存配置，读型号既不可靠也平台相关）。
 */
export function latexMaxConcurrent(totalMemoryBytes: number): number {
  return totalMemoryBytes > LOW_MEMORY_BYTES ? MAX_CONCURRENT_WIDE : MAX_CONCURRENT_LOW_MEMORY;
}

/** 默认产物目录（相对项目目录）。名字固定成 build/，与 .gitignore 惯例一致 */
export const LATEX_DEFAULT_OUT_DIR = "build";

/** 项目级配置文件的相对路径（相对项目目录） */
export const LATEX_CONFIG_PATH = ".orbita/latex.json";
