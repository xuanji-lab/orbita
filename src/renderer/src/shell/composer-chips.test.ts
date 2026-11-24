import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHIPS_MAX_LENGTH,
  chipIconName,
  chipRangeAfter,
  chipRangeBefore,
  chipRemovalRange,
  mirrorSegments,
  parseChips,
  snapSelection,
} from "./composer-chips.ts";

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

  it("/plugin: 同一函数认，kind 为 plugin；前导与空 target 规则同 skill", () => {
    deepStrictEqual(parseChips("再用 /plugin:lit-tracker 看一下"), [
      { start: 3, end: 22, kind: "plugin", target: "lit-tracker" },
    ]);
    deepStrictEqual(parseChips("/plugin: 后"), []);
    deepStrictEqual(parseChips("用/plugin:x"), []);
  });

  it("chipIconName：技能书、MCP 插头、插件积木（FEATURE_ICON.plugins）", () => {
    deepStrictEqual([chipIconName("skill"), chipIconName("mcp"), chipIconName("plugin")], ["book-open", "plug", "blocks"]);
  });

  it("/mcp: 空 target 与非空白前导同样不认", () => {
    deepStrictEqual(parseChips("/mcp: 后"), []);
    deepStrictEqual(parseChips("用/mcp:x"), []);
  });

  it("超长文本不解析（每次按键重扫的性能闸）", () => {
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

describe("mirrorSegments —— chip 与粘贴展开段的叠加", () => {
  it("按 chip 区间切段，普通文字原样保留", () => {
    const text = "先 /skill:pdf-tools 处理";
    deepStrictEqual(mirrorSegments(text, parseChips(text)), [
      { text: "先 ", chip: false, pasteRun: false },
      { text: "/skill:pdf-tools", chip: true, chipKind: "skill", pasteRun: false },
      { text: " 处理", chip: false, pasteRun: false },
    ]);
  });

  it("没有 chip 与展开段时整段返回；空文本没有分段", () => {
    deepStrictEqual(mirrorSegments("中文 english 继续", []), [
      { text: "中文 english 继续", chip: false, pasteRun: false },
    ]);
    deepStrictEqual(mirrorSegments("", []), []);
  });

  it("粘贴展开段：只铺底色的段与 chip 同层切出", () => {
    deepStrictEqual(mirrorSegments("看这段AAABBB如何", [], [{ start: 3, end: 9 }]), [
      { text: "看这段", chip: false, pasteRun: false },
      { text: "AAABBB", chip: false, pasteRun: true },
      { text: "如何", chip: false, pasteRun: false },
    ]);
  });

  it("chip 分段带 kind：skill / mcp 各自带上，不带 kind 的是中性胶囊", () => {
    const text = "用 /skill:a 和 /mcp:b 两个";
    deepStrictEqual(mirrorSegments(text, parseChips(text)).filter((seg) => seg.chip), [
      { text: "/skill:a", chip: true, chipKind: "skill", pasteRun: false },
      { text: "/mcp:b", chip: true, chipKind: "mcp", pasteRun: false },
    ]);
    deepStrictEqual(mirrorSegments("0123", [{ start: 1, end: 3 }]).filter((seg) => seg.chip), [
      { text: "12", chip: true, pasteRun: false },
    ]);
  });

  it("展开段与 chip 交叠：chip 优先，交叠部分归 chip", () => {
    deepStrictEqual(mirrorSegments("0123456789", [{ start: 2, end: 4 }], [{ start: 3, end: 7 }]), [
      { text: "01", chip: false, pasteRun: false },
      { text: "23", chip: true, pasteRun: false },
      { text: "456", chip: false, pasteRun: true },
      { text: "789", chip: false, pasteRun: false },
    ]);
  });

  it("名字里有中文的 token 仍是一颗 chip，拼回去逐字等于原文", () => {
    const text = "用 /skill:笔记 整理";
    const segments = mirrorSegments(text, parseChips(text));
    deepStrictEqual(segments.filter((seg) => seg.chip), [
      { text: "/skill:笔记", chip: true, chipKind: "skill", pasteRun: false },
    ]);
    deepStrictEqual(segments.map((seg) => seg.text).join(""), text);
  });

  it("展开段先开头、与后面的 chip 交叠：chip 仍是整颗", () => {
    deepStrictEqual(mirrorSegments("0123456789", [{ start: 3, end: 6 }], [{ start: 1, end: 5 }]), [
      { text: "0", chip: false, pasteRun: false },
      { text: "12", chip: false, pasteRun: true },
      { text: "345", chip: true, pasteRun: false },
      { text: "6789", chip: false, pasteRun: false },
    ]);
  });
});

describe("snapSelection —— 光标与选区不停在胶囊中间", () => {
  // 「看 /skill:ab 再」：chip [2, 11)
  const text = "看 /skill:ab 再";
  const chips = parseChips(text);
  const at = (position: number) => ({ start: position, end: position });

  it("没有 chip、或端点不在 chip 中间：原样", () => {
    deepStrictEqual(snapSelection([], at(5), null), at(5));
    deepStrictEqual(snapSelection(chips, at(2), at(1)), at(2));
    deepStrictEqual(snapSelection(chips, at(11), at(12)), at(11));
    deepStrictEqual(snapSelection(chips, { start: 0, end: 13 }, null), { start: 0, end: 13 });
  });

  it("← 从胶囊尾进来：一步跨到胶囊头", () => {
    deepStrictEqual(snapSelection(chips, at(10), at(11)), at(2));
  });

  it("→ 从胶囊头进来：一步跨到胶囊尾", () => {
    deepStrictEqual(snapSelection(chips, at(3), at(2)), at(11));
  });

  it("↑↓ 从别的行落进来：按来的方向（上一次光标在左 = 往右走）", () => {
    deepStrictEqual(snapSelection(chips, at(6), at(0)), at(11));
    deepStrictEqual(snapSelection(chips, at(6), at(13)), at(2));
  });

  it("点进胶囊（没有方向）：落到最近的一边，正中间算尾", () => {
    deepStrictEqual(snapSelection(chips, at(4), null), at(2));
    deepStrictEqual(snapSelection(chips, at(9), null), at(11));
  });

  it("Shift+→ 扩选进胶囊：整颗选上", () => {
    deepStrictEqual(snapSelection(chips, { start: 2, end: 3 }, at(2)), { start: 2, end: 11 });
  });

  it("Shift+← 缩选退进胶囊：整颗让出去", () => {
    deepStrictEqual(snapSelection(chips, { start: 0, end: 10 }, { start: 0, end: 11 }), { start: 0, end: 2 });
  });

  it("起点往左扩进胶囊：整颗选上；起点往右缩进胶囊：整颗让出去", () => {
    deepStrictEqual(snapSelection(chips, { start: 10, end: 13 }, { start: 11, end: 13 }), { start: 2, end: 13 });
    deepStrictEqual(snapSelection(chips, { start: 3, end: 13 }, { start: 2, end: 13 }), { start: 11, end: 13 });
  });

  it("双击 / 拖选落在胶囊里（指针，没有方向）：向外扩成整颗", () => {
    deepStrictEqual(snapSelection(chips, { start: 4, end: 9 }, null), { start: 2, end: 11 });
  });
});

describe("chipRemovalRange —— 点 × 删整颗", () => {
  it("连带后面的一个空格（插入 token 自带的那个）", () => {
    const text = "看 /skill:ab 再";
    deepStrictEqual(chipRemovalRange(text, parseChips(text)[0]!), { start: 2, end: 12 });
  });

  it("句末没有后空格：带走前面的一个，不留行尾空格", () => {
    const text = "看 /skill:ab";
    deepStrictEqual(chipRemovalRange(text, parseChips(text)[0]!), { start: 1, end: 11 });
  });

  it("行首、后面紧跟换行：只删 token，换行不动", () => {
    const text = "/mcp:git\n下一行";
    deepStrictEqual(chipRemovalRange(text, parseChips(text)[0]!), { start: 0, end: 8 });
  });
});
