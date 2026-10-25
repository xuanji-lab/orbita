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
 * 走 `LatexRunOutcome` 的 `{ ok: false }` 分支——那时我们连 latexmk 都没起，
 * 把它报成某个 status 会让界面显示一次不存在的编译。
 */
export type LatexStatus =
  | "ok"
  /** 出了 PDF，但有非版式类告警（缺字体、未定义引用……） */
  | "warning-only"
  /** latexmk 非零退出，或退出 0 但没产出新 PDF */
  | "compile-error"
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
}

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
 * 编译的对外结局。**并发被拒、目录不存在一类"没开始编"的失败走这里**，
 * 不伪装成一次编译结果（同 LatexStatus 的注释）。
 */
export type LatexRunOutcome = { ok: true; result: LatexResult } | { ok: false; error: string };

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

/** latexmk 单次编译的硬上限。真实论文（含 bibtex 多轮）通常 10–60 秒量级 */
export const LATEX_TIMEOUT_MS = 120_000;

/** 失败时回给模型的日志尾巴长度 */
export const LATEX_LOG_TAIL_LIMIT = 8 * 1024;

/** 日志解析的条目上限（errors / warnings 各自）。坏日志可以有上万条 Overfull */
export const LATEX_MAX_ISSUES = 200;

/** 全局同时编译的项目数。超过两个 latexmk 会把一台笔记本的 CPU 吃满 */
export const LATEX_MAX_CONCURRENT = 2;

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

/** 项目描述：编译条的 chip 与「PDF 是否过期」都只读这一份。 */
export interface LatexProjectInfo {
  /** 项目目录绝对路径（主文件所在目录；magic root 会改写它） */
  dir: string;
  /** 编译时会用的引擎（请求以外的来源：magic > 配置 > 自动） */
  engine: LatexEngine;
  /** 引擎是怎么定下来的，界面据此说「自动」还是「项目设置」 */
  engineSource: "magic" | "config" | "auto";
  /** 主文件（相对 dir）；多 .tex 且没 main.tex 时为 null，界面让用户选 */
  main: string | null;
  /** 项目顶层的 .tex（主文件候选） */
  mains: string[];
  /** `.orbita/latex.json` 里的显式选择（chip 的当前值） */
  configured: { main?: string; engine?: LatexEngine };
  /** 磁盘上的 PDF；没有编译过就是 null。它可能是**上一次成功**的那份 */
  pdf: { path: string; modifiedAt: number } | null;
  /** 参与「过期」判定的最新源码 mtime（主文件 + .tex / .bib / .cls / .sty） */
  sourceModifiedAt: number | null;
  /** 主文件解析失败的一句原因（no-main-file 的 detail）；成功时 null */
  detail: string | null;
}

export type LatexProjectOutcome = { found: false } | { found: true; project: LatexProjectInfo };

/** 编译条发起的编译：不给 dir——项目目录由主进程从 path 找，绕不过白名单 */
export type LatexCompileIpcRequest = LatexFileContext;

/** 引擎 / 主文件选择。`main` 是相对项目目录的 .tex；两项都可单独给 */
export interface LatexConfigureRequest extends LatexFileContext {
  main?: string;
  engine?: LatexEngine;
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
}

/** 一次反查最多处理几个文件：真实文档一次编译缺一两个，多出来的多半是级联噪声 */
export const LATEX_MAX_PACKAGE_LOOKUPS = 5;

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
