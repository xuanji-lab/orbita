/**
 * 引用域的契约 —— `\cite{…}` 的本地补全（第一刀，只读本项目的 `.bib`）。
 *
 * **为什么不联网**：arXiv / Crossref / DOI 核验是另一件事（另开 PR）。写论文时按
 * `\cite{` 弹出的第一个需要是「我自己文献库里的键」，它必须在断网、在飞机上、
 * 在防火墙后面都能用；在线检索是补充，不是前提。
 *
 * **授权与 `fs:*` / `latex:*` 同一道**：renderer 只传「根 + 当前文件」
 * （`CiteFileContext`，与 LatexFileContext 同形），项目目录由主进程从文件往上找、
 * 再用文件面板的白名单校验。renderer 给不出目录，也就读不了项目外的 .bib。
 *
 * 与 `shared/latex.ts` 的分工：那边管编译（一次 latexmk 的结局），这边管文献库
 * （一次扫描的目录事实）。两者共用的只有「项目目录怎么找」这一道授权。
 */
import type { LatexFileContext } from "./latex.ts";

/**
 * 一条文献条目 —— 补全列表的一行，也是「同 key 以先出现者为准」比较的对象。
 * 名字取 BibTeX 的词（entry），不是我们的发明。
 */
export interface CiteEntry {
  /** 引用键（`\cite{key}` 里插入的那段） */
  key: string;
  /** 条目类型，小写（article / book / inproceedings …）；解析不出时是 "misc" */
  type: string;
  /** 标题的纯文本（花括号去掉、空白折叠）；没有该字段时 null */
  title: string | null;
  /** 作者字段原文（BibTeX 的 `A and B and C` 写法）；没有时 null */
  author: string | null;
  /** 年份（`year`，没有时取 `date` 的前四位）；没有时 null */
  year: string | null;
  /** 来源文件：相对项目目录的路径，**正斜杠**（Windows 上也一样，界面直接显示） */
  file: string;
}

/**
 * 一个 .bib 文件的扫描账。**坏条目和坏文件分开记**：前者是「这个文件里有 3 条
 * 不完整」，跳过就完事；后者是「这份文件读不了」，用户要知道补全里少了它。两者都在
 * 问题抽屉里给一条 warning，都不阻塞编译。
 *
 * 没有「解析出了几条」这个字段：除了解析器自己，没人读它（消费者纪律：不留没人用的
 * 计数）。条数要看的话，`entries` 里按 `file` 分组就是了。
 */
export interface CiteBibFile {
  /** 相对项目目录的路径，正斜杠 */
  path: string;
  /** 跳过的坏条目数（缺 key、括号不闭合、字段没有值…） */
  bad: number;
  /** 整份文件读不了时的一句话（给问题抽屉）；正常时 null */
  error: string | null;
}

/** 一份 .bib 为什么没读：体积超限，或撞上了「最多读多少份」 */
export type CiteSkipReason = "too-large" | "too-many-files";

/**
 * 没读的 .bib。**上限不许静默丢文件**：论文仓 `figures/` 放两千张图是常态，
 * 一份 `refs/ok.bib` 被扫漏了却什么都不说，用户只会看到「补全里少了条目」。
 */
export interface CiteSkippedBib {
  /** 相对项目目录的路径，正斜杠 */
  path: string;
  reason: CiteSkipReason;
}

/**
 * 一次扫描的结果。`entries` 已经**按 key 去重（先出现者为准）并按 key 排序**——
 * 排序在主进程做一次，renderer 的候选列表与测试读的是同一份顺序，不在两边各排一次。
 */
export interface CiteLibrary {
  entries: CiteEntry[];
  /** 扫到的 .bib 文件（按路径排序）；没有 .bib 时是空数组 */
  files: CiteBibFile[];
  /** 因上限 / 体积没读的 .bib（路径 + 原因）；界面汇总成一条 warning */
  skipped: CiteSkippedBib[];
  /**
   * 有目录或深度没进去看（扫到预算上限）：可能还有 .bib 根本没被发现，
   * 数不出是哪几份。与 `skipped` 一起构成「补全可能不全」的完整信号。
   */
  truncated: boolean;
}

/**
 * renderer 的引用通道 —— IPC 四层契约的第 1 层。
 *
 * 三个方法各管一件事：读盘（library）、联网（search）、写回（save）。**联网只在
 * `search` 里发生**，而且只在用户点「查找」时被调用一次：没有启动时预取、没有后台
 * 轮询、没有「猜用户在找什么」。补全需要的是「现在盘上有什么」，缓存让用户看不见刚
 * 加的条目，所以 library 不做缓存——调用方按项目文件的 mtime 决定什么时候再问。
 */
