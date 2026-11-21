/**
 * LaTeX 编译域契约 —— 也是 agent 工具 `compile_latex` 的载荷形状。
 *
 * 一条链路、一个内核（main/latex/）：agent 进程 → `latexRequest` / `latexResult`
 * （shared/agent-ipc.ts，terminalRequest 同款）；renderer 的文件面板 → `latex:*`
 * （下面的 latexChannels，PR3 的编译条是第一个消费者）。两条入口走同一份
 * `LatexRunner` 与同一套 .log 解析，不是第二套内核。
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
  | "no-main-file"
  /**
   * `% !TEX root` 指向的文件不在授权根（文件面板的白名单根 / 会话授权目录）里。
   * **它不是一次编译失败**：我们拒绝把工作目录与产物目录指到根外（TeX 能 \input
   * 任意文件，编一个根外的文档等于读那些文件），所以根本没起 latexmk。
   */
  | "root-outside-workspace";

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

/**
 * 一条诊断的**类别**（给模型分支用；界面仍按 `kind` 分三组，不看它）。
 * 解析器本来就用正则认这些形态，只是以前把结论丢掉了——模型只能靠 message 猜。
 */
export type LatexDiagnosticCode =
  /** 缺命令 / 命令打错：`! Undefined control sequence.` */
  | "undefined-control-sequence"
  /** 缺包：`! LaTeX Error: File `x.sty' not found.` */
  | "missing-package"
  /** 缺图 / 缺 \input 目标：`Package … File `fig.pdf' not found` */
  | "missing-file"
  /** `LaTeX Warning: Citation `k' … undefined` */
  | "citation-undefined"
  /** `LaTeX Warning: Reference `x' … undefined`（label 真的不存在；「要重跑」由 latexmk 自己补） */
  | "reference-undefined"
  /** fontspec / xeCJK 的字体不存在、`Missing character`、`Font … not loadable` */
  | "font-missing"
  /** Overfull / Underfull \hbox|\vbox */
  | "layout"
  /** Emergency stop / Fatal error —— 通常是上面某一条的后果 */
  | "emergency-stop"
  /** latexmk 自己的失败行（Missing bbl file / runscript.tlu … failed） */
  | "tool-failure"
  /** .blg 里的 bibtex / biber 失败（`Illegal end of database file---line 5 of file refs.bib`） */
  | "bib-error"
  | "other";

/** 这条诊断是哪一份证据写的：TeX 日志 / bibtex-biber 的 .blg / chktex */
export type LatexDiagnosticSource = "log" | "blg" | "chktex";

export interface LatexIssue {
  /** 相对项目目录的文件名（如 "main.tex" / "sections/intro.tex"）；归属不明时 null */
  file: string | null;
  /** 1 基行号；日志没给时 null（缺包一类的错常常只有文件没有行） */
  line: number | null;
  /** 单行、去行首 `! `、**折行已拼回**（TeX 按 79 列折行，第 2 行起是 `(pkg)` 续行） */
  message: string;
  /** 严重度。**不改名**：13 个文件、81 处引用都读它 */
  kind: LatexIssueKind;
  /** 类别（见 LatexDiagnosticCode）。合成出来的诊断（超时 / 起不来）没有它 */
  code?: LatexDiagnosticCode;
  /** 1 基列号。**只有 chktex 有**（TeX 日志不给列），其余为 null */
  column?: number | null;
  /** 谁写的这一行；合成诊断没有它 */
  source?: LatexDiagnosticSource;
  /** 哪一步产生的（日志里的引擎名 / "bibtex" / "biber"）；认不出时 null */
  step?: string | null;
  /**
   * 日志里的原始块：≤ 4 行、≤ 400 字符，**含 `l.N …` 那一行**（出错的 token 只在这里出现）。
   * 只有前 LATEX_RAW_ERRORS 条 error 有，其余为 null（预算）。
   */
  raw?: string | null;
}

/**
 * 一个编译根的来源。界面 chip 的副标题与 agent 回执都读它——
 * 「为什么这一份被选中」是用户与模型都要能问的问题（静默猜错是最坏的一类 bug）。
 */
export type LatexRootSource =
  /** 调用方显式给的 main（agent / chip 点选 / 「忽略 magic」） */
  | "request"
  /** 当前文件头部的 `% !TEX root`（declaredBy 说明写在哪） */
  | "magic"
  /** `.orbita/latex.json` 的 activeRoot */
  | "active"
  /** `.orbita/latex.json` 的旧字段 main（读时迁移） */
  | "config"
  /** 目录里约定俗成的 main.tex */
  | "convention"
  /** 顶层唯一 .tex */
  | "unique"
  /** 当前打开的文件自己就是一份 `\documentclass` 文档 */
  | "focus"
  /** 递归 ≤2 层里唯一带 `\documentclass` 的 .tex */
  | "scan";

/** 引擎是怎么定下来的（请求 > magic > 配置 > 自动，见 resolve.ts） */
export type LatexEngineSource = "request" | "magic" | "config" | "auto";

/**
 * 一个可编译的根：一份主文件 + 它自己的产物目录 / jobname。
 *
 * **读者**：编译条的 root chip（path / source / declaredBy / outDir）、agent 回执、
 * 产物定位。**写者**：resolve.ts（编译时）与 project.ts（描述时）。
 */
