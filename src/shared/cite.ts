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
 * 不完整」，跳过就完事；后者是「这份文件读不了 / 整份解析不了」，用户要知道补全
 * 里少了它。两者都在问题抽屉里给一条 warning，都不阻塞编译。
 */
export interface CiteBibFile {
  /** 相对项目目录的路径，正斜杠 */
  path: string;
  /** 解析出的条目数（去重前） */
  entries: number;
  /** 跳过的坏条目数（缺 key、括号不闭合、字段没有值…） */
  bad: number;
  /** 整份文件读不了时的一句话（给问题抽屉）；正常时 null */
  error: string | null;
}

/**
 * 一次扫描的结果。`entries` 已经**按 key 去重（先出现者为准）并按 key 排序**——
 * 排序在主进程做一次，renderer 的候选列表与测试读的是同一份顺序，不在两边各排一次。
 */
export interface CiteLibrary {
  entries: CiteEntry[];
  /** 扫到的 .bib 文件（按路径排序）；没有 .bib 时是空数组 */
  files: CiteBibFile[];
  /** 被丢弃的重复 key 条数（同 key 多份定义）。只在诊断 / 测试里读，界面不展示计数 */
  duplicates: number;
}

/**
 * renderer 的引用通道 —— IPC 四层契约的第 1 层。只有一个方法：读一次文献库。
 * 补全需要的是「现在盘上有什么」，缓存让用户看不见刚加的条目，所以不在这里做
 * 缓存——调用方按项目文件的 mtime 决定什么时候再问。
 */
export const citeChannels = {
  /** 当前文件所属项目的文献库（不在 LaTeX 项目里时 found:false） */
  library: "cite:library",
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
