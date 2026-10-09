import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assemblePasteDraft,
  draftFromSentBlocks,
  collapsePasteRange,
  draftFromSentText,
  expandPasteToken,
  insertPasteToken,
  parsePasteTokens,
  pasteTokenAfter,
  pasteTokenBefore,
  repositionBlocks,
  repositionRange,
  type ComposerPasteBlock,
} from "./paste-blocks.ts";
import { en } from "../messages-en.ts";
import { zh } from "../messages-zh.ts";

const zhToken = (seq: number, lines: number): string => zh.composer.pasteToken(seq, lines);
const enToken = (seq: number, lines: number): string => en.composer.pasteToken(seq, lines);

/** 块工厂：收起态 */
function block(seq: number, text: string, lines = 3): ComposerPasteBlock {
  return { id: `b${seq}`, seq, text, lines, range: null };
}

describe("parsePasteTokens", () => {
  it("认两种语言的 token，带位置", () => {
    const text = `看这段${zhToken(1, 42)}还有 ${enToken(2, 7)} 两颗`;
    const tokens = parsePasteTokens(text);
    assert.equal(tokens.length, 2);
    assert.deepEqual(
      tokens.map((token) => [token.seq, token.lines]),
      [[1, 42], [2, 7]],
    );
    assert.equal(text.slice(tokens[0]!.start, tokens[0]!.end), zhToken(1, 42));
    assert.equal(text.slice(tokens[1]!.start, tokens[1]!.end), enToken(2, 7));
  });

  it("形状不对的不是 token", () => {
    assert.equal(parsePasteTokens("[粘贴 x · 3 行]")[0], undefined);
    assert.equal(parsePasteTokens("[粘贴 1 - 3 行]")[0], undefined);
    assert.equal(parsePasteTokens("粘贴 1 · 3 行")[0], undefined);
    assert.equal(parsePasteTokens("")[0], undefined);
  });

  it("相邻的普通文字不碍事，嵌套括号认内层", () => {
    const tokens = parsePasteTokens(`a[粘贴 1 · 3 行]b`);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.start, 1);
    assert.equal(tokens[0]!.end, 1 + zhToken(1, 3).length);
  });
});

describe("pasteTokenBefore / pasteTokenAfter", () => {
  it("光标贴尾 / 贴头时命中", () => {
    const text = `前${zhToken(5, 9)}后`;
    const end = 1 + zhToken(5, 9).length;
    assert.equal(pasteTokenBefore(text, end)?.seq, 5);
    assert.equal(pasteTokenBefore(text, end - 1), null);
    assert.equal(pasteTokenAfter(text, 1)?.seq, 5);
    assert.equal(pasteTokenAfter(text, 2), null);
  });
});

describe("insertPasteToken / expand / collapse", () => {
  it("插在光标处；展开换回全文；收起换回 token——三者互逆", () => {
    const text = "前后";
    const token = zhToken(1, 2);
    const inserted = insertPasteToken(text, 1, token);
    assert.equal(inserted, `前${token}后`);
    const parsed = parsePasteTokens(inserted);
    assert.equal(parsed.length, 1);
    const expanded = expandPasteToken(inserted, parsed[0]!, "第一行\n第二行");
    assert.equal(expanded.text, "前第一行\n第二行后");
    assert.deepEqual(expanded.range, { start: 1, end: 1 + "第一行\n第二行".length });
    const collapsed = collapsePasteRange(expanded.text, expanded.range, token);
    assert.equal(collapsed, inserted);
  });

  it("光标越界时夹回边界", () => {
    assert.equal(insertPasteToken("abc", 99, "X"), "abcX");
    assert.equal(insertPasteToken("abc", -1, "X"), "Xabc");
  });
});