export interface LatexRootRef {
  /** 相对项目目录（正斜杠），如 "paper/main.tex"；magic 指到项目外时可能是 "../x.tex" */
  path: string;
  source: LatexRootSource;
  /** source === "magic" 时：声明写在哪（相对项目目录 + 1 基行号）；其它来源为 null */
  declaredBy: { file: string; line: number } | null;
  engine: LatexEngine;
  engineSource: LatexEngineSource;
  /** 产物目录绝对路径（= latexmk 的 -outdir） */
  outDir: string;
  /** 产物目录相对项目目录（正斜杠）——界面只显示这个，不显示机器路径 */
  outDirRelative: string;
  /** latexmk 的 -jobname；未配置为 null（= 主文件 basename） */
  jobname: string | null;
}

/**
 * 一份产物。真源是 `LatexResult.outputs`；`pdf` / `pages` 只是 primary 的镜像，
 * 留一个 release 给现有调用点。
 */
export interface LatexOutput {
  /** 绝对路径（去重键） */
  path: string;
  /** 目前只有 dvi-only / 自定义 recipe 明确写出的非 PDF 会是 "other" */
  kind: "pdf" | "other";
  /** 是不是这个 root 的主产物（至多一个 true） */
  primary: boolean;
  /** 本次写出（mtime ≥ spawn 时刻）。false = 磁盘上的旧产物 */
  fresh: boolean;
  /** 来自日志 `Output written on … (N pages`；扫描发现但没有日志行时为 null */
  pages: number | null;
  bytes: number | null;
  modifiedAt: number | null;
  /** 日志里的原始写法（"build/main.pdf" / "main.pdf"）；来自扫描为 null */
  fromLog: string | null;
}

/**
 * 一次构建里跑过的一步（latexmk stdout 的 `Run number N of rule 'x'`）。
 * **只记时序事实，不判成败**：latexmk 不逐轮报退出码，写成 bool 会是编造的事实。
 */
export interface LatexBuildStep {
  /** 规则名（`pdflatex` / `xelatex` / `bibtex` / `biber`）；自定义 recipe 只有它的第一条 */
  rule: string;
  /** latexmk 的轮次（同一条规则会跑多轮：pdflatex → bibtex → pdflatex） */
  run: number | null;
  /** 相对本次构建开始（ms） */
  startedAtMs: number;
  /** 下一步的开始 - 本步的开始；最后一步算到进程退出。未知为 null */
  durationMs: number | null;
  /** "last" = 构建在这一步之后结束（失败时它就是停下来那一步）；"ran" = 后面还有步骤 */
  end: "ran" | "last";
}

/** 实际跑的命令。模型要能「照着改配方」，就必须看见现在这条 */
export interface LatexCommand {
  /** 绝对路径（探测到的 latexmk）或 recipe[0]（PATH 上的名字） */
  executable: string;
  args: string[];
  /** default = 我们拼的 latexmk 链；config = `.orbita/latex.json` 的 recipe */
  source: "default" | "config";
  /** 子进程 cwd（= 主文件所在目录；magic root 会改写它） */
  cwd: string;
}

/** 本次解析的日志。**取代 logPath / logStale**（不要两个真源） */
export interface LatexLogRef {
  /** 绝对路径 */
  path: string;
  /** 文件大小（字节） */
  bytes: number;
  /**
   * 我们解析到的文本有多少行。`parseTruncated === false` 时这是整份文件；
   * 为 true 时只是尾部的那一段（`read` 的 offset 要按尾部算）。
   */
  lines: number;
  /** 本次构建写出的？false = 上一轮留下的（旧字段 logStale 的反面） */
  fresh: boolean;
  /** 文件 mtime（ms）——「这些错误是几点的」唯一直接证据 */
  modifiedAt: number | null;
  /** 日志超过 LATEX_MAX_LOG_BYTES，只解析了尾部：诊断可能不全（不许静默） */
  parseTruncated: boolean;
}

/** 日志尾巴：从**行首**截起，并告诉模型它是从第几行开始的 */
export interface LatexLogTail {
  text: string;
  /** text 第一行在**被解析文本**里的行号（1 基）；可以 `read offset=fromLine-200` 往前翻 */
  fromLine: number;
  /** text 只是日志的一部分 */
  truncated: boolean;
}

/**
 * 一次编译结果。主进程组装，agent 工具直接消费。
 *
 * **字段顺序 = 读者顺序**：status → root（这一次编的哪份）→ 诊断 / 产物（写出来什么）。
 * 诊断的唯一真源是 `diagnostics`；`errors` / `warnings` 是按 kind 的便捷镜像（保留一个 release）。
 */
export interface LatexResult {
  status: LatexStatus;
  engine: LatexEngine;
  /** 引擎是怎么定下来的（请求 / magic / 配置 / 自动）——正文要说「为什么是 xelatex」 */
  engineSource: LatexEngineSource;
  /** 这一次编的根。status 是 no-main-file / root-outside-workspace 时为 null */
  root: LatexRootRef | null;
  /** 实际跑的命令；no-main-file / not-installed 时为 null（那时没跑） */
  command: LatexCommand | null;
  /** 跑过的步骤（时序）；自定义 recipe 不打印进度行时为空数组 */
  steps: LatexBuildStep[];
  /**
   * 全部诊断，**日志顺序**（= 因果顺序，模型从上往下修），.blg 的条目按其位置并入。
   * 它是唯一真源；`errors` / `warnings` 只是按 kind 的镜像。
   */
  diagnostics: LatexIssue[];
  /** 每种 kind 因上限没列出的条数（0 = 没截） */
  omitted: { errors: number; warnings: number; layout: number };
  /** 本次构建认定的全部产物（≤ LATEX_MAX_OUTPUTS，多的置 outputsTruncated） */
  outputs: LatexOutput[];
  outputsTruncated: boolean;
  /** 没有 root 时的候选（`no-main-file` 的界面 / 模型出口） */
  candidates: string[];
  /** 本次解析的日志；一份都没有时 null */
  log: LatexLogRef | null;

