/**
 * agent 的 `edit_docx` → 活编辑器里的 tracked changes（N2 的第二块）。
 *
 * **唯一写入口**：`applyAIEditOperations`（folio 的编辑器 API）。不走主进程写盘：
 * 文件面板里这份文档带着用户未保存的改动，磁盘 hash 早过时，写盘会撞 #308 的
 * `expectedHash` 冲突并把用户改了半天的段落丢掉。
 *
 * 寻址三档，从准到宽（与 `shared/docx.ts` 的 `DocxAgentEditRequest` 对应）：
 *   1. 锚点（块 id + 块内干净偏移 + 选中文本哈希）——用户刚选中的那一处；
 *   2. 块 id + 文字——锚点偏移失配时在块内找，**必须唯一命中**；
 *   3. 只有文字——全文档只能有一处命中，否则拒绝（绝不猜）。
 *
 * 降级不是静默的：重定位过一次就在回执里标 `reanchored`，让模型与用户都知道
 * 「写下去的不是原始坐标」。
 *
 * 单测覆盖 `searchText` / `pickOccurrence` 这类纯函数（见 docx-apply.test.ts）；
 * 与引擎的往返在真机验收里跑（需要活的 ProseMirror 编辑器）。
 */
import type { Node } from "prosemirror-model";
import type { DocxEditorRef } from "@stll/folio-react";
import {
  createFolioAITextRangeHandle,
  hashFolioAIBlockText,
  isFolioAIContentBlock,
  normalizeFolioAIBlockText,
  resolveFolioAIBlockRange,
  type FolioAIEditSnapshot,
} from "@stll/folio-core/ai-edits";
import type { DocxAgentEditRequest, DocxEditGroup, DocxEditOutcome, DocxEditSkip } from "@shared/docx";
import { cleanBlockOf, type CleanBlock } from "./docx-anchor.ts";

/** 一次写入需要的活编辑器与身份（DocxView 组好传进来） */
export interface ApplyContext {
  ref: DocxEditorRef;
  /** 修订署名（主进程给的用户名，模型不能选） */
  author: string;
}

interface FoundRange {
  blockId: string;
  clean: CleanBlock;
  start: number;
  end: number;
  reanchored: boolean;
}

function failed(reason: Extract<DocxEditOutcome, { ok: false }>["reason"], error: string): DocxEditOutcome {
  return { ok: false, reason, error };
}

/** 空白压成一格后的搜索（引文里的 nbsp / 换行常常与原文字节不同形，先按原样找、再不敏感地找） */
interface Hit {
  start: number;
  end: number;
}

/**
 * 在 `text` 里找出 `needle` 的全部出现处。先逐字（区分大小写），没有就压平空白再找，
 * 把压平后的下标映射回原文。`needle` 为空 / 全空白 → 空数组（绝不返回零宽命中）。
 */
export function searchText(text: string, needle: string): Hit[] {
  const exact = needle.trim();
  if (exact === "") return [];
  const hits: Hit[] = [];
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    hits.push({ start: at, end: at + exact.length });
  }
  if (hits.length > 0) return hits;

  // 空白不敏感：两边都把连续空白压成一个空格，同时记下压平后每个字符对应的原文下标
  const flat = { text: "", map: [] as number[] };
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const space = /\s/.test(ch);
    if (space && lastWasSpace) continue;
    flat.text += space ? " " : ch;
    flat.map.push(i);
    lastWasSpace = space;
  }
  flat.map.push(text.length);
  const flatNeedle = exact.replace(/\s+/g, " ").trim();
  if (flatNeedle === "") return [];
  for (let at = flat.text.indexOf(flatNeedle); at !== -1; at = flat.text.indexOf(flatNeedle, at + 1)) {
    const start = flat.map[at] ?? 0;
    const end = flat.map[at + flatNeedle.length] ?? text.length;
    hits.push({ start, end });
  }
  return hits;
}

/** 严格唯一：只有一处命中才返回它 */
export function pickOccurrence(hits: readonly Hit[]): Hit | null {
  return hits.length === 1 ? (hits[0] as Hit) : null;
}

/** 片段在干净文本里的出现处（锚点失效后用引文重定位） */
function locateInBlock(clean: CleanBlock, text: string): Hit | null {
  const direct = pickOccurrence(searchText(clean.text, text));
  return direct;
}