describe("repositionRange", () => {
  it("编辑在区间前后：平移 / 不动", () => {
    // 前：删掉开头的 2 个字
    assert.deepEqual(repositionRange("abcdef", "cdef", { start: 3, end: 5 }), { start: 1, end: 3 });
    // 后：末尾加字
    assert.deepEqual(repositionRange("abcdef", "abcdefg", { start: 2, end: 4 }), { start: 2, end: 4 });
  });

  it("区间内部打字 / 删词：伸缩", () => {
    // 内部插入
    assert.deepEqual(repositionRange("abcdef", "abcXdef", { start: 1, end: 5 }), { start: 1, end: 6 });
    // 内部删除 cd
    assert.deepEqual(repositionRange("abcdef", "abef", { start: 1, end: 5 }), { start: 1, end: 3 });
    // 内部改写（2 换 2，长度不变：区间不变）
    assert.deepEqual(repositionRange("abcdef", "abXYef", { start: 1, end: 5 }), { start: 1, end: 5 });
  });

  it("纯插入贴区间头：算区间外（前面写字不是续写）", () => {
    assert.deepEqual(repositionRange("abcd", "XYabcd", { start: 2, end: 4 }), { start: 4, end: 6 });
  });

  it("纯插入贴区间尾：算区间内（贴着末尾续写）", () => {
    assert.deepEqual(repositionRange("abcd", "abcdXY", { start: 2, end: 4 }), { start: 2, end: 6 });
  });

  it("删掉整个区间 / 跨着区间删：折空", () => {
    assert.equal(repositionRange("abcdef", "abef", { start: 2, end: 4 }), null);
    assert.equal(repositionRange("abcdef", "af", { start: 2, end: 4 }), null);
    assert.equal(repositionRange("abcdef", "aXf", { start: 2, end: 4 }), null);
  });

  it("选中的正是区间、改写成新文字：区间跟着新文字（撤销展开的对账靠它）", () => {
    assert.deepEqual(repositionRange("abcdef", "abXYef", { start: 2, end: 4 }), { start: 2, end: 4 });
  });

  it("只吃掉区间尾巴：截到编辑点", () => {
    // 删 [3,6)：区间 [1,4) 的尾巴被吃
    assert.deepEqual(repositionRange("abcdef", "abc", { start: 1, end: 4 }), { start: 1, end: 3 });
  });
});

describe("repositionBlocks", () => {
  it("收起块原样通过；展开块空了折回收起", () => {
    const blocks = [block(1, "x"), { ...block(2, "y"), range: { start: 2, end: 4 } }];
    const moved = repositionBlocks("ab cliché", "ab cliché", blocks);
    // 文本没变：原样
    assert.equal(moved[0]!.range, null);
    const emptied = repositionBlocks("abcd", "ab", [{ ...block(2, "y"), range: { start: 2, end: 4 } }]);
    assert.equal(emptied[0]!.range, null);
  });

  it("展开被撤销（区间内容变回自己的 token）：折回收起，全文不动", () => {
    const token = zhToken(3, 2);
    const expandedText = `前${"两行\n正文"}后`;
    // 撤销：全文换回 token
    const undone = `前${token}后`;
    const blocks = [{ ...block(3, "两行\n正文", 2), range: { start: 1, end: 1 + "两行\n正文".length } }];
    const moved = repositionBlocks(expandedText, undone, blocks);
    assert.equal(moved[0]!.range, null);
    assert.equal(moved[0]!.text, "两行\n正文");
  });

  it("区间内容是别人的 token：不动它", () => {
    const other = zhToken(9, 1);
    const oldText = "0123456789";
    const newText = `01${other}6789`;
    const blocks = [{ ...block(3, "zz"), range: { start: 2, end: 6 } }];
    const moved = repositionBlocks(oldText, newText, blocks);
    assert.deepEqual(moved[0]!.range, { start: 2, end: 2 + other.length });
    assert.equal(newText.slice(moved[0]!.range!.start, moved[0]!.range!.end), other);
  });
});