  /* ── 便捷镜像（保留一个 release，第三个消费者改完后删） ── */
  /** = 主文件名（相对 plan.dir ≈ 引擎工作目录，日志里的 file:line 也是这个基准）；没有 root 时 "" */
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
   * primary 的页数，**只来自本次编译写出的 .log**。本次没写日志（`log.fresh === false`）
   * 时为 null——上一轮的页数不是这一次的事实。
   */
  pages: number | null;
  durationMs: number;
  /** 镜像：= diagnostics 里的 kind === "error"。旧消费者一个 release 后改读 diagnostics */
  errors: LatexIssue[];
  /** 镜像：= diagnostics 里的非 error（含 layout）。旧消费者一个 release 后改读 diagnostics */
  warnings: LatexIssue[];
  /**
   * 编译失败时的日志尾巴（≤ LATEX_LOG_TAIL_LIMIT，**按行首截**）。**只在
   * status === "compile-error" 时非 null**——成功时把几千行日志塞进模型上下文
   * 是纯浪费（warnings 已经足够）。
   */
  logTail: LatexLogTail | null;
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
  /**
   * 刚编辑的那个 .tex（相对 dir 或绝对路径）。它头部连续 `%` 行里的 `% !TEX root`
   * 会被采用——与面板编译走同一条解析（resolve.ts 一处实现），模型不必自己读 magic。
   */
  file?: string;
  engine?: LatexEngine;
  /**
   * 允许 root / magic 目标落在其中的目录（授权根）。缺席时用 dir 自己。
   * 越界的目标让编译以 `root-outside-workspace` 失败，**绝不把 cwd / outDir 指到根外**。
   */
  boundary?: readonly string[];
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
  /**
   * 按探测顺序找过的目录（PATH 各段 + 常见安装根）。**未装时界面要回答
   * 「找过哪里」**——只说「没找到」会让人怀疑我们根本没去装好的地方看一眼。
   * 命中的目录也在里面（它是最后一个、也是真正找到的那个）。
   */
  searched: string[];
}

/**
 * 探测请求。两个动作都只属于「TeX 未安装引导卡」：
 * - `refresh`：用户说「已经装好了」，作废进程缓存再找一遍（否则会拿到启动时的旧结论）
 * - 现验一个路径不是这里的事：那是 `latex:locate`（系统文件选择器 + `--version` 现验）
 */
export interface LatexProbeRequest {
  refresh?: boolean;
}

/** 设置页 preflight 的一项环境检查（真实探测，不是写死的） */
export interface LatexEnvCheckItem {
  id: "synctex" | "chktex" | "pandoc";
  ok: boolean;
  /** 找到的路径 / 版本，或缺失时的一句话说明 */
  detail: string;
}
export interface LatexEnvCheckResult {
  items: LatexEnvCheckItem[];
}

/** PDF 选区批注（论文工作台）：选中文字 + 页码 + 页内坐标 + 意见。
 * 存在项目目录 .orbita/annotations.json（原子写）；锚点用 quote + 页内坐标定位，
 * SyncTeX 反查是可选增强（本机 TinyTeX 缺 synctex 时降级为 quote + 页码）。 */
export interface PdfAnnotation {
  id: string;
  quote: string;
  page: number;
  /** 选区在页面上的归一化矩形（0–1，相对页宽页高）；多行时多段 */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  comment: string;
  createdAt: number;
}
export interface PdfAnnotationStore {
  version: 1;
  annotations: PdfAnnotation[];
}

/**
 * 「指定位置」的结局：系统文件选择器 → 现验 `--version` → 通过才写进设置。
 * `invalid` 只说事实（这个文件不是能跑的 latexmk），文案由界面用自己的语言说。
 */
export type LatexLocateOutcome =
  | { kind: "cancelled" }
  | { kind: "ok"; path: string }
  | { kind: "invalid"; path: string };

/**
 * 一次「清理辅助文件」的结果。
 *
 * `removed` / `kept` 是**产物目录在清理前后的差集**，不是 latexmk 的自述：它只会说
 * "Cleaned"，不报删了哪几份；界面要能说出「删了 6 个文件、PDF 还在」。只列文件名
 * （相对产物目录），目录本身不算。
 */
export interface LatexCleanResult {
  /** 清单来自哪个产物目录（绝对路径）——toast 里说清是哪一处 */
  dir: string;
  /** 被删掉的文件名（排序） */
  removed: string[];
  /** 清理后仍在产物目录里的文件名（通常就是 pdf 与外部生成图） */
  kept: string[];
  durationMs: number;
}

/**
 * 清理的对外结局。并发被拒与编译同一套 `LatexRejectReason`（同项目互斥 / 机器已满）：
 * 清理会动同一组 .aux，不能跟正在跑的 latexmk 撞在一起。
 */
export type LatexCleanOutcome =
  | { ok: true; result: LatexCleanResult }
  | { ok: false; error: string; reason?: LatexRejectReason };

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

/**
 * 主进程愿意读进内存的日志体积上限。超了就只读尾部并置 `log.parseTruncated`
 * （旧版把整份日志无上限读进来——一份失控的自定义 recipe 可以写出几百 MB）。
 */
export const LATEX_MAX_LOG_BYTES = 16 * 1024 * 1024;