/** 块 id：锚点 > 请求里的 blockId > 序号兜底（seq 语义：只数带文本的块） */
function candidateBlockIds(snapshot: FolioAIEditSnapshot, request: DocxAgentEditRequest): string[] {
  const ids: string[] = [];
  const push = (id: string | null | undefined): void => {
    if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
  };
  push(request.anchor?.blockId);
  push(request.blockId);
  const ordinal = request.anchor?.blockOrdinal ?? 0;
  if (ordinal > 0) {
    const content = snapshot.blocks.filter((block) => isFolioAIContentBlock(block));
    push(content[ordinal - 1]?.id);
  }
  return ids;
}

/** 解析块与块内范围；找不到就回一句能照着做的原因 */
function resolveRange(
  snapshot: FolioAIEditSnapshot,
  doc: Node,
  request: DocxAgentEditRequest,
): FoundRange | { error: string; reason: "stale-anchor" | "ambiguous-anchor" | "missing-block" } {
  const anchor = request.anchor ?? null;
  const wanted = request.find ?? anchor?.quote ?? "";
  const ids = candidateBlockIds(snapshot, request);

  // ① 锚点偏移：原样命中就用它；哈希对不上说明选区之后那段文字被改过
  for (const blockId of ids) {
    const range = resolveFolioAIBlockRange({ blockId, doc, snapshot });
    if (range === null) continue;
    const node = doc.nodeAt(range.from);
    if (node === null || !node.isTextblock) continue;
    const clean = cleanBlockOf({ node, from: range.from });
    if (anchor !== null && anchor.startOffset >= 0 && anchor.endOffset <= clean.text.length && anchor.endOffset > anchor.startOffset) {
      const slice = clean.text.slice(anchor.startOffset, anchor.endOffset);
      const fresh = anchor.selectedTextHash === "" || hashFolioAIBlockText(slice) === anchor.selectedTextHash;
      if (fresh && (wanted === "" || slice === wanted)) {
        return { blockId, clean, start: anchor.startOffset, end: anchor.endOffset, reanchored: false };
      }
    }
    // ② 块内按文字找（唯一命中才算）：锚点失效 / 只给了 blockId+find 都走这里
    if (wanted !== "") {
      const hit = locateInBlock(clean, wanted);
      if (hit !== null) return { blockId, clean, start: hit.start, end: hit.end, reanchored: anchor !== null };
      const all = searchText(clean.text, wanted);
      if (all.length > 1) {
        return { error: `这段文字在这一段里出现了 ${all.length} 次，无法确定改哪一处。请让用户重新选中要改的位置。`, reason: "ambiguous-anchor" };
      }
    }
  }

  // ③ 没给块（或块已不在）：全文档找唯一一处
  if (wanted !== "") {
    const matches: FoundRange[] = [];
    for (const block of snapshot.blocks) {
      if (!isFolioAIContentBlock(block)) continue;
      const range = resolveFolioAIBlockRange({ blockId: block.id, doc, snapshot });
      if (range === null) continue;
      const node = doc.nodeAt(range.from);
      if (node === null || !node.isTextblock) continue;
      const clean = cleanBlockOf({ node, from: range.from });
      for (const hit of searchText(clean.text, wanted)) {
        matches.push({ blockId: block.id, clean, start: hit.start, end: hit.end, reanchored: true });
      }
      if (matches.length > 1) break;
    }
    if (matches.length === 1) return matches[0] as FoundRange;
    if (matches.length > 1) {
      return { error: "这段文字在文档里出现了不止一次，无法确定改哪一处。请让用户选中要改的那一段。", reason: "ambiguous-anchor" };
    }
  }

  return {
    error:
      wanted === ""
        ? "没有给出可以定位的段落（既没有锚点也没有 find 文字）。请让用户选中要改的地方，或给出唯一的一段原文。"
        : ids.length === 0
          ? `这段文字在文档里没有找到：${wanted.slice(0, 40)}。请重新读一遍（read_docx）再定位。`
          : "用户选中的那段文字已经被改动过了，按原文也找不到了。请让用户重新选中。",
    reason: "stale-anchor",
  };
}

/**
 * 执行一条 `edit_docx`。同步（引擎的 apply 是同步的）——调用方包一层 async 即可。
 * 返回**值**而不是抛：写不进去的每种原因都是模型要读的结论。
 */
