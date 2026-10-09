import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHIPS_MAX_LENGTH,
  chipRangeAfter,
  chipRangeBefore,
  mirrorSegments,
  parseChips,
} from "./composer-chips.ts";
import { whiteoutSegments } from "./whiteout-segments.ts";

describe("parseChips", () => {
  it("中英混排：句中的 /skill: token 认出来，散文不动", () => {
    deepStrictEqual(parseChips("先调用 /skill:pdf-tools 处理这个文件"), [
      { start: 4, end: 20, kind: "skill", target: "pdf-tools" },
    ]);
  });

  it("多个 token、跨多行", () => {
    const text = "先 /skill:a 再\n换行 /skill:b-b2 结束";
    deepStrictEqual(parseChips(text), [
      { start: 2, end: 10, kind: "skill", target: "a" },
      { start: 16, end: 27, kind: "skill", target: "b-b2" },
    ]);
  });

  it("消息开头（行首）也算——findSkillTokens 的边界语义", () => {
    deepStrictEqual(parseChips("/skill:x 走起"), [{ start: 0, end: 8, kind: "skill", target: "x" }]);
  });

  it("全角空格后也算（含 U+3000）", () => {
    deepStrictEqual(parseChips("　/skill:x"), [{ start: 1, end: 9, kind: "skill", target: "x" }]);
  });

  it("破损 token：空 target、非空白前导、缺冒号都不认", () => {
    deepStrictEqual(parseChips("/skill: 后面"), []);
    deepStrictEqual(parseChips("用/skill:x 紧贴"), []);
    deepStrictEqual(parseChips("/skillx:y 不是"), []);
    deepStrictEqual(parseChips("https://a/skill:x 路径"), []);
  });

  it("target 到下一个空白为止——粘连的标点一起进 chip（与发送端同语义）", () => {
    deepStrictEqual(parseChips("用 /skill:foo, 然后"), [
      { start: 2, end: 13, kind: "skill", target: "foo," },
    ]);
  });

  it("/mcp: 同一函数认（findInvocationTokens），kind 区分", () => {
    deepStrictEqual(parseChips("先 /skill:a 再 /mcp:filesystem 干活"), [
      { start: 2, end: 10, kind: "skill", target: "a" },
      { start: 13, end: 28, kind: "mcp", target: "filesystem" },
    ]);
    deepStrictEqual(parseChips("/mcp:x"), [{ start: 0, end: 6, kind: "mcp", target: "x" }]);
  });

  it("/mcp: 空 target 与非空白前导同样不认", () => {
    deepStrictEqual(parseChips("/mcp: 后"), []);
    deepStrictEqual(parseChips("用/mcp:x"), []);
  });

  it("超长文本不解析（性能闸，与修正液同一阈值）", () => {
    deepStrictEqual(parseChips("x".repeat(CHIPS_MAX_LENGTH) + " /skill:a"), []);
    deepStrictEqual(parseChips(""), []);
  });
});

describe("chipRangeBefore / chipRangeAfter —— 整删判定", () => {
  const text = "先 /skill:pdf-tools 处理";

  it("光标贴在 chip 尾：Backspace 整删", () => {
    deepStrictEqual(chipRangeBefore(text, 18), { start: 2, end: 18, kind: "skill", target: "pdf-tools" });
  });

  it("光标贴在 chip 头：Delete 前向整删", () => {
    deepStrictEqual(chipRangeAfter(text, 2), { start: 2, end: 18, kind: "skill", target: "pdf-tools" });
  });

  it("chip 头上按 Backspace 是删前一个字符（空格），chip 尾上按 Delete 是删后一个字符——都不整删", () => {
    deepStrictEqual(chipRangeBefore(text, 2), null);
    deepStrictEqual(chipRangeAfter(text, 18), null);
  });

  it("光标在 chip 中间（点进去）不整删：那是普通逐字编辑", () => {
    deepStrictEqual(chipRangeBefore(text, 8), null);
    deepStrictEqual(chipRangeAfter(text, 8), null);
  });

  it("两个 chip 背靠背（中间一个空格）：各自的边界只认自己", () => {
    const two = "/skill:a /skill:b";
    deepStrictEqual(chipRangeBefore(two, 8), { start: 0, end: 8, kind: "skill", target: "a" });
    deepStrictEqual(chipRangeBefore(two, 17), { start: 9, end: 17, kind: "skill", target: "b" });
    deepStrictEqual(chipRangeBefore(two, 9), null);
    deepStrictEqual(chipRangeAfter(two, 0), { start: 0, end: 8, kind: "skill", target: "a" });
  });
});

