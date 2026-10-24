/**
 * 保存前的「整份重排」判定 —— 纯函数，`node --test` 直接可测（同 preview-view.ts 的分工：
 * 判据在这里，React 与 IPC 在 DocxView.tsx）。
 *
 * 为什么需要这一刀：引擎（@stll/folio 0.30 / folio-core 0.62）保存时先尝试**选择性保存**
 * ——只把改动过的段落补进原来的 word/document.xml，包的其余部分原样保留；补不了的时候
 * 整份从文档模型重新生成（full repack）。重排之后版式可能整体挪动（页码、分页位置），
 * 所以保存前必须先告诉用户，并保住上一版。
 *
 * 哪些情况会整份重排（判据来自 folio-core `docx/selectiveSave.ts` 的 `attemptSelectiveSave`
 * 的 bail 分支，并用验收实例的 tripwire 实测过）：
 *  - `hasUntrackedChanges`：改动落在引擎拿不到稳定 paraId 的段落上。
 *    **实测补充**：引擎解析时会自己 mint paraId（python-docx 生成、一个 paraId 都没有的
 *    样本 zh.docx，解析后 40 段全部有 id），所以「源文件缺 paraId」本身不是触发条件，
 *    这条不在这里判——按它判会让每一份非 Word 生成的文档每次都报警。
 *  - `structuralChange`：段落 / 表格的成员或顺序变了（回车拆段、删段、粘贴整块内容）。
 *    实测：拆一段 → tripwire 报 `selective-returned-null` → 整份重排。
 *  - 新增的编号定义（`w:num`）：选择性保存只补已存在的定义，新增就 bail。
 *  - 新图片等「未落地的内联资源」：选择性保存不写新的 media，bail。
 *  - 原包大于 selectiveSaveMaxBytes（默认 100 MB）：本仓的打开上限 50 MB 已经挡住了。
 *
 * 所以这里比对的是「打开时的文档事实」与「保存前的文档事实」：段落数 / 表格数变了算结构
 * 变化，图片数增加算新图片，编号 id 多出来算新编号定义。宁可多提示一次（用户点一下
 * 「仍然保存」），也不静默重排一遍用户看不见版式变化。
 */

/** 判定只需要这四类事实；用最小接口而不是 ProseMirror 的 Node，测试不必造 schema */
export interface DocxFactsNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  forEach: (fn: (node: DocxFactsNode) => void) => void;
}

export interface DocxDocFacts {
  paragraphs: number;
  tables: number;
  images: number;
  /** 段落引用到的编号定义 id（w:numPr/w:numId），去重排序 */
  numberingIds: number[];
}

/**
 * 需要确认的原因。前三种由文档事实比对得出（`docxRepackReasons`）；`engine` 是引擎
 * 自己报的保真回退（onError 里的 "fidelity fallback"）——事实比对没覆盖到的情况由它兜底，
 * 于是「没预判到就静默重排」不可能发生，最坏是多重排一次（产物没写盘就被丢掉）。
 */
export type DocxRepackReason = "structure" | "image" | "numbering" | "engine";

/**
 * 清点一份文档（ProseMirror doc 或其子树）。编号 id 只收数字形式——引擎的 numPr 是
 * 模型里的 `{numId, ilvl}`，字符串形态（老快照）读不到就当没有，不会伪造出 id。
 */
export function docxFacts(doc: DocxFactsNode): DocxDocFacts {
  const facts: DocxDocFacts = { paragraphs: 0, tables: 0, images: 0, numberingIds: [] };
  const numbering = new Set<number>();
  const walk = (node: DocxFactsNode): void => {
    if (node.type.name === "paragraph") {
      facts.paragraphs += 1;
      const numPr = node.attrs["numPr"];
      if (typeof numPr === "object" && numPr !== null) {
        const numId = (numPr as { numId?: unknown }).numId;
        if (typeof numId === "number" && Number.isFinite(numId)) numbering.add(numId);
      }
    } else if (node.type.name === "table") {
      facts.tables += 1;
    } else if (node.type.name === "image") {
      facts.images += 1;
    }
    node.forEach(walk);
  };
  walk(doc);
  facts.numberingIds = [...numbering].sort((a, b) => a - b);
  return facts;
}

/** 保存前的判定：返回需要提示的原因（空数组 = 选择性保存能覆盖，静默保存） */
export function docxRepackReasons(before: DocxDocFacts, after: DocxDocFacts): DocxRepackReason[] {
  const reasons: DocxRepackReason[] = [];
  if (before.paragraphs !== after.paragraphs || before.tables !== after.tables) reasons.push("structure");
  if (after.images > before.images) reasons.push("image");
  const known = new Set(before.numberingIds);
  if (after.numberingIds.some((id) => !known.has(id))) reasons.push("numbering");
  return reasons;
}
