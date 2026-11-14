/**
 * docx 选区 → 锚点（N2「指哪打哪」的第一块）。
 *
 * **不自造协议**：这里产出的每个字段都来自 folio 的原生物——
 *   - `blockId`：`w14:paraId`（或引擎 mint 的随机 id），与 `FolioAIBlockAnchor.id` 同一来源；
 *   - `startOffset` / `endOffset` / `selectedTextHash`：`FolioAITextRangeHandle` 的形状；
 *   - `blockTextHash`：`hashFolioAIBlockText(normalizeFolioAIBlockText(block.text))`，即
 *     `FolioAIEditPrecondition` 用的那个指纹；
 *   - `table`：`FolioAIBlockTableLocation` 的子集。
 * 坐标是**块内干净偏移**——跳过已有的 deletion 标记、插入当普通文字。这条性质是整件事
 * 站得住的原因：在选区之前插段落 / 改别的段落都不会让锚点失效（实测），比 StepMap /
 * relative position 简单可靠。
 *
 * 干净文本用引擎自己的 `buildCleanBlockText`（`@stll/folio-core/ai-edits/clean-text`，
 * 包的 `./*` 导出映射能到，不在 `./ai-edits` 的具名导出行上）。**不自己再写一遍**：
 * 脚注标记、域结果、分页符三种结构原子的处理是引擎语义，复制一份迟早分叉。
 *
 * 这个文件是纯逻辑（PM 文档进、锚点出），不碰 React、不碰 IPC——单测直接构造 PM 文档跑。
 */
import type { Node } from "prosemirror-model";
import { buildCleanBlockText } from "@stll/folio-core/ai-edits/clean-text";
import { hashFolioAIBlockText, normalizeFolioAIBlockText } from "@stll/folio-core/ai-edits";
import type { ResolvedPos } from "prosemirror-model";
import type { DocxAnchor, DocxAnchorTable } from "@shared/docx";

/** 干净文本视图（与引擎 `CleanBlockText` 同形，只取我们用的两项） */
export interface CleanBlock {
  text: string;
  offsets: number[];
}

/** 选区所在的那个文本块 */
export interface SelectionBlock {
  /** 文本块节点（段落；表格单元格里的段落也是它） */
  node: Node;
  /** 节点在文档里的起始位置（`$pos.before(depth)`）——`buildCleanBlockText` 的 blockFrom */
  from: number;
}

/** 上下文各取多少字（够区分重复引文，又不把整段塞进消息） */
export const ANCHOR_CONTEXT_CHARS = 32;

/**
 * 位置 → 它所在的文本块。`depth` 处不是文本块（选区落在 doc 或表格结构上）返回 null。
 * 表格单元格里的段落同样是文本块：单元格选区天然支持，不需要另开一条路径。
 */
export function blockAt(doc: Node, pos: number): SelectionBlock | null {
  const asBlock = (found: ResolvedPos): SelectionBlock | null => {
    for (let depth = found.depth; depth >= 1; depth -= 1) {
      const node = found.node(depth);
      if (!node.isTextblock) continue;
      return { node, from: found.before(depth) };
    }
    return null;
  };
  if (pos < 0 || pos > doc.content.size) return null;
  return asBlock(doc.resolve(pos));
}

/** 文本块的干净文本（与引擎的 `buildCleanBlockText` 同参数：fieldResults:"text"） */
export function cleanBlockOf(block: SelectionBlock): CleanBlock {
  const clean = buildCleanBlockText(block.node, block.from, { fieldResults: "text" });
  return { text: clean.text, offsets: clean.offsets };
}

/**
 * PM 位置 → 干净偏移：数出「干净文本里位置小于它的字符」个数。
 *
 * `offsets` 单调不减，所以这等价于一次二分。被 deletion 标记包住的位置会落回它前面那个
 * 干净边界（跳过删除的字），这正是要的行为；位置超出块尾时饱和到 `text.length`。
 */
export function cleanOffsetOf(clean: CleanBlock, pos: number): number {
  const { offsets } = clean;
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] as number) < pos) low = mid + 1;
    else high = mid;
  }
  // 位置超出块尾（`offsets` 比字符数多一个尾巴）时饱和到文本长度
  return Math.min(low, clean.text.length);
}