describe("mirrorSegments —— 修正液与 chip 的叠加", () => {
  it("chip 区间优先：本来垫修正液的英文 token 段改成 chip", () => {
    const text = "先 /skill:pdf-tools 处理";
    const chips = parseChips(text);
    deepStrictEqual(mirrorSegments(whiteoutSegments(text), chips), [
      { text: "先 ", whiteout: false, chip: false, pasteRun: false },
      { text: "/skill:pdf-tools", whiteout: false, chip: true, pasteRun: false },
      { text: " 处理", whiteout: false, chip: false, pasteRun: false },
    ]);
  });

  it("chip 前后的普通英文段照常垫修正液", () => {
    const text = "use /skill:pdf now";
    deepStrictEqual(mirrorSegments(whiteoutSegments(text), parseChips(text)), [
      { text: "use ", whiteout: true, chip: false, pasteRun: false },
      { text: "/skill:pdf", whiteout: false, chip: true, pasteRun: false },
      { text: " now", whiteout: true, chip: false, pasteRun: false },
    ]);
  });

  it("组词中的段落不垫修正液，chip 不受组词影响（token 是已落定的文本）", () => {
    const text = "abc /skill:x 拼音zhong";
    // 光标在「拼音」后打拼音 zhong：组词区间 [15, 20)
    const composition = { start: 15, end: 20 };
    deepStrictEqual(mirrorSegments(whiteoutSegments(text, composition), parseChips(text)), [
      { text: "abc ", whiteout: true, chip: false, pasteRun: false },
      { text: "/skill:x", whiteout: false, chip: true, pasteRun: false },
      { text: " 拼音zhong", whiteout: false, chip: false, pasteRun: false },
    ]);
  });

  it("无 chip 时与原修正液分段逐段一致", () => {
    const text = "中文english继续";
    deepStrictEqual(
      mirrorSegments(whiteoutSegments(text), []),
      whiteoutSegments(text).map((segment) => ({ ...segment, chip: false, pasteRun: false })),
    );
  });

  it("非 copybook 路径：整段无修正液，只切 chip", () => {
    deepStrictEqual(
      mirrorSegments([{ text: "先 /skill:x 后", whiteout: false }], parseChips("先 /skill:x 后")),
      [
        { text: "先 ", whiteout: false, chip: false, pasteRun: false },
        { text: "/skill:x", whiteout: false, chip: true, pasteRun: false },
        { text: " 后", whiteout: false, chip: false, pasteRun: false },
      ],
    );
  });

  it("粘贴展开段：只铺底色的段与 chip 同层切出", () => {
    deepStrictEqual(
      mirrorSegments([{ text: "看这段AAABBB如何", whiteout: false }], [], [{ start: 3, end: 9 }]),
      [
        { text: "看这段", whiteout: false, chip: false, pasteRun: false },
        { text: "AAABBB", whiteout: false, chip: false, pasteRun: true },
        { text: "如何", whiteout: false, chip: false, pasteRun: false },
      ],
    );
  });

  it("展开段与 chip 交叠：chip 优先，交叠部分归 chip", () => {
    deepStrictEqual(
      mirrorSegments([{ text: "0123456789", whiteout: false }], [{ start: 2, end: 4 }], [{ start: 3, end: 7 }]),
      [
        { text: "01", whiteout: false, chip: false, pasteRun: false },
        { text: "23", whiteout: false, chip: true, pasteRun: false },
        { text: "456", whiteout: false, chip: false, pasteRun: true },
        { text: "789", whiteout: false, chip: false, pasteRun: false },
      ],
    );
  });

  it("展开段在修正液之上：段的英文不再垫修正液，浅底色替代", () => {
    const text = "说english话";
    deepStrictEqual(mirrorSegments(whiteoutSegments(text), [], [{ start: 1, end: 8 }]), [
      { text: "说", whiteout: false, chip: false, pasteRun: false },
      { text: "english", whiteout: false, chip: false, pasteRun: true },
      { text: "话", whiteout: false, chip: false, pasteRun: false },
    ]);
  });
});