/**
 * `compile_latex` 回执正文的字符上限（≈ 3k token）。
 * 超了依次砍：日志尾巴 → raw → layout 明细 → 产物明细——**状态行 / Command / Log /
 * 第一条 error 永不砍**（它们是模型判断「发生了什么」的最小集合）。
 */
export const LATEX_REPLY_MAX_CHARS = 12_000;

/** 正文里带 `raw` 的 error 条数（前 N 条：修错是从上往下修的） */
export const LATEX_RAW_ERRORS = 5;

/**
 * 日志解析的**分类上限**。三种 kind **各自独立计数**：版式告警不再挤出未定义引用
 * （210 条 Overfull + 1 条 Citation undefined 曾让后者整条消失，status 还变成 ok）。
 * 真实论文的 Overfull 可以上千条，所以 layout 的上限反而更紧。
 */
export const LATEX_MAX_ERRORS = 200;
export const LATEX_MAX_WARNINGS = 200;
export const LATEX_MAX_LAYOUT = 50;

/**
 * `latexmk -c` 的时长上限。清理只是读 .fdb_latexmk 再删几份文件，正常是亚秒级；
 * 60 秒是给「磁盘很慢 / 杀毒软件逐个扫描」留的余量，超了就是真有问题（照样杀整棵进程树）。
 */
export const LATEX_CLEAN_TIMEOUT_MS = 60_000;

/**
 * 一次构建最多报几个产物。真实项目是 1–3 份（正文 + 附录 + 一张 standalone 图）；
 * 一个把每章都 \includestandalone 的项目可能写出几十份——上限防「产物列表变成目录树」，
 * 超出的部分置 `outputsTruncated`（不静默）。
 */
export const LATEX_MAX_OUTPUTS = 20;

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

/**
 * renderer 的编译条通道 —— IPC 四层契约的第 1 层。
 *
 * **授权与 fs:* 同一道**：renderer 只传「根 + 当前文件」（`LatexFileContext`），
 * 项目目录由主进程从文件往上找、再用文件面板的白名单校验——renderer 不能拿
 * 这条通道去编任意目录（TeX 的 \input 能读任意文件，编一个来路不明的 .tex 等价于
 * 让模型读那些文件）。
 */
export const latexChannels = {
  /** 本机 latexmk 与引擎探测（缓存在主进程；界面点开引擎 chip 时现问） */
  probe: "latex:probe",
  /** 设置页 LaTeX 面板的环境自检（synctex / chktex / pandoc 聚合，latexmk 走 latex:probe） */
  envCheck: "latex:env-check",
  /** PDF 批注的读与写（项目目录 .orbita/annotations.json，原子写） */
  annotationsGet: "latex:annotations-get",
  annotationsPut: "latex:annotations-put",
  /** 改动裁决：把当前项目 PDF 备份到 .orbita/pdf-backups/（改前对照用） */
  pdfBackup: "latex:pdf-backup",
  /** 当前文件所属的 LaTeX 项目（找不到就是 found:false） */
  project: "latex:project",
  /** 编一次；结局是 LatexRunOutcome（并发被拒也走 ok:false） */
  compile: "latex:compile",
  /** 取消这个项目在跑的编译；true = 确实有东西被叫停 */
  cancel: "latex:cancel",
  /** 把引擎 / 主文件的选择写进项目 `.orbita/latex.json`，回刷新后的项目 */
  configure: "latex:configure",
  /** 源码行 → PDF 位置（SyncTeX 正向查找；右键「在 PDF 中定位」） */
  synctexForward: "latex:synctex-forward",
  /** PDF 页面坐标 → 源码行（SyncTeX 反向查找；PDF 双击 / Ctrl+单击） */
  synctexReverse: "latex:synctex-reverse",
  /** 缺的文件名 → 发行版包名与安装命令（反查要起 kpsewhich / tlmgr / mpm） */
  packages: "latex:packages",
  /** 项目符号索引：\label / 自定义命令 / 环境 / 路径候选（补全与重复 label 提示读它） */
  index: "latex:index",
  /**
   * 多文件导航：包含图（`file → includes[]` + 反向 `owners[]`）与每个文件的章节。
   * 编辑器 Ctrl/Cmd+单击 跳转与大纲跨文件聚合都读它（一份事实，不读两套）。
   */
  nav: "latex:nav",
  /** chktex 行内检查（本机装了才可用；没装时 available:false） */
  lint: "latex:lint",
  /**
   * 本机 TeX 发行版里的宏包名（`\usepackage{` 的补全候选）。
   * 在主进程扫一次 `kpsewhich --show-path=tex` 的目录、缓存；renderer 只拿名字。
   */
  packageNames: "latex:package-names",
  /** 清理辅助文件（`latexmk -c`）：删 .aux/.log 等，保留 PDF */
  clean: "latex:clean",
  /** 编译中的进度（当前跑到哪一步）；1 秒轮询一次，不进项目描述 */
  progress: "latex:progress",
  /** 「指定位置」：系统文件选择器选 latexmk，现验通过后写进设置 */
  locate: "latex:locate",
} as const;

/**
 * 一次界面请求的授权上下文：与 `fs:*` 的 root/dir 同形。`root` 是文件面板里的
 * 那个根（白名单按它核），`path` 是当前打开的文件（`fs:read` 的 dir 语义）。
 */
export interface LatexFileContext {
  sessionId: string | null;
  workspaceId: string | null;
  /** 专注 / 浏览态的额外根，与 fs:* 同义 */
  extraWorkspaceId?: string | null;
  root: string;
  path: string;
}

