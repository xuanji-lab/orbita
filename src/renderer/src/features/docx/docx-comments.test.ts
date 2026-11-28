/**
 * 批注清单的纯逻辑：正文摘要、时间、排序、锚点、新批注模型。
 *
 * 这里要钉住的是「引擎给的原样数据 → 列表一行」的翻译：
 *   - 只列未解决的顶层批注，回复折算成计数；
 *   - 有锚点的按文档顺序（锚点数组本身是文档顺序），没锚点的排后面；
 *   - 锚点缺 blockId 时行仍然在，但 `blockId` 为 null（界面据此给「原文不在了」）；
 *   - 新建批注的对象形状与引擎自己的 createComment 一致（一段、一 run、一 text）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Comment } from "@stll/folio-core/types/document";
import {
  commentBodyText,
  commentDraftToComment,
  commentRows,
  formatCommentTime,
  nextCommentId,
  sameCommentAnchors,
  sameCommentQuote,
  sameComments,
} from "./docx-comments.ts";

function comment(
  id: number,
  text: string,
  overrides: Partial<Comment> = {},
): Comment {
  return {
    id,
    author: "张三",
    date: "2026-11-20T09:30:00Z",
    content: [
      {
        type: "paragraph",
        formatting: {},
        content: [{ type: "run", formatting: {}, content: [{ type: "text", text }] }],
      },
    ],
    ...overrides,
  };
}

describe("批注正文 → 一行摘要", () => {
  it("多段 / 嵌套 run 都取 text 节点，段落之间一个空格，空白折叠", () => {
    const value: Comment = {
      id: 1,
      author: "李四",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "run", content: [{ type: "text", text: "第一段" }] },
            { type: "run", content: [{ type: "text", text: " 链接" }] },
          ],
        },
        { type: "paragraph", content: [{ type: "run", content: [{ type: "text", text: "第二段  " }] }] },
      ],
    };
    assert.equal(commentBodyText(value), "第一段 链接 第二段");
  });

  it("一个字都没有时给可读占位，不让行高塌掉", () => {
    const empty: Comment = { id: 2, author: "王五", content: [] };
    assert.equal(commentBodyText(empty), "(空批注)");
    const blank: Comment = {
      id: 3,
      author: "王五",
      content: [{ type: "paragraph", content: [{ type: "run", content: [{ type: "text", text: "   " }] }] }],
    };
    assert.equal(commentBodyText(blank), "(空批注)");
  });
});

describe("批注时间", () => {
  it("缺失 / 空串 / 非法日期都返回空串，不显示 Invalid Date", () => {
    assert.equal(formatCommentTime(undefined, "zh-CN"), "");
    assert.equal(formatCommentTime("", "zh-CN"), "");
    assert.equal(formatCommentTime("不是日期", "zh-CN"), "");
  });

  it("合法 ISO 时间按当前语言格式化出非空短时间", () => {
    assert.notEqual(formatCommentTime("2026-11-20T09:30:00Z", "zh-CN"), "");
  });
});

describe("批注清单", () => {
  const anchors = [
    { commentId: 2, blockId: "B2", quote: "第二段的原文" },
    { commentId: 5, blockId: "B5", quote: "第五段的原文" },
    { commentId: 9, blockId: null, quote: "原文已删" },
  ];

  it("只列未解决的顶层批注，按锚点的文档顺序排，锚点缺失的排最后", () => {
    const rows = commentRows(
      [
        comment(2, "第二条"),
        comment(5, "第五条"),
        comment(3, "回复二", { parentId: 2 }),
        comment(4, "回复二之二", { parentId: 2 }),
        comment(7, "已解决", { done: true }),
        comment(9, "没有锚点"),
        comment(8, "完全没有锚点"),
      ],
      anchors,
      "zh-CN",
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      [2, 5, 9, 8],
    );
    assert.equal(rows[0]?.replyCount, 2);
    assert.equal(rows[0]?.blockId, "B2");
    assert.equal(rows[0]?.quote, "第二段的原文");
    assert.equal(rows[2]?.blockId, null);
    assert.equal(rows[2]?.quote, "原文已删");
    assert.equal(rows[3]?.blockId, null);
    assert.equal(rows[3]?.quote, "");
  });

  it("锚点查找只认第一次出现的 commentId（同一 id 不重复占两行）", () => {
    const rows = commentRows(
      [comment(2, "第二条")],
      [
        { commentId: 2, blockId: "A", quote: "第一次" },
        { commentId: 2, blockId: "B", quote: "第二次" },
      ],
      "zh-CN",
    );
    assert.equal(rows[0]?.blockId, "A");
    assert.equal(rows[0]?.quote, "第一次");
  });

  it("作者与摘要来自批注本体，没有正文的给占位", () => {
    const rows = commentRows(
      [
        comment(1, "第一段\n第二段", { author: "导师" }),
        { id: 2, author: "我", content: [] },
      ],
      [],
      "zh-CN",
    );
    assert.equal(rows[0]?.author, "导师");
    assert.equal(rows[0]?.summary, "第一段 第二段");
    assert.equal(rows[1]?.summary, "(空批注)");
  });

  it("两条都没有锚点时按 id（引擎递增铸号）排，不是按入参顺序", () => {
    const rows = commentRows([comment(6, "六"), comment(1, "一")], [], "zh-CN");
    assert.deepEqual(rows.map((row) => row.id), [1, 6]);
  });
});

describe("受控 comments 的等价判定与 id 分配", () => {
  it("同内容不同数组引用判等价（保住引用，避免每次敲键重渲染）", () => {
    const left = [comment(1, "同一条"), comment(2, "回复", { parentId: 1 })];
    const right = [comment(1, "同一条"), comment(2, "回复", { parentId: 1 })];
    assert.equal(left === right, false);
    assert.equal(sameComments(left, right), true);
  });

  it("作者 / 时间 / 解决态 / 正文任何一处变了都不等价", () => {
    const base = [comment(1, "原文")];
    assert.equal(sameComments(base, [comment(1, "原文", { author: "别人" })]), false);
    assert.equal(sameComments(base, [comment(1, "原文", { date: "2026-11-21T00:00:00Z" })]), false);
    assert.equal(sameComments(base, [comment(1, "原文", { done: true })]), false);
    assert.equal(sameComments(base, [comment(1, "改了")]), false);
    assert.equal(sameComments(base, [comment(1, "原文"), comment(2, "多一条")]), false);
  });

  it("下一个 id 取现有最大值 + 1；空数组从 0 起；负数不参与", () => {
    assert.equal(nextCommentId([]), 0);
    assert.equal(nextCommentId([{ id: 0 }, { id: 5 }, { id: 3 }]), 6);
    assert.equal(nextCommentId([{ id: -1 }, { id: 2 }]), 3);
  });
});

describe("新建批注", () => {
  it("生成引擎认的形状：一个段落 → 一个 run → 一个 text 节点", () => {
    const created = commentDraftToComment("  这里要补一句引用  ", "张三", 7, "2026-11-22T10:00:00.000Z");
    assert.equal(created.id, 7);
    assert.equal(created.author, "张三");
    assert.equal(created.date, "2026-11-22T10:00:00.000Z");
    assert.equal(created.parentId, undefined);
    assert.deepEqual(created.content, [
      {
        type: "paragraph",
        formatting: {},
        content: [
          {
            type: "run",
            formatting: {},
            content: [{ type: "text", text: "这里要补一句引用" }],
          },
        ],
      },
    ]);
    assert.equal(commentBodyText(created), "这里要补一句引用");
  });

  it("选区文字比对折叠空白；内容变了就判不一致（提交前要重新选）", () => {
    assert.equal(sameCommentQuote("第一段\n第二段", "第一段 第二段"), true);
    assert.equal(sameCommentQuote("  引用  ", "引用"), true);
    assert.equal(sameCommentQuote("改过了", "引用"), false);
  });

  it("锚点数组等价判定：id / 段落 / 引文任一处变了都算变了（别吞掉新锚点）", () => {
    const anchors = [
      { commentId: 1, blockId: "B1", quote: "一段" },
      { commentId: 2, blockId: null, quote: "" },
    ];
    assert.equal(sameCommentAnchors(anchors, anchors), true);
    assert.equal(
      sameCommentAnchors(anchors, [
        { commentId: 1, blockId: "B1", quote: "一段" },
        { commentId: 2, blockId: null, quote: "" },
      ]),
      true,
    );
    assert.equal(sameCommentAnchors(anchors, [{ commentId: 1, blockId: "B1", quote: "一段" }]), false);
    assert.equal(
      sameCommentAnchors(anchors, [
        { commentId: 1, blockId: "B1", quote: "一段" },
        { commentId: 2, blockId: "B2", quote: "" },
      ]),
      false,
    );
    assert.equal(
      sameCommentAnchors(anchors, [
        { commentId: 1, blockId: "B1", quote: "另一段" },
        { commentId: 2, blockId: null, quote: "" },
      ]),
      false,
    );
  });
});