export function applyDocxEdit(context: ApplyContext, request: DocxAgentEditRequest): DocxEditOutcome {
  const ref = context.ref;
  const snapshot = ref.createAIEditSnapshot();
  if (snapshot === null) {
    return failed("not-ready", "编辑器还没就绪（文档还在排版 / 没有可编辑视图）。稍后再试，或让用户在编辑器里点一下。");
  }
  const view = ref.getEditorRef()?.getView() ?? null;
  if (view === null) {
    return failed("not-ready", "编辑器还没有可编辑视图，写不进去。");
  }
  const doc = view.state.doc;
  const found = resolveRange(snapshot, doc, request);
  if ("error" in found) {
    return { ok: false, reason: "stale", error: `${found.reason}: ${found.error}` };
  }
  const handle = createFolioAITextRangeHandle({
    blockId: found.blockId,
    text: found.clean.text,
    startOffset: found.start,
    endOffset: found.end,
  });
  if (handle === null) {
    return failed("stale", "这一处不能改（选中的范围切在结构原子或半个字上）。请让用户重新选中。");
  }
  const before = found.clean.text.slice(found.start, found.end);
  const result = ref.applyAIEditOperations({
    undefinedReferences: "refuse",
    snapshot,
    operations: [
      {
        id: "edit_docx",
        type: "replaceRange",
        range: handle,
        replace: request.replace,
        // 前置校验用**此刻**的整块指纹：它挡的是「我们算完范围到真正写入之间」的竞态，
        // 不是「用户选中之后块变过」——那种情况已经在上面按偏移 / 引文判定过了
        precondition: { blockTextHash: hashFolioAIBlockText(normalizeFolioAIBlockText(found.clean.text)) },
      },
    ],
    mode: "tracked-changes",
    author: context.author,
  });

  /*
   * 回执之后**复核一遍文档里到底有没有这些修订**。引擎在「视图只读」时会照常算出
   * `applied`（含 revisionIds），但把那次 dispatch 丢掉——实测过：回执说写好了，
   * 文档里一个标记都没有。不核对就会告诉模型「已写入」，用户却在审阅条里什么也看不到。
   * 一次 `getTrackedChanges()` 在大文档上约 40–50 ms，写入本来就少，值得。
   */
  const present = new Set(ref.getTrackedChanges().map((change) => change.id));
  const groups: DocxEditGroup[] = [];
  for (const applied of result.applied) {
    const ids = [...(applied.revisionIds ?? (applied.revisionId === undefined ? [] : [applied.revisionId]))].filter((id) => present.has(id));
    if (ids.length === 0) continue;
    groups.push({
      id: applied.id,
      blockId: found.blockId,
      revisionIds: ids,
      before,
      after: request.replace,
      reanchored: found.reanchored,
    });
  }
  const skipped: DocxEditSkip[] = result.skipped.map((skip) => ({
    id: skip.id,
    reason: skip.reason,
    ...(skip.message === undefined ? {} : { message: skip.message }),
  }));
  if (groups.length === 0) {
    const reason = skipped[0]?.reason ?? (result.applied.length > 0 ? "not-dispatched" : "unknown");
    return {
      ok: false,
      reason: reason === "preconditionFailed" || reason === "staleRange" || reason === "changedBlock" ? "stale" : "engine",
      error:
        reason === "not-dispatched"
          ? "引擎接受了这条改动，但编辑器没有把它落进文档（视图只读时 dispatch 会被丢弃）。请让用户确认编辑器不在只读状态再试。"
          : `引擎没有写入（${reason}${skipped[0]?.message === undefined ? "" : `：${skipped[0].message}`}）。`,
    };
  }
  return { ok: true, path: request.path, groups, skipped, note: request.note ?? null };
}

/** 裁决：按 `applied[].revisionIds` 整组接受 / 拒绝（一次 replace 有删除 + 插入两个 id） */
export function resolveRevisionGroup(ref: DocxEditorRef, revisionIds: readonly number[], decision: "accept" | "reject"): boolean {
  if (revisionIds.length === 0) return false;
  return decision === "accept" ? ref.acceptAIEditOperation(revisionIds) : ref.rejectAIEditOperation(revisionIds);
}