/** 段落的 blockId：`w14:paraId`（引擎在无 paraId 时会给活文档 mint 一个，所以通常有值） */
export function paragraphBlockId(node: Node): string | null {
  const value = node.attrs["paraId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 有文本块的 1 起序号（与引擎 `seq-NNNN` 同一套语义：只数带文本的块）。
 * 一次文档遍历，只在建锚点时跑（选区事件本身不做全文档扫描）。
 */
export function blockOrdinal(doc: Node, blockFrom: number): number {
  let ordinal = 0;
  let found = 0;
  doc.descendants((node, pos) => {
    if (found !== 0) return false;
    if (!node.isTextblock) return true;
    if (node.textContent.trim().length === 0) return true;
    ordinal += 1;
    if (pos === blockFrom) found = ordinal;
    return true;
  });
  return found;
}

/**
 * 块在它最内层表格里的坐标（零基，同 `FolioAIBlockTableLocation`）。不在表格里回 null。
 * 只有表格内选区才付这份成本（要数前面的表格）。
 */
export function tableLocationOf(doc: Node, pos: number): DocxAnchorTable | null {
  const found = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  let tableDepth = -1;
  let rowDepth = -1;
  let cellDepth = -1;
  for (let depth = found.depth; depth >= 1; depth -= 1) {
    const name = found.node(depth).type.name;
    if (cellDepth === -1 && (name === "tableCell" || name === "tableHeader")) cellDepth = depth;
    if (rowDepth === -1 && name === "tableRow") rowDepth = depth;
    if (name === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth === -1 || rowDepth === -1 || cellDepth === -1) return null;
  const tableFrom = found.before(tableDepth);
  // 文档里第几张表：数它前面有几个 table 节点（不钻进表里，嵌套表按最外层算）
  let tableIndex = 0;
  let done = false;
  doc.descendants((node, at) => {
    if (done) return false;
    if (node.type.name !== "table") return true;
    if (at === tableFrom) {
      done = true;
      return false;
    }
    tableIndex += 1;
    return false;
  });
  // 下标一律取「上一层节点里的第几个孩子」：`index(depth)` 是**该层节点自己**的 child index
  // （实测：index(tableDepth) = 行号、index(rowDepth) = 格号、index(cellDepth) = 格内段落号）。
  // 合并单元格占一个槽位——正是 `FolioAIBlockTableLocation` 的物理下标语义
  return {
    tableIndex,
    rowIndex: found.index(tableDepth),
    cellIndex: found.index(rowDepth),
    paragraphIndex: found.index(cellDepth),
  };
}

/** 建锚点需要的全部输入（都由调用方从活编辑器里取） */
export interface AnchorInput {
  path: string;
  docHash: string;
  editSeq: number;
  block: SelectionBlock;
  /** 选区两端（PM 位置，TextSelection 的 from / to） */
  from: number;
  to: number;
  /** 文档根（算序号与表格坐标要） */
  doc: Node;
}

/**
 * 选区 → 锚点。**跨段落一律拒绝**（v1）：folio 的 textRange 是单块句柄，跨块要么拆成
 * 多条 op（一个批次里各块互不冲突，但语义与「改一处」不同），要么整段替换——两条都
 * 不是这一刀要做的。返回 null 让上层说一句「请在一个段落内选择」。
 */
export function anchorFromSelection(input: AnchorInput): DocxAnchor | null {
  const { block, from, to } = input;
  const blockEnd = block.from + block.node.nodeSize;
  // `to` 是排他端：只到块尾之后才算跨段（`to === blockEnd` 是「选到段落标记」，
  // 文字部分完整落在本段里，按块尾截取）
  if (to > blockEnd || from <= block.from) return null;
  const clean = cleanBlockOf(block);
  const startOffset = cleanOffsetOf(clean, from);
  const endOffset = Math.min(cleanOffsetOf(clean, to), clean.text.length);
  if (endOffset <= startOffset) return null;
  const quote = clean.text.slice(startOffset, endOffset);
  if (quote.trim().length === 0) return null;
  const blockId = paragraphBlockId(block.node);
  return {
    v: 1,
    path: input.path,
    // 没有 paraId 的段落在活编辑器里会被引擎 mint 一个（见锚点调研 §2.4），这里拿不到
    // 时留空串：上层会退到「整块定位 + 文字查找」，不猜一个假的 id
    blockId: blockId ?? "",
    blockOrdinal: blockOrdinal(input.doc, block.from),
    startOffset,
    endOffset,
    selectedTextHash: hashFolioAIBlockText(quote),
    blockTextHash: hashFolioAIBlockText(normalizeFolioAIBlockText(clean.text)),
    quote,
    contextBefore: clean.text.slice(Math.max(0, startOffset - ANCHOR_CONTEXT_CHARS), startOffset),
    contextAfter: clean.text.slice(endOffset, endOffset + ANCHOR_CONTEXT_CHARS),
    table: tableLocationOf(input.doc, from),
    docHash: input.docHash,
    editSeq: input.editSeq,
  };
}
