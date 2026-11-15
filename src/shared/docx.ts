/**
 * 应用内 docx 轻量编辑的契约 —— IPC 四层的第 1 层。
 *
 * 范围（v1，#308）：在文件面板里打开 .docx、改字、粗/斜/下划线、撤销/重做、保存。
 * N2（「指哪打哪」）在这之上加三件事，契约都在本文件的第二段：
 *   - 打开时补齐段落标识（`DocxParaIdStamp`）——没有 paraId 的文档，选择性保存会剥掉
 *     引擎 mint 的 id，锚点跨「存盘 → 重开」必失效；
 *   - 选区锚点（`DocxAnchor`）—— 复用 folio 原生的 blockId + 干净偏移 + 文本哈希 +
 *     表格坐标，不自造协议；
 *   - agent 的 `edit_docx`（`DocxAgentEditRequest`）—— 请求经主进程转给 renderer 里**活的
 *     编辑器**，由它按锚点写 tracked-changes 修订；agent 不直接改磁盘（会撞 #308 的 hash
 *     冲突并丢用户未存的改动）。
 *
 * 渲染与编辑全部交给 `@stll/folio`（Apache-2.0），本仓只负责：
 * 读字节、读之前判大小与完整性、保存时判冲突、原子写、留上一版备份。
 *
 * **白名单与 fs:read 同一道**：请求形状就是 `FileListRequest`（root / dir / 额外预览根），
 * 主进程用同一个 `resolveFileRoots` + `whitelistedPath` 现算，这条通道不能变成
 * 「读写任意文件」。判据用 realpath 之后的路径：改名成 foo.docx 的软链接指向别的
 * 类型同样被拒。
 */
import type { FileListRequest } from "./files.ts";

/**
 * 打开上限（50 MB）。比它大的文档不让 renderer 去解析：整份解析 + 分页 + 编辑的
 * 内存与主线程开销都在 renderer 里，撞上就是「面板卡死」而不是「慢一点」。
 * 超限如实返回 too-large，面板给「用默认应用打开」。
 */
export const DOCX_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 页数上限（500 页）。页数是渲染之后才知道的（分页由引擎按版式算），所以打开后
 * 由 renderer 读 `getTotalPages()` 判：超过就整份转只读并提示，不再自动保存——
 * 编辑几百页的文档会让输入延迟肉眼可见，那不是这一刀要解决的问题。
 */
export const DOCX_MAX_PAGES = 500;

/**
 * 停手多久自动保存（1.5 s）。与文件域其它自动保存同一条纪律：不抢用户每一次敲键，
 * 也不能让改动在后台悄悄滞留。
 */
export const DOCX_AUTOSAVE_DELAY_MS = 1500;

/**
 * 一页大约装多少段（Word 默认版式、正文 12pt 量级）。只在**挂载引擎之前**粗估页数时用：
 * 精确页数只有排完版才知道，而排版 800 页的文档会把面板冻住两分钟（实测 828 页的
 * 样本要 125 s）——所以这里宁可用一个粗估数先把「这份文档不该在应用内打开」说出来。
 */
const PARAGRAPHS_PER_PAGE = 40;

/**
 * 主进程从包里数出来的三件事：段落数（`w:p`）、显式分页符（`w:br w:type="page"`）、
 * 已有段落标识数（`w14:paraId`）。表格单元格里的段落也算段落——粗估页数不需要区分。
 * 第三个给「打开时要不要盖章」判（paraId 少一个就得盖，见 DocxParaIdStamp）。
 */
export interface DocxPackageStats {
  paragraphs: number;
  pageBreaks: number;
  paraIds: number;
}

/** 挂载前的页数粗估：显式分页符 +1 与「段落数 ÷ 每页段数」取大者 */
export function estimateDocxPages(stats: DocxPackageStats): number {
  return Math.max(stats.pageBreaks + 1, Math.ceil(stats.paragraphs / PARAGRAPHS_PER_PAGE));
}

export function isDocxFile(path: string): boolean {
  return /\.docx$/i.test(path);
}

/**
 * 两个 docx 路径是不是同一份文件。**只比字符串**，不碰文件系统：主进程已经把真实路径
 * realpath 过了，这里要解决的是另一件事——renderer 手里的 `request.dir` 与消息里
 * `<quoted_docx path>` 的分隔符 / Windows 盘符大小写可能不同形。
 */