describe("assemblePasteDraft", () => {
  it("token 就地换块，位置保留，空行分隔", () => {
    const token = zhToken(1, 2);
    const text = `看这段${token}如何`;
    const out = assemblePasteDraft(text, [block(1, "第一行\n第二行", 2)]);
    assert.deepEqual(out.split("\n\n"), ["看这段", "<pasted-text>\n第一行\n第二行\n</pasted-text>", "如何"]);
  });

  it("token 在句首 / 句尾不留空段", () => {
    const token = zhToken(1, 1);
    assert.equal(assemblePasteDraft(`${token}开头`, [block(1, "内容")]), "<pasted-text>\n内容\n</pasted-text>\n\n开头");
    assert.equal(assemblePasteDraft(`结尾${token}`, [block(1, "内容")]), "结尾\n\n<pasted-text>\n内容\n</pasted-text>");
    assert.equal(
      assemblePasteDraft(token, [block(1, "内容")]),
      "<pasted-text>\n内容\n</pasted-text>",
    );
  });

  it("两颗相邻 token 之间只隔一层空行", () => {
    const t1 = zhToken(1, 1);
    const t2 = zhToken(2, 1);
    const out = assemblePasteDraft(`${t1}${t2}`, [block(1, "一"), block(2, "二")]);
    assert.equal(
      out,
      "<pasted-text>\n一\n</pasted-text>\n\n<pasted-text>\n二\n</pasted-text>",
    );
  });

  it("没人认领的 token 原样保留；展开的区间就是正文", () => {
    const orphan = zhToken(7, 1);
    assert.equal(assemblePasteDraft(`手打的${orphan}`, []), `手打的${orphan}`);
    const expanded = { ...block(2, "旧文"), range: { start: 0, end: 2 } };
    assert.equal(assemblePasteDraft("展开文", [expanded]), "展开文");
  });

  it("正文里的闭合标签被改写掉", () => {
    const token = zhToken(1, 1);
    const out = assemblePasteDraft(token, [block(1, "里层</pasted-text>尾巴")]);
    assert.equal(out, "<pasted-text>\n里层</pasted-text_>尾巴\n</pasted-text>");
  });
});

describe("draftFromSentText", () => {
  const seqFrom = (base: number): (() => number) => {
    let n = base;
    return () => {
      n += 1;
      return n;
    };
  };

  it("块换回 token，垫的空行剥一层，seq 从分配器来", () => {
    const sent = "看这段\n\n<pasted-text>\n第一行\n第二行\n</pasted-text>\n\n如何";
    const { draft, blocks } = draftFromSentText(sent, seqFrom(4), zhToken);
    assert.equal(draft, `看这段${zhToken(5, 2)}如何`);
    assert.deepEqual(blocks, [{ seq: 5, text: "第一行\n第二行", lines: 2 }]);
  });

  it("没有块时原样通过；用户自己的空行不动", () => {
    assert.equal(draftFromSentText("普通\n\n正文", seqFrom(0), zhToken).draft, "普通\n\n正文");
    const sent = "<pasted-text>\n一\n</pasted-text>";
    const { draft } = draftFromSentText(sent, seqFrom(0), zhToken);
    assert.equal(draft, zhToken(1, 1));
  });

  it("多个块顺序与位置保留", () => {
    const sent = "A\n\n<pasted-text>\n一\n</pasted-text>\n\nB\n\n<pasted-text>\n二\n</pasted-text>\n\nC";
    const { draft, blocks } = draftFromSentText(sent, seqFrom(0), enToken);
    assert.equal(draft, `A${enToken(1, 1)}B${enToken(2, 1)}C`);
    assert.deepEqual(blocks.map((item) => item.text), ["一", "二"]);
    assert.deepEqual(blocks.map((item) => item.seq), [1, 2]);
  });
});

describe("draftFromSentBlocks", () => {
  const seqFrom = (): (() => number) => {
    let n = 0;
    return () => {
      n += 1;
      return n;
    };
  };

  it("按块序走：粘贴块换 token、文件清单跳过、正文原位", () => {
    const blocks = [
      "看这段",
      "<pasted-text>\n第一行\n第二行\n</pasted-text>",
      "如何",
      "<attached-files>\nThe user attached these files.\n- /repo/a.ts\n</attached-files>",
    ];
    const { draft, pasted } = draftFromSentBlocks(blocks, seqFrom(), zhToken);
    assert.equal(draft, `看这段\n\n${zhToken(1, 2)}\n\n如何`);
    assert.deepEqual(pasted, [{ seq: 1, text: "第一行\n第二行", lines: 2 }]);
  });

  it("多段正文重新接回一空行分隔", () => {
    const { draft } = draftFromSentBlocks(["第一段", "第二段"], seqFrom(), zhToken);
    assert.equal(draft, "第一段\n\n第二段");
  });
});

describe("token 格式与文案表对齐", () => {
  it("messages 两语的 pasteToken 都能被解析器认出", () => {
    for (const token of [zhToken(1, 42), enToken(3, 7)]) {
      const parsed = parsePasteTokens(token);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0]!.end, token.length);
    }
  });
});