/** 一个 root 的项目级事实（`LatexRootRef` 加上磁盘状态） */
export interface LatexRootInfo extends LatexRootRef {
  /** 磁盘上的主产物（可能来自上一次成功构建）；没编过 / 找不到为 null */
  pdf: { path: string; modifiedAt: number; pages: number | null } | null;
  /** 与这个 root 有关的源码最新 mtime（include 闭包；闭包算不出来时退回项目级） */
  sourceModifiedAt: number | null;
  /** 解析 / 构建这一份的已知问题（magic 指向不存在的文件、越界…）；正常为 null */
  detail: string | null;
}

/** 项目描述：编译条的 chip 与「PDF 是否过期」都只读这一份。 */
export interface LatexProjectInfo {
  /** 项目目录绝对路径（主文件所在目录；magic root 会改写它） */
  dir: string;
  /** 所有可编译的根（递归 ≤2 层、含 \documentclass 的 .tex；配置里显式写的也在内） */
  roots: LatexRootInfo[];
  /**
   * 下一次编译会用的根（相对项目目录）；没有可编译 root 时 null。
   * 它是 magic / activeRoot / 约定 / 扫描综合后的**结论**，不是配置里的原始值。
   */
  activeRoot: string | null;
  /**
   * 当前打开的文件落在哪个 root 的 include 闭包里（面板高亮用）；
   * 解析不出（多个 root 都含它 / 都不含）时为 null。
   */
  focusedRoot: string | null;
  /** 编译时会用的引擎（请求以外的来源：magic > 配置 > 自动） */
  engine: LatexEngine;
  /** 引擎是怎么定下来的，界面据此说「自动」还是「项目设置」 */
  engineSource: LatexEngineSource;
  /**
   * 主文件名（相对 dir ≈ 引擎工作目录；与日志 file:line 同一基准）。
   * 注意它不总是等于 activeRoot：activeRoot 相对**项目目录**，root 在子目录时是
   * "book/main.tex"，而这里是 "main.tex"。界面拼绝对路径用这个。
   */
  main: string | null;
  /** 主文件候选（= roots[].path；没有一个 root 时退回顶层 .tex） */
  mains: string[];
  /** `.orbita/latex.json` 里的显式选择（chip 的当前值；outDir / recipe 来自 active root） */
  configured: {
    main?: string;
    engine?: LatexEngine;
    activeRoot?: string;
    /** 相对这个 root 的目录（原样，未展开） */
    outDir?: string;
    /** 选中的配方预设 id（`.orbita/latex.json` 的 roots[].recipeId）；没有时缺省 */
    recipeId?: string;
    /** 自定义命令（原样）；没有时缺省 */
    recipe?: string[];
  };
  /**
   * 「清理辅助文件」现在可用（`latexmk -c` 是 latexmk 的功能）。
   * 选中的预设不是 latexmk 系（手写链 / 单次编译）时为 false——界面据此禁用并说明。
   */
  cleanable: boolean;
  /** 磁盘上的 PDF；没有编译过就是 null。它可能是**上一次成功**的那份 */
  pdf: { path: string; modifiedAt: number } | null;
  /** 参与「过期」判定的最新源码 mtime（主文件 + .tex / .bib / .cls / .sty） */
  sourceModifiedAt: number | null;
  /** 主文件解析失败的一句原因（no-main-file 的 detail）；成功时 null */
  detail: string | null;
  /**
   * 保存即编译（项目级开关，缺省关）。写在 `.orbita/latex.json` 的 `compileOnSave`：
   * 它属于这个项目（有的项目编一次几十秒，不该全局默认开）。
   */
  compileOnSave: boolean;
}

export type LatexProjectOutcome = { found: false } | { found: true; project: LatexProjectInfo };

/**
 * 编译中的进度。**只报我们真观察到的信号**：latexmk 的 stdout 里
 * `Run number N of rule 'xelatex'` 那一行（每跑一轮引擎 / bibtex 就有一行）。
 * 没有这个信号（自定义 recipe 不打印）时 `step` 为 null，界面退回「编译中…」。
 * 总轮数不可知，所以不给 `3/4` 这种分母。
 */
export interface LatexBuildProgress {
  running: boolean;
  /** 当前这一轮的抓手（"xelatex" / "bibtex"），没有信号时 null */
  step: string | null;
  /** latexmk 报的轮次（1 基）；没有信号时 null */
  run: number | null;
}

/**
 * 编译条发起的编译：不给 dir——项目目录由主进程从 path 找，绕不过白名单。
 * `path` 就是当前打开的文件：它的 `% !TEX root` 会被采用（与 agent 的 file 参数同源）。
 * `main` 只在「忽略这个文件的 magic、编我点的那个 root」时给。
 */
export interface LatexCompileIpcRequest extends LatexFileContext {
  main?: string;
}

/** 一个 root 的配置项（写进 `.orbita/latex.json` 的 roots[]） */
export interface LatexRootConfig {
  /** 相对项目目录的 .tex；必须是 .tex、不许绝对路径 / 不许 ".." */
  path: string;
  engine?: LatexEngine;
  /**
   * 产物目录，**相对这个 root 所在的目录**（沿用 v1 `outDir` 相对主文件目录的语义，
   * 迁移零风险）。不许绝对路径 / 不许 ".."。缺省 "build"。
   */
  outDir?: string;
  /** latexmk 的 -jobname；省略 = 主文件 basename */
  jobname?: string;
  args?: string[];
  /** 选中的配方预设（shared/latex-recipes.ts 的 id）；未知 id 按「没选」处理 */
  recipeId?: string;
  /** recipe[0] 是可执行文件，其余是参数（见 resolve.ts 的 buildSteps） */
  recipe?: string[];
}

