import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ZOTERO_ANNOTATION_DEFAULT_LIMIT,
  ZOTERO_FULLTEXT_DEFAULT_CHARS,
  ZOTERO_FULLTEXT_MAX_CHARS,
  ZOTERO_SEARCH_DEFAULT_LIMIT,
  ZOTERO_SEARCH_MAX_LIMIT,
  type ZoteroAgentRequest,
  type ZoteroItemDetail,
  type ZoteroItemSummary,
  type ZoteroOutcome,
  type ZoteroResult,
  type ZoteroToolDetails,
} from "../shared/zotero.ts";
import type { RequestBroker } from "./request-broker.ts";

/**
 * agent 的 Zotero 只读工具组：zotero_search / zotero_item / zotero_fulltext。
 *
 * 数据在用户本机 Zotero 的数据目录里（它管条目、PDF、全文索引），Orbita 不另存 .bib / pdf / txt。
 * 三个工具都只是「requestId 问答」的薄包装（照 doc_export / terminal_* 的走法）：主进程
 * （src/main/zotero/service.ts）只读 Zotero 的数据目录——**Zotero 关着也能用**——把表里的数据收窄成
 * shared/zotero.ts 的窄类型；这里排成给模型读的文字，另在 `details.zotero` 给界面一份摘要（过程行的展开体，见 builtin-commands.ts）。
 *
 * **PDF 给原路径、不拷贝**：读条目列出附件在 Zotero storage 里的绝对路径，模型直接交给 read_pdf / cite_pdf；
 * cite_pdf 核验过的路径经「被引用的 PDF 原地授权」（shared/files.ts 的 `cited` 根）在文件面板原地打开——
 * 这里不新开任何白名单口子。
 * 读全文的文字可以直接拿去 cite_pdf：Zotero 10 抽全文用的也是 pdf.js（fulltext.js 的 PDFWorker.getFullText），
 * 2026-11-14 在用户真库 6 份 PDF × 15 句上实测，照全文缓存引用与照 read_pdf 输出引用的核验通过率相同（87/90 对 87/90），
 * 没过的全是跨页的句子（页与页之间是换页符 + 页码 / 页眉）。所以提示的是「一段引文别跨页」，不是「先用 read_pdf 再读一遍」。
 *
 * 权限：三个都是只读工具（shared/permission.ts 的 READ_ONLY_TOOLS），plan 档放行。
 * 描述刻意短（三条合计 ≤ 1500 字符，进系统提示词），怎么查准、怎么引用的细则在内置技能 `zotero` 里按需读。
 */