export function sameDocxPath(a: string, b: string): boolean {
  const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const left = norm(a);
  const right = norm(b);
  const windows = /^[a-zA-Z]:\//.test(left) || /^[a-zA-Z]:\//.test(right);
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** docx 的读写请求：形状与 `fs:read` 完全一致（root/dir 白名单同一道） */
export type DocxTarget = FileListRequest;

/**
 * 打不开的原因：`password` 是加密包（OLE2 容器），`not-docx` 不是 zip，`corrupt` 是
 * zip 里没有正文，`missing` 是文件在打开这一刻已经不在了（外部删除 / 改名——
 * 同一份文档可能正开着编辑器，用户在别处把它删了，再点刷新）。
 */
export type DocxInvalidReason = "password" | "not-docx" | "corrupt" | "missing";

/**
 * `docx:open` 的回执。`data` 是整份字节（Uint8Array 走结构化克隆，不转 base64），
 * `hash` 是这一份磁盘内容的 sha256 —— 保存时回传它，主进程拿磁盘现状比对，
 * 不一致就拒绝覆盖（冲突而不是覆盖）。
 */
export type DocxOpenResult =
  | {
      kind: "docx";
      data: Uint8Array;
      size: number;
      modifiedAt: number;
      hash: string;
      /** 挂载前的页数粗估依据（见 estimateDocxPages） */
      stats: DocxPackageStats;
      /**
       * 打开时补齐段落标识的结果。`data` 已经是**盖章后**的字节（编辑基线），
       * `hash` 仍是**磁盘原始内容**的 hash——保存时拿它判冲突，两边不能换。
       */
      stamp: DocxParaIdStamp;
    }
  /** 超过 DOCX_MAX_BYTES：不读内容，面板给「用默认应用打开」 */
  | { kind: "too-large"; limit: number; size: number; modifiedAt: number }
  | { kind: "invalid"; reason: DocxInvalidReason; size: number; modifiedAt: number };

/**
 * 打开时为文档补齐的段落标识（w14:paraId）的结果。
 *
 * 为什么要这一步（2026-10-27 实测，见 N2 调研）：选择性保存会**故意剥掉**引擎给无 paraId
 * 段落 mint 的 id（作者没写过 id 的段落要保持原样），于是「改一份 pandoc / python-docx /
 * WPS 产的论文 → 存盘 → 重开」后同一段的 blockId 变了，锚点全部失效。
 * 打开时先盖章（把 id 写进包、当作编辑基线），首次保存就会把它们写回文件——实测仍是
 * 选择性保存，不是整份重排，blockId 原样存活。
 *
 * `ok:false` 不是错误：签名包会被引擎拒绝（改包会作废数字签名），失败就退回「不盖章」，
 * 锚点只在本次打开内有效——如实告诉用户，不阻断打开。
 */
export interface DocxParaIdStamp {
  ok: boolean;
  /** 补上的段落数（0 = 这份文档本来就有完整标识） */
  assigned: number;
  /** 重复 id 被重新分配的段落数 */
  deduplicated: number;
  /** 没盖上时的原因（签名包 / 超时 / 引擎报错）；盖上时 null */
  reason: "signed" | "timeout" | "failed" | null;
}

/** 表格坐标（folio `FolioAIBlockTableLocation` 的字段，全零基）：块在它最内层表格里的位置 */
export interface DocxAnchorTable {
  tableIndex: number;
  rowIndex: number;
  cellIndex: number;
  paragraphIndex: number;
}

/**
 * 一处选区锚点（v1）。**这不是新协议**：每个字段都来自 folio 的原生物
 * （`FolioAITextRangeHandle` + `FolioAIBlockAnchor` + `FolioAIBlockTableLocation`），
 * 我们只把它们装进一个可 JSON 化、可跨进程、可写进消息正文的形状里。
 *
 * 坐标系是**块内干净偏移**：跳过已有的 deletion 标记，插入当普通文字。好处是抗文档级
 * 漂移——在选区之前插段落、改别的段落都不影响它（实测），比 StepMap / relative position
 * 简单可靠。失效由 `selectedTextHash`（选中的那截）与 `blockTextHash`（整块）两级判。
 */
export interface DocxAnchor {
  v: 1;
  /** 文档绝对路径（与 `<quoted_docx>` 的 path 同口径） */
  path: string;
  /** folio 的块 id：paraId 原样，或 `seq-NNNN` / `blank-NNNN` */
  blockId: string;
  /** 有文本块的 1 起序号（与 `seq-NNNN` 同一套语义）：id 失效时的位置兜底 */
  blockOrdinal: number;
  startOffset: number;
  endOffset: number;
  /** hash(干净文本里的选区)；偏移漂移即不符 */
  selectedTextHash: string;
  /** hash(规整后的整块干净文本)；folio 的 precondition */
  blockTextHash: string;
  /** 选区原文（干净文本切片——**不是** PM 的 textBetween：那会把已删除的字带出来） */
  quote: string;
  /** 前后文各 ≤32 字（干净文本），引文在块里重复时用来认是哪一处 */
  contextBefore: string;
  contextAfter: string;
  table: DocxAnchorTable | null;
  /** 打开（或上次保存）时磁盘内容的 hash —— 换了一份文档就整体失效 */
  docHash: string;
  /** 会话内编辑序号：两次锚点之间用户改过文档就变了（只用于「是不是同一时刻」的提示） */
  editSeq: number;
}

/** agent 的 `edit_docx` 目标：文件 + 所属会话（主进程据此现算白名单根） */
export interface DocxEditTarget {
  sessionId: string | null;
  workspaceId: string | null;
  /** 文档绝对路径 */
  path: string;
}

/**
 * agent → renderer 的一条写作请求。
 *
 * 三档寻址，从准到宽（降级链路见 renderer 的 docx-apply）：
 *   1. `anchor`：用户刚才选中的那一处（首选）；
 *   2. `blockId` + `find`：锚点失效但还知道块，在块内按文字找（唯一命中才写）；
 *   3. 只给 `find`：全文档只能有一处命中，否则拒绝（绝不猜）。
 * `replace` 为空串 = 删掉这一段。
 */
export interface DocxAgentEditRequest extends DocxEditTarget {
  anchor?: DocxAnchor | null;
  blockId?: string | null;
  find?: string | null;
  replace: string;
  /** 一句话说明（回执里给模型看；不写进文档） */
  note?: string | null;
}

/** 一条被写进文档的改动：**按 `revisionIds` 成组**（一次 replace 产出删除侧 + 插入侧两个 w:id） */
export interface DocxEditGroup {
  /** 请求里的 op id（模型自己起的） */
  id: string;
  blockId: string;
  revisionIds: number[];
  /** 被替换掉的原文（干净文本） */
  before: string;
  /** 替换后的文字 */
  after: string;
  /** 锚点失配后按上下文重新定位过 */
  reanchored: boolean;
}

/** 一条没写进去的操作与原因（引擎的 skip 原语 + 我们自己的判定） */
export interface DocxEditSkip {
  id: string;
  /** 引擎的 `FolioAIEditSkipReason`，或我们补的 `stale-anchor` / `ambiguous-anchor` / `missing-block` */
  reason: string;
  message?: string;
}

/**
 * 写不进去的原因：
 * - `not-open`：那份文档此刻没在应用内打开（唯一写入口是活编辑器）；
 * - `not-ready`：编辑器正在加载 / 排版，还没有可编辑视图（宿主会重试几百毫秒）；
 * - `stale`：选中的那处对不上了（内容被改过 / 出现多次），要重新选中；
 * - `busy`：renderer 超时没回执；`invalid`：路径或参数不合法；`engine`：其余引擎侧失败。
 */
export type DocxEditFailureReason = "not-open" | "not-ready" | "invalid" | "stale" | "busy" | "readonly" | "engine";

/**
 * `edit_docx` 的回执。**成功与失败都是值**：模型要据此决定重试、换个锚点，还是回来问用户。
 * `groups` 为空且 `skipped` 非空 = 一条也没写进去（一个字都没动）。
 */
export type DocxEditOutcome =
  | { ok: true; path: string; groups: DocxEditGroup[]; skipped: DocxEditSkip[]; note: string | null }
  | { ok: false; reason: DocxEditFailureReason; error: string };

/**
 * 主进程 → renderer 的编辑请求信封（renderer 按 requestId 回执）。
 *
 * `author` 由主进程给，**模型不能选**：docx 里的修订署名是「用户本人改的」——与保存时
 * 套用的作者戳（main/docx/metadata.ts）同一口径。谁改的（agent / 人）由我们自己的
 * 改动账（`revisionIds` 分组）区分，不靠作者名。
 */
export interface DocxEditRequestMessage {
  requestId: string;
  sessionId: string;
  author: string;
  request: DocxAgentEditRequest;
}

/** renderer → 主进程的回执信封 */
export interface DocxEditReplyMessage {
  requestId: string;
  outcome: DocxEditOutcome;
}

/** 主进程等 renderer 回执的上限：大文档 apply + 排版实测 0.1–1 s，10 s 是给病态文档留的余量 */
export const DOCX_EDIT_TIMEOUT_MS = 10_000;

export interface DocxSaveRequest {
  target: DocxTarget;
  /** 打开（或上次保存）时那份磁盘内容的 hash；与磁盘现状不一致 = 冲突 */
  expectedHash: string;
  /** 引擎序列化出来的整份 docx */
  data: Uint8Array;
}

/**
 * `docx:save` 的回执。**冲突是值不是异常**：外部改了文件是正常会发生的事，
 * renderer 要拿它弹出「重新加载 / 放弃保存」，不能走 catch 混进「保存失败」。
 */
export type DocxSaveResult =
  /**
   * 写入成功。`backupPath` 是上一版被复制到应用数据目录的位置（首次保存 / 磁盘上
   * 原本没有文件时是 null）；`hash` 是新内容的 hash，renderer 拿它做下一次的 expectedHash。
   */
  | { kind: "saved"; size: number; modifiedAt: number; hash: string; backupPath: string | null }
  /** 磁盘内容与 expectedHash 不一致（`missing` = 文件在外部被删了）：一个字节都没写 */
  | { kind: "conflict"; reason: "changed" | "missing"; modifiedAt: number | null };