/**
 * 引擎 / root 选择。各项都可单独给：
 * - `activate` 只改 activeRoot；
 * - `upsertRoot` 新增或更新一条 root 配（字段名不叫 root：LatexFileContext.root 是白名单根）；
 * - `removeRoot` 只删配置，不删文件；
 * - `engine` 写到**当前生效的 root** 上（v2 是 per-root 的）；
 * - 旧字段 `main` 等价于「activate + upsert 一条」（一个 release 的兼容期）。
 */
export interface LatexConfigureRequest extends LatexFileContext {
  activate?: string;
  upsertRoot?: { path: string } & Omit<Partial<LatexRootConfig>, "path">;
  removeRoot?: string;
  main?: string;
  engine?: LatexEngine;
  compileOnSave?: boolean;
}

export type LatexConfigureOutcome =
  | { ok: true; project: LatexProjectInfo }
  | { ok: false; error: string };

/**
 * SyncTeX 双向定位（源码 ↔ PDF）。
 *
 * **坐标契约（唯一一份，主进程与 renderer 都按它走）**：`LatexSyncRect` 的
 * left / top / width / height 是 **PDF 用户空间点（1/72 英寸）**，原点在页面
 * **左上角**、y 向下。synctex 命令输出的数值本来就是这一套（实测：A4 上一行 10pt
 * 正文的 y 是「页高 − 基线」，即“到页顶的距离”，单位与 pdf.js viewport(scale=1)
 * 的宽高一致），所以主进程只搬数值、不翻转；renderer 乘渲染缩放即得 CSS px。
 *
 * 别把这里换成 CSS px：缩放随面板宽度与 DevicePixelRatio 变，契约层存像素值会在
 * 换窗口宽度的下一帧指错行。
 */
