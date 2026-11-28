/**
 * Word 批注的纯逻辑：正文摘要、时间、排序、锚点解析、新批注的模型对象。
 *
 * **为什么抽出来**：批注的元数据（作者 / 时间 / 正文）在 `Document.package.document.comments`
 * 里，锚点在 `getCommentAnchors()` 里，两边都只给引擎的原始形状。列表要的是「一行一条、
 * 能读出是谁什么时候说了什么、点一下能不能跳」，这层翻译与排序不依赖 React，也不起引擎。
 *
 * 能力边界（folio 0.62 / 0.30）：
 * - 读：`comments` prop / `DocxEditorRef.getCommentAnchors()`
 * - 加：引擎没有 `addComment()` 这样的公开 ref 方法；用**公开积木**组合——
 *   `addCommentMark(id)` + 受控 `comments` 数组 + 同 id 的 `Comment` 元数据。
 *   见 `DocxView.tsx` 的 `submitComment`。
 * - 删：`removeCommentMark(id)` + 从受控数组里去掉元数据（本 PR 只做读与加）。
 */
import type { Comment } from "@stll/folio-core/types/document";

/** 引擎给的批注锚点（`DocxEditorRef.getCommentAnchors()` 的元素形状） */
export interface CommentAnchorLike {
  commentId: number;
  blockId: string | null;
  quote: string;
}

/** 列表里的一行：只包含渲染需要的值，读起来不依赖引擎对象 */
export interface CommentRow {
  id: number;
  author: string;
  /** 已经按当前语言格式化过的时间；日期缺失 / 非法时为空串 */
  timeText: string;
  /** 批注正文的纯文本（段落之间一个空格） */
  summary: string;
  /** 锚到的原文；锚点缺失时为空串 */
  quote: string;
  /** 锚点还在时的段落 id；`null` = 这一条跳不过去 */
  blockId: string | null;
  /** 这条顶层批注下的回复数 */
  replyCount: number;
}

/** 新建批注时从选区带过来的东西 */
export interface CommentDraftRange {
  from: number;
  to: number;
  quote: string;
}

const EMPTY_SUMMARY = "(空批注)";

/** 批注正文里的所有 text 节点，按原顺序收集（嵌套的 run / hyperlink 都走同一支） */
function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (record["type"] === "text" && typeof record["text"] === "string") {
    out.push(record["text"]);
  }
  if (Array.isArray(record["content"])) collectText(record["content"], out);
}

/**
 * 批注正文 → 一行摘要。段落之间用空格（批注常见的多段回复读起来仍是一句话），
 * 空白折叠；一个字都没有时给一句可读的占位，而不是让行高塌掉。
 */
export function commentBodyText(comment: Pick<Comment, "content">): string {
  const text: string[] = [];
  collectText(comment.content, text);
  const joined = text.join(" ").replace(/\s+/g, " ").trim();
  return joined === "" ? EMPTY_SUMMARY : joined;
}

/** ISO 时间 → 本地化短时间；缺日期 / 解析不了就返回空串（不猜、不显示 Invalid Date） */
export function formatCommentTime(value: string | undefined, locale: string): string {
  if (value === undefined || value.trim() === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

/**
 * 批注清单 → 列表行。
 *
 * - 只列**顶层且未解决**的批注（Word 的批注卡默认也这样）；回复只折算成计数；
 * - 排序先按锚点在文档里的出现顺序（`anchors` 本身就是文档顺序），锚点缺失的排到
 *   最后再按时间；两处都缺就按 id（引擎铸 id 是递增的）。
 */
export function commentRows(
  comments: readonly Comment[],
  anchors: readonly CommentAnchorLike[],
  locale: string,
): CommentRow[] {
  const anchorIndex = new Map<number, number>();
  const anchorById = new Map<number, CommentAnchorLike>();
  anchors.forEach((anchor, index) => {
    if (!anchorById.has(anchor.commentId)) {
      anchorById.set(anchor.commentId, anchor);
      anchorIndex.set(anchor.commentId, index);
    }
  });
  const replyCount = new Map<number, number>();
  for (const comment of comments) {
    if (comment.parentId === undefined) continue;
    replyCount.set(comment.parentId, (replyCount.get(comment.parentId) ?? 0) + 1);
  }

  const rows: CommentRow[] = [];
  for (const comment of comments) {
    if (comment.parentId !== undefined) continue;
    if (comment.done === true) continue;
    const anchor = anchorById.get(comment.id);
    const blockId = anchor?.blockId ?? null;
    rows.push({
      id: comment.id,
      author: comment.author,
      timeText: formatCommentTime(comment.date, locale),
      summary: commentBodyText(comment),
      quote: anchor?.quote ?? "",
      blockId,
      replyCount: replyCount.get(comment.id) ?? 0,
    });
  }

  rows.sort((left, right) => {
    const leftIndex = anchorIndex.get(left.id);
    const rightIndex = anchorIndex.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return left.id - right.id;
  });
  return rows;
}

/**
 * 两个批注数组是否等价。受控 comments 的同步靠它**保住引用**：引擎每次编辑都会回
 * 一份新数组，无脑 `setState` 会让本组件每次敲键都重渲染一轮（同 `syncMarks` 的教训）。
 * 只比较渲染与保存真正用到的字段；正文按纯文本比。
 */
export function sameComments(left: readonly Comment[], right: readonly Comment[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as Comment;
    const b = right[index] as Comment;
    if (a.id !== b.id) return false;
    if (a.author !== b.author) return false;
    if (a.date !== b.date) return false;
    if (a.done !== b.done) return false;
    if (a.parentId !== b.parentId) return false;
    if (commentBodyText(a) !== commentBodyText(b)) return false;
  }
  return true;
}

/** 下一个可用的批注 id：现有最大 id + 1（引擎的 id 从 0 起，负数留给待定标记） */
export function nextCommentId(comments: readonly Pick<Comment, "id">[]): number {
  let max = -1;
  for (const comment of comments) {
    if (Number.isInteger(comment.id) && comment.id > max) max = comment.id;
  }
  return max + 1;
}

/**
 * 输入框里的文字 → 一条 `Comment`。形状照引擎自己的 `createComment`：
 * 一个段落、一个 run、一个 text 节点——多段落批注这一版不做，所以不摆多段的结构。
 */
export function commentDraftToComment(
  text: string,
  author: string,
  id: number,
  dateIso: string,
): Comment {
  const body = text.trim();
  return {
    id,
    author,
    date: dateIso,
    content: [
      {
        type: "paragraph",
        formatting: {},
        content: [
          {
            type: "run",
            formatting: {},
            content: [{ type: "text", text: body }],
          },
        ],
      },
    ],
  };
}

/** 选区文字是否还和记下来的引文一致（空白折叠后比）：不一致说明选中的内容已经变了 */
export function sameCommentQuote(current: string, recorded: string): boolean {
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  return normalize(current) === normalize(recorded);
}

/** 两组锚点是否等价（保住引用：文档每次变化都回一份新数组，无脑 setState 会多渲染一轮） */
export function sameCommentAnchors(
  left: readonly CommentAnchorLike[],
  right: readonly CommentAnchorLike[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as CommentAnchorLike;
    const b = right[index] as CommentAnchorLike;
    if (a.commentId !== b.commentId || a.blockId !== b.blockId || a.quote !== b.quote) return false;
  }
  return true;
}