/** 主进程那边是一次本机读库（含取快照，实测几十毫秒）；这里只兜「主进程失联」 */
const ZOTERO_BROKER_TIMEOUT_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function line(item: ZoteroItemSummary): string {
  return [item.key, item.title, item.creators || null, item.year, item.itemType, item.hasPdf ? "PDF" : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

function formatSearch(result: Extract<ZoteroResult, { op: "search" }>, query: string | undefined): string {
  const scope = [query === undefined ? null : `"${query}"`, result.collection === null ? null : `in collection ${result.collection.path} (${result.collection.key})`]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (result.items.length === 0) {
    return result.total > 0
      ? `No items at offset ${result.offset}; ${result.total} match ${scope}.`
      : `No Zotero items match ${scope || "the filters"}. Every word must match; try fewer words or the author's surname alone (see the \`zotero\` skill).`;
  }
  const first = result.offset + 1;
  const last = result.offset + result.items.length;
  const more = last < result.total ? ` Pass offset: ${last} for more.` : "";
  const head = `Zotero: ${result.total} item${result.total === 1 ? "" : "s"} match ${scope || "the filters"}; showing ${first}–${last}.${more}`;
  return [head, ...result.items.map((item, i) => `${first + i}. ${line(item)}`), "Read one with zotero_item(key)."].join("\n");
}

function formatItem(item: ZoteroItemDetail): string {
  const lines: string[] = [`${item.key} · ${item.itemType}`, `Title: ${item.title}`, `URI: ${item.uri}`];
  if (item.creatorList.length > 0) lines.push(`Creators: ${item.creatorList.map((c) => (c.role === "" || c.role === "author" ? c.name : `${c.name} (${c.role})`)).join("; ")}`);
  if (item.year !== null) lines.push(`Year: ${item.year}`);
  for (const field of item.fields) lines.push(`${field.name}: ${field.value}`);
  if (item.collections.length > 0) lines.push(`Collections: ${item.collections.map((c) => `${c.path} (${c.key})`).join("; ")}`);
  if (item.tags.length > 0) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.abstract !== "") lines.push(`Abstract: ${item.abstract}`);
  if (item.attachments.length === 0) lines.push("Attachments: none");
  else {
    lines.push("Attachments:");
    for (const a of item.attachments) {
      const kind = a.contentType === "application/pdf" ? "PDF" : (a.contentType ?? a.linkMode);
      const where =
        a.path === null ? "no local file" : a.onDisk ? a.path : `${a.path} (not on this machine — Zotero lists it but the file is missing or not synced)`;
      lines.push(`- ${a.key} · ${kind} · ${a.filename ?? a.title} · ${where}`);
    }
    if (item.attachments.some((a) => a.contentType === "application/pdf" && a.onDisk)) {
      lines.push("Use the PDF path as is with read_pdf / cite_pdf (do not copy the file).");
    }
  }
  if (item.noteCount > 0) lines.push(`Child notes in Zotero: ${item.noteCount}`);
  if (item.annotationTotal === 0) lines.push("Annotations: none");
  else {
    const first = item.annotationOffset + 1;
    const last = item.annotationOffset + item.annotations.length;
    const more = last < item.annotationTotal ? ` Pass annotation_offset: ${last} for more.` : "";
    lines.push(
      item.annotations.length === 0
        ? `Annotations: ${item.annotationTotal} (none at offset ${item.annotationOffset}).`
        : `Annotations ${first}–${last} of ${item.annotationTotal}:${more}`,
    );
    for (const a of item.annotations) {
      const parts = [`- p.${a.pageLabel || "?"} ${a.type}${a.color === "" ? "" : ` ${a.color}`}`];
      if (a.text !== "") parts.push(`"${a.text}"`);
      if (a.comment !== "") parts.push(`comment: ${a.comment}`);
      lines.push(parts.join(" · "));
    }
  }
  return lines.join("\n");
}

function formatFulltext(result: Extract<ZoteroResult, { op: "fulltext" }>): string {
  const full = result.fulltext;
  if (full === null) {
    return result.pdfPath === null
      ? `Zotero has no full-text index for "${result.title}", and it has no PDF on this machine.`
      : `Zotero has no full-text index for "${result.title}". Read the PDF instead: read_pdf with path ${result.pdfPath}`;
  }
  const pages = full.indexedPages !== null && full.totalPages !== null ? `, index covers ${full.indexedPages}/${full.totalPages} pages` : "";
  const more = full.end < full.total ? ` Pass start: ${full.end} to continue.` : " End of text.";
  const head = `Full text of "${result.title}" (attachment ${full.attachmentKey}${pages}): characters ${full.start}–${full.end} of ${full.total}.${more}`;
  const pdf =
    full.path === null
      ? null
      : `PDF: ${full.path} — to quote, pass the exact text to cite_pdf with this path. Keep each quote within one page: pages are separated by a form-feed character, usually next to a page number or running header.`;
  return [head, pdf, "---", full.text].filter((part): part is string => part !== null).join("\n");
}

function detailsOf(result: ZoteroResult): ZoteroToolDetails {
  if (result.op === "search") {
    return {
      op: "search",
      total: result.total,
      offset: result.offset,
      collection: result.collection?.path ?? null,
      items: result.items.map((item) => ({ key: item.key, title: item.title, creators: item.creators, year: item.year })),
    };
  }
  if (result.op === "item") {
    const item = result.item;
    return {
      op: "item",
      key: item.key,
      title: item.title,
      attachments: item.attachments.map((a) => ({ name: a.filename ?? a.title, path: a.path, onDisk: a.onDisk })),
      annotationTotal: item.annotationTotal,
      annotationOffset: item.annotationOffset,
      annotationShown: item.annotations.length,
    };
  }
  const full = result.fulltext;
  return {
    op: "fulltext",
    title: result.title,
    range: full === null ? null : { start: full.start, end: full.end, total: full.total },
    path: full?.path ?? result.pdfPath,
  };
}

export function createZoteroTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  const ask = async (request: ZoteroAgentRequest, signal: AbortSignal | undefined): Promise<ZoteroResult> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const outcome = await broker.request<ZoteroOutcome>({ type: "zoteroRequest", sessionId, request }, ZOTERO_BROKER_TIMEOUT_MS);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  };
  const reply = (body: string, result: ZoteroResult) => ({
    content: [{ type: "text" as const, text: body }],
    details: { zotero: detailsOf(result) },
  });

  const search: ToolDefinition = {
    name: "zotero_search",
    label: "zotero_search",
    description:
      "Search the user's Zotero library (read-only, from Zotero's data on this computer; Zotero need not be running). Every word in query must match the title, a creator, the year or the publication. " +
      "Returns key, title, creators, year, item type and whether there is a PDF. Before the first zotero_* call in a conversation, read the `zotero` skill.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the title, author surname, year" },
        collection: { type: "string", description: "Collection name or key" },
        item_type: { type: "string", description: "e.g. journalArticle, book" },
        tag: { type: "string" },
        limit: { type: "number", description: `Default ${ZOTERO_SEARCH_DEFAULT_LIMIT}, max ${ZOTERO_SEARCH_MAX_LIMIT}` },
        offset: { type: "number" },
      },
    } as never,
    async execute(_id, params, signal) {
      const args = asRecord(params);
      const query = text(args["query"]);
      const collection = text(args["collection"]);
      const itemType = text(args["item_type"]);
      const tag = text(args["tag"]);
      const limit = int(args["limit"]);
      const offset = int(args["offset"]);
      const result = await ask(
        {
          op: "search",
          ...(query === undefined ? {} : { query }),
          ...(collection === undefined ? {} : { collection }),
          ...(itemType === undefined ? {} : { itemType }),
          ...(tag === undefined ? {} : { tag }),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        },
        signal,
      );
      if (result.op !== "search") throw new Error("Unexpected Zotero reply");
      return reply(formatSearch(result, query), result);
    },
  };

  const item: ToolDefinition = {
    name: "zotero_item",
    label: "zotero_item",
    description:
      "Read one Zotero item by key: metadata, abstract, collections, attachments with their local file paths (give a PDF path as is to read_pdf / cite_pdf; never copy it), " +
      `and the user's annotations (${ZOTERO_ANNOTATION_DEFAULT_LIMIT} per call).`,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Item key from zotero_search" },
        annotation_offset: { type: "number" },
      },
      required: ["key"],
    } as never,
    async execute(_id, params, signal) {
      const args = asRecord(params);
      const key = text(args["key"]);
      if (key === undefined) throw new Error('"key" is required (an 8-character key from zotero_search)');
      const annotationOffset = int(args["annotation_offset"]);
      const result = await ask({ op: "item", key, ...(annotationOffset === undefined ? {} : { annotationOffset }) }, signal);
      if (result.op !== "item") throw new Error("Unexpected Zotero reply");
      return reply(formatItem(result.item), result);
    },
  };

  const fulltext: ToolDefinition = {
    name: "zotero_fulltext",
    label: "zotero_fulltext",
    description:
      "Read an item's text from Zotero's full-text index, by character range (for finding and skimming). Without an index it says so and gives the PDF path for read_pdf.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Item or attachment key" },
        start: { type: "number", description: "First character, default 0" },
        length: { type: "number", description: `Default ${ZOTERO_FULLTEXT_DEFAULT_CHARS}, max ${ZOTERO_FULLTEXT_MAX_CHARS}` },
      },
      required: ["key"],
    } as never,
    async execute(_id, params, signal) {
      const args = asRecord(params);
      const key = text(args["key"]);
      if (key === undefined) throw new Error('"key" is required (an item key from zotero_search)');
      const start = int(args["start"]);
      const length = int(args["length"]);
      const result = await ask(
        { op: "fulltext", key, ...(start === undefined ? {} : { start }), ...(length === undefined ? {} : { length }) },
        signal,
      );
      if (result.op !== "fulltext") throw new Error("Unexpected Zotero reply");
      return reply(formatFulltext(result), result);
    },
  };

  return [search, item, fulltext];
}