export interface LatexSyncRect {
  /** 1 基页码 */
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 定位失败的原因。**每一种都要能翻成一句人话**——「没反应」在这里等于 bug：
 * - `not-installed`：本机没有 synctex 命令（TeX 发行版缺组件）
 * - `no-synctex`：PDF 旁边没有 .synctex.gz（这份 PDF 不是带 SyncTeX 编出来的）
 * - `no-pdf`：项目里根本没有 PDF
 * - `no-result`：synctex 跑了，但这一行 / 这一点在 PDF 里没有记录（改过源码没重编最常见）
 * - `outside-project`：反查命中的是项目外的文件（系统 .cls / .sty），不是用户能打开的源码
 * - `failed`：命令本身出错；`detail` 带 stderr 尾巴
 */
export type LatexSyncFailureReason =
  | "not-installed"
  | "no-synctex"
  | "no-pdf"
  | "no-result"
  | "outside-project"
  | "failed";

export interface LatexSyncFailure {
  ok: false;
  reason: LatexSyncFailureReason;
  /** 原始诊断（stderr / 命中的文件路径）；界面只在 `failed` 时把它附在提示后面 */
  detail: string | null;
}

/** 正向查找结果：源码的一行落在 PDF 的哪一页、哪一块 */
export type LatexForwardOutcome = { ok: true; rect: LatexSyncRect } | LatexSyncFailure;

/** 反向查找结果：PDF 上的一点来自哪个源码文件的哪一行 */
export type LatexReverseOutcome =
  | {
      ok: true;
      /** 绝对路径（主进程已确认在项目目录内，renderer 可直接拿去开标签） */
      file: string;
      /** 相对项目目录的路径，正斜杠（提示文案与服务端日志用） */
      relative: string;
      /** 1 基行号 */
      line: number;
    }
  | LatexSyncFailure;

/** 正向查找请求：`path` 是源码文件，`line` 是 1 基行号 */
export interface LatexForwardRequest extends LatexFileContext {
  line: number;
  /** 1 基列；缺省交给 synctex 自己挑（它当前对列不敏感，留口给以后的版本） */
  column?: number;
}

/** 反向查找请求：`path` 是 PDF，坐标是 PDF 点（左上原点，与 LatexSyncRect 同源） */
export interface LatexReverseRequest extends LatexFileContext {
  page: number;
  x: number;
  y: number;
}

/**
 * 项目索引里的一条 `\label`。**file 是相对项目目录、正斜杠**（界面直接显示，
 * 与 LatexIssue.file 同一口径）；line 是 1 基行号（日志也是 1 基）。
 */
export interface LatexLabelRef {
  name: string;
  file: string;
  line: number;
}

/**
 * 项目符号索引 —— `\ref{}` 的候选、`\begin{}` / 命令补全里「本项目自己定义的」那一层、
 * 以及 `\input{}` / `\includegraphics{}` 的路径候选。
 *
 * **为什么在主进程算**：它是「读项目里所有 .tex」这件事，renderer 没有授权也不该
 * 为了补全自己去读盘；同时它与 `latex:project` 用同一个「项目目录」结论，magic root
 * 改写目录时补全与编译看到的是同一批文件。
 *
 * 索引**不做语义分析**（不上 AST）：论文项目的符号就是那么几种，正则在注释剔除后足够；
 * 上 AST 的成本要等 outline / 环境配对真需要时再付。
 */
export interface LatexProjectIndex {
  /** 项目目录绝对路径（与 LatexProjectInfo.dir 同一个值） */
  dir: string;
  /** 所有 `\label{...}`，按文件、行排序 */
  labels: LatexLabelRef[];
  /** 同名定义了多次的 label（按名排序）：引用编号指错的第一现场 */
  duplicateLabels: string[];
  /** 项目内定义的命令名（不带反斜杠）：`\newcommand{\foo}` / `\def\foo` / `\DeclareMathOperator` */
  commands: string[];
  /** 项目内定义的环境名：`\newenvironment{x}` / `\newtheorem{x}` */
  environments: string[];
  /**
   * 路径候选（相对项目目录、正斜杠）：`\input` 认 .tex，`\includegraphics` 认图片。
   * 目录也在里面（以 `/` 结尾）——用户打到一半的 `fig/` 需要能接着往下补。
   */
  files: string[];
  /** 扫描有没有看不全（深度 / 条数 / 体积超限）：补全可能少候选，界面不必提示成错误 */
  truncated: boolean;
}

export type LatexIndexOutcome = { found: false } | { found: true; index: LatexProjectIndex };

/**
 * 多文件导航（`latex:nav`）—— 一份包含图 + 每个文件的章节。
 *
 * 两个读者共用一份事实：
 * - **编辑器**（Ctrl/Cmd+单击 `\input{…}`）：要行号与参数的列区间、以及解析后的目标；
 * - **大纲**（跨文件聚合）：要每个文件按出现顺序的章节，以及包含命令插在哪里。
 *
 * `target: null` 就是 unresolved（找不到文件）：**不瞎猜**，界面据此提示一句。
 * `truncated` / `limits` 记录撞到的深度、文件数、环上限；有上限时大纲可能不全，
 * 但图里已经有的边仍然可用。
 */
export interface LatexNavEdge {
  /** 命令名，不带反斜杠（input / include / subfile / …） */
  command: string;
  /** 参数原文（`\input{sec/ch1}` 里的 `sec/ch1`） */
  raw: string;
  /** 1 基行号 */
  line: number;
  /** 参数区在行内的起始列（0 基，左闭） */
  argFrom: number;
  /** 参数区的结束列（0 基，右开） */
  argTo: number;
  /** 解析到的文件（绝对路径）；找不到为 null */
  target: string | null;
}

/** 文件里的一条章节标题 */
export interface LatexNavSection {
  command: string;
  title: string;
  /** 绝对层级（part=0 … subparagraph=6）；跨文件归一由 renderer 拼完整篇后做 */
  level: number;
  /** 1 基行号 */
  line: number;
}

/** 图里的一个文件 */
export interface LatexNavFile {
  /** 绝对路径（去重键） */
  path: string;
  /** 相对项目目录、正斜杠（界面显示用） */
  display: string;
  /** 谁包含它（绝对路径、按发现顺序） */
  owners: string[];
  /** 它落在哪些 root 的闭包里（相对项目目录） */
  roots: string[];
  /** 它包含谁（按出现顺序） */
  includes: LatexNavEdge[];
  /** 它的章节标题（按出现顺序） */
  sections: LatexNavSection[];
}

/** 撞到的上限种类；`at` 是撞上的那个文件（绝对路径） */
export interface LatexNavLimit {
  kind: "depth" | "nodes" | "cycle";
  at: string;
}

export interface LatexNav {
  /** 项目目录绝对路径 */
  dir: string;
  /**
   * 聚合用的根（相对项目目录）：当前文件落在的**第一个** root。
   * 不属于任何 root 时为 null——界面退回「只看当前文件」的旧行为。
   */
  root: string | null;
  /** 同上，绝对路径（大纲拼接从它开始走） */
  rootPath: string | null;
  /**
   * 当前文件属于哪些 root（相对项目目录）。多个 root 都包含它时全部列出，
   * `root` 取第一个：不展开了两棵树，但用户能从 chip 看出它在哪几本书里。
   */
  focusRoots: string[];
  files: LatexNavFile[];
  /** 有上限被撞到（深度 / 文件数 / 环）：大纲可能不全 */
  truncated: boolean;
  limits: LatexNavLimit[];
}

export type LatexNavOutcome = { found: false } | { found: true; nav: LatexNav };

/**
 * 本机已安装的宏包名（`\usepackage{…}` 的补全候选）。
 *
 * **为什么在主进程算**：名单来自用户机器上的 TeX 树（`kpsewhich --show-path=tex` 给的
 * 目录下面的 `*.sty`），renderer 既没有授权去扫盘，也不该为了一次补全自己走几万个文件。
 * 扫一次的结果按 latexmk 路径缓存（= 同一套 TeX 树）；用户换了发行版 / 重装后重新探测
 * 时会换缓存键，下一次打开面板自然重扫。
 *
 * `available: false` = 没有 TeX，或一台都扫不到：界面安静地退回「只补已加载的
 * `\usepackage`」，不提示「缺少工具」——补全不是必须依赖 TeX 的功能。
 */
export interface LatexPackageNamesOutcome {
  available: boolean;
  /** 排序去重后的宏包名（不带 `.sty`）；超过上限时截断并在 truncated 里说明 */
  names: string[];
  /** 撞到名字 / 文件数上限：名单可能不全（界面不需要提示成错误） */
  truncated: boolean;
}

/**
 * 名字上限：TeX Live 2025 全量（texmf-dist 的 tex/latex 共 8 个搜索目录）在本机实测
 * 5837 个 `.sty` 名字、扫完 450ms；12000 给多装了几套宏集的机器留一倍余量。
 * 撞到上限只影响「补全少几个候选」，不会出错。
 */
export const LATEX_MAX_PACKAGE_NAMES = 12_000;

/**
 * 扫描文件数上限：本机全量扫一次约 6 万个文件；40 万是异常目录树（整盘软链进来）
 * 的刹车，撞上就标 truncated——不拿一次补全换十秒主进程。
 */
export const LATEX_MAX_PACKAGE_SCAN_FILES = 400_000;

/**
 * chktex 行内检查的结局。
 *
 * `available: false` = **本机没有 chktex**（或这个文件不是 .tex）：界面据此完全不显示
 * 这条通道的痕迹——它是 TeX 发行版的可选组件，没装的人不该看到任何「缺少工具」。
 * `available: true` 且 `issues` 为空 = 检查过、没有问题。
 */
export interface LatexLintOutcome {
  available: boolean;
  /** 只含被检查的那个文件的问题（file 相对项目目录，与编译日志同一口径） */
  issues: LatexIssue[];
}

/**
 * 缺宏包反查 —— 日志只说「`ctexart.cls' not found」，而 tlmgr / mpm 要的是**包名**，
 * 两者并不相等（`ctexart.cls` → `ctex`；`tcolorbox.sty` → `tcolorbox`）。
 *
 * 反查在主进程做：它要起 kpsewhich / tlmgr / mpm 三个外部命令，renderer 没有那套授权。
 * 名字来自编译日志（等于来自 .tex 文件内容），所以**只接受 `x.sty` / `x.cls` 形状的白名单**，
 * 别的字符一律不去拼命令（见 main/latex/packages.ts）。
 */
export interface LatexPackageQuery extends LatexFileContext {
  /** 日志里缺的文件名，如 "ctexart.cls"。多于 LATEX_MAX_PACKAGE_LOOKUPS 的部分不看 */
  missing: string[];
}

/** 认出来的发行版；都没有时 null（那就只能报「未知包」） */
export type LatexPackageDistro = "texlive" | "miktex" | null;

/**
 * 没给出包名的原因。**三种原因必须分开**——它们的下一步完全不同：
 * - `invalid-name`：日志里的名字不是 `x.sty` / `x.cls` 形状，我们根本没拿去查；
 * - `no-tools`：这台机器上没有 tlmgr / mpm，装不了也查不了；
 * - `tool-error`：工具在，但命令起不来 / 超时 / 非零退出（这次没查成）；
 * - `not-found`：命令正常跑完，发行版里没有包认领这个文件（真·未知包）；
 * - `not-looked-up`：名字太多（超过 LATEX_MAX_PACKAGE_LOOKUPS）没有查，或通道失败。
 * 反查成功时（packageName 非 null）为 null。
 */
export type LatexPackageReason = "invalid-name" | "no-tools" | "tool-error" | "not-found" | "not-looked-up";

/**
 * 一个缺文件的反查结果。**每一项都要能单独成句**：界面可能只拿到 packageName=null
 * 的那一半（未知包），也可能命中「本机其实已经有这个文件」。
 */
export interface LatexResolvedPackage {
  /** 日志里的文件名原样（`ctexart.cls`） */
  missing: string;
  /** 发行版包名（`ctex` / `texlive-lang-chinese` / MiKTeX 的 `ctex`）；未知时 null */
  packageName: string | null;
  /**
   * 填进终端的安装命令（不含回车）。未知包 / 认不出发行版时 null——
   * 界面据此**不显示**「在终端安装」，而不是猜一条装不上的命令。
   */
  command: string | null;
  /** 命令要不要加 sudo（macOS 的 BasicTeX / MacTeX 装在 root 拥有的 /usr/local/texlive 下） */
  sudo: boolean;
  /** kpsewhich 已能定位到这个文件：日志可能是旧的，或引擎用的是另一个 TeX 树 */
  installed: boolean;
  distro: LatexPackageDistro;
  /** packageName 为 null 时说明是哪一种失败；成功时为 null（见 LatexPackageReason） */
  reason: LatexPackageReason | null;
}

/**
 * 一次反查最多处理几个文件：真实文档一次编译缺一两个。上限留得比常见需求宽（并发只有三，
 * 不会一次起一堆 Perl），超过的部分明确标成 `not-looked-up`，**不许界面一直转圈**。
 */
export const LATEX_MAX_PACKAGE_LOOKUPS = 20;

/**
 * 缺包反查的对外结局。agent 通道（`latexPackageRequest`）与 `latex_packages` 工具
 * 读它；`ok: false` 是「这次没查成」（授权 / 参数），不是「没找到包」——后者是
 * `resolved[].reason`。
 */
export type LatexPackageOutcome =
  | { ok: true; resolved: LatexResolvedPackage[] }
  | { ok: false; error: string };

/**
 * 「引擎在等用户确认安装」的日志行 —— MiKTeX 的按需装包 / 造字（mktexpk 家族）
 * 在「先问我」模式下会停下来等一个回答，编译看上去就是卡住了。
 *
 * 这几个形状是 MiKTeX 在控制台 / 日志里用过的说法（`miktex-makepk:`、
 * 「… wants to be installed」、「Do you want to install …」）。**本机没有 MiKTeX，
 * 这些字符串未经真机校对**：只认明确的「等待安装」说法，宁可漏认也不把普通资源告警
 * 误报成「在等你确认」——漏认时用户看到的仍然是普通的缺包行。
 *
 * 放在 shared 里是因为两个消费者必须用同一份：parse-log 靠它把这类行留进 warnings，
 * 问题抽屉靠它把这类行归到「等待确认」那一组（两处各写一份就会慢慢长歪）。
 */
export function miktexPendingOf(message: string): boolean {
  return (
    /\bmiktex-(?:makepk|makemf|maketfm)\b/i.test(message) ||
    /\bwants to be installed\b/i.test(message) ||
    /\bdo you want to install\b/i.test(message) ||
    /\bwaiting for (?:the )?user(?:'s)? (?:input|confirmation|decision)\b/i.test(message)
  );
}