export const citeChannels = {
  /** 当前文件所属项目的文献库（不在 LaTeX 项目里时 found:false） */
  library: "cite:library",
  /** 在线检索一条文献（Crossref / arXiv；主进程 8 秒超时、10 分钟内存缓存） */
  search: "cite:search",
  /** 把选中的检索结果追加进项目的 .bib，回写到哪个文件与生成的 key */
  save: "cite:save",
} as const;

/** 授权上下文：与 `latex:project` 同一个形状，主进程按同一道白名单核 */
export type CiteFileContext = LatexFileContext;

/**
 * 读库的结局。`found:false` 不是错误（这个文件不属于 LaTeX 项目是文件面板的日常），
 * 白名单 / 读盘失败才 reject，调用方 catch 成一行错误。
 */
export type CiteLibraryOutcome = { found: false } | { found: true; library: CiteLibrary };

/** 补全列表最多给多少条：几百条文献的弹层滚不动，输入更多字自然会缩小范围 */
export const CITE_MAX_SUGGESTIONS = 60;

/** 一份 .bib 都没有时新建的文件名（论文仓最常见的约定：`\bibliography{refs}`） */
export const CITE_PREFERRED_BIB = "refs.bib";

/* ------------------------------ 在线检索 ------------------------------ */

/** 在线检索的来源：两个不需要 key 的公共接口 */
export type CiteSearchSource = "crossref" | "arxiv";

/**
 * 一条候选文献 —— 检索结果的**数据面**，不是一条已排好版的 BibTeX。
 *
 * 分成数据面与排版面是为了把「从接口拿到什么」和「写进 .bib 长什么样」分开：
 * 前者随接口变（字段缺、类型多），后者只随 BibTeX 的规则变。排版在主进程做
 * （`main/cite/entry.ts`），renderer 只负责显示与选择。
 */
export interface CiteCandidate {
  source: CiteSearchSource;
  /** 标题纯文本：HTML 标签与实体已还原、空白已折叠 */
  title: string;
  /** 作者，显示形（`Given Family`）；接口没给作者时是空数组 */
  authors: string[];
  /** 四位年份；接口没有年份时 null */
  year: string | null;
  /** 期刊 / 会议 / 预印本站点（Crossref 的 container-title，arXiv 固定 "arXiv"） */
  venue: string | null;
  doi: string | null;
  /** arXiv 编号（不带 `arXiv:` 前缀、不带版本号后缀） */
  arxivId: string | null;
  /** 条目类型：已经按 BibTeX 的词归一（不是接口自己的 type 字符串） */
  type: "article" | "inproceedings" | "misc";
  volume: string | null;
  pages: string | null;
  /** arXiv 的 primary category（`cs.CL`）；Crossref 记录没有这一项 */
  primaryClass: string | null;
}

/** 检索的一句话请求：标题 / DOI / arXiv 编号都由主进程自己认 */
export interface CiteSearchRequest {
  query: string;
}

/** 检索失败的分类：界面据此给不同的一句中文，而不是把网络栈的原文糊上去 */
export type CiteSearchFailure = "empty-query" | "timeout" | "offline" | "rate-limited" | "not-found" | "failed";

/** `ok:true` 且 `results` 为空 = 确实没查到（不是失败）；失败才走 `ok:false` */
export type CiteSearchOutcome =
  | { ok: true; results: CiteCandidate[] }
  | { ok: false; reason: CiteSearchFailure; detail: string };

/** 写 .bib 的请求：候选 + 当前文件上下文（授权与 fs:* / latex:* 同一道） */
export interface CiteSaveRequest {
  context: CiteFileContext;
  candidate: CiteCandidate;
}

/**
 * 写 .bib 的结局。成功时回**写到哪个文件**（相对项目目录，正斜杠）与生成的 key——
 * 界面要显示「已写入 refs.bib」，编辑器也要拿 key 拼 `\cite{…}`。
 *
 * `conflict` 是「读-改-写」之间文件被别人改过：这时**一个字都没写**，用户自己决定
 * 要不要重试（重试会基于新内容重新分配 key）。
 */
export type CiteSaveOutcome =
  | { ok: true; path: string; key: string; created: boolean }
  | { ok: false; reason: "outside-project" | "conflict" | "read-failed" | "write-failed" | "too-large"; detail: string };
