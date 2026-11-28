/**
 * 工具条的纯逻辑。钉住三件事：
 *   1. 窄栏门槛（520）：519 降级、520 不降级、还没量到（0）先按宽画；
 *   2. 窄栏到底收掉了哪两组按钮（对齐三档 / 两种列表各收成一个下拉）；
 *   3. 样式清单与激活态：只给文档真定义的样式，folio 的各种对齐值都落到三档里。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_STYLE_CHOICE,
  TOOLBAR_COMPACT_BELOW,
  alignmentIcon,
  listIcon,
  showsAlignmentButtons,
  showsListButtons,
  styleChoicesFrom,
  styleLabel,
  toolbarAlignment,
  toolbarDensity,
  toolbarList,
} from "./docx-toolbar.ts";

describe("docx 工具条：窄栏降级", () => {
  it("520 是分界：519 → compact，520 / 更宽 → wide", () => {
    assert.equal(TOOLBAR_COMPACT_BELOW, 520);
    assert.equal(toolbarDensity(519), "compact");
    assert.equal(toolbarDensity(520), "wide");
    assert.equal(toolbarDensity(700), "wide");
  });

  it("还没量到宽度（0）先按宽画，避免首帧闪一下再长按钮", () => {
    assert.equal(toolbarDensity(0), "wide");
  });

  it("窄栏把三档对齐与两种列表各收成一个下拉，宽栏才铺按钮", () => {
    assert.equal(showsAlignmentButtons("wide"), true);
    assert.equal(showsAlignmentButtons("compact"), false);
    assert.equal(showsListButtons("wide"), true);
    assert.equal(showsListButtons("compact"), false);
  });

  it("窄栏下拉的图标跟当前状态走（不让亮灯和触发器的图标说两件事）", () => {
    assert.equal(alignmentIcon("left"), "align-left");
    assert.equal(alignmentIcon("center"), "align-center");
    assert.equal(alignmentIcon("right"), "align-right");
    assert.equal(listIcon("none"), "list");
    assert.equal(listIcon("bullet"), "list");
    assert.equal(listIcon("numbered"), "list-ordered");
  });
});

describe("docx 工具条：段落样式清单", () => {
  it("按文档顺序给 styleId + 显示名；隐藏 / 非段落样式不收", () => {
    const choices = styleChoicesFrom([
      { styleId: "Normal", name: "Normal", type: "paragraph" },
      { styleId: "Heading1", name: "标题 1", type: "paragraph" },
      { styleId: "Heading2", name: "", type: "paragraph" },
      { styleId: "Hidden1", name: "隐藏", type: "paragraph", hidden: true },
      { styleId: "Char1", name: "字符", type: "character" },
      { styleId: "Half1", name: "半隐藏", type: "paragraph", semiHidden: true },
    ]);
    assert.deepEqual(choices, [
      { id: "Normal", label: "Normal" },
      { id: "Heading1", label: "标题 1" },
      { id: "Heading2", label: "Heading2" },
    ]);
  });

  it("重复 styleId 只留第一份；没有样式表时只给 Normal（不给假 Heading）", () => {
    const choices = styleChoicesFrom([
      { styleId: "Normal", name: "Normal", type: "paragraph" },
      { styleId: " Normal ", name: "重复", type: "paragraph" },
    ]);
    assert.deepEqual(choices, [{ id: "Normal", label: "Normal" }]);
    assert.deepEqual(styleChoicesFrom([]), [FALLBACK_STYLE_CHOICE]);
    assert.deepEqual(styleChoicesFrom([{ styleId: "  " }]), [FALLBACK_STYLE_CHOICE]);
  });

  it("触发器标签：命中用文档里的显示名，未定义退回 styleId，空退回 Normal", () => {
    const choices = styleChoicesFrom([
      { styleId: "Normal", name: "正文", type: "paragraph" },
      { styleId: "Quote", name: "引用", type: "paragraph" },
    ]);
    assert.equal(styleLabel(choices, "Quote"), "引用");
    assert.equal(styleLabel(choices, "Heading3"), "Heading3");
    assert.equal(styleLabel(choices, ""), "Normal");
  });
});

describe("docx 工具条：激活态归一化", () => {
  it("folio 的段落对齐值落到左 / 中 / 右三档", () => {
    assert.equal(toolbarAlignment("center"), "center");
    assert.equal(toolbarAlignment("right"), "right");
    assert.equal(toolbarAlignment("end"), "right");
    assert.equal(toolbarAlignment("left"), "left");
    assert.equal(toolbarAlignment("start"), "left");
    assert.equal(toolbarAlignment("both"), "left");
    assert.equal(toolbarAlignment(null), "left");
    assert.equal(toolbarAlignment(undefined), "left");
    assert.equal(toolbarAlignment(42), "left");
  });

  it("列表种类只认 bullet / numbered", () => {
    assert.equal(toolbarList("bullet"), "bullet");
    assert.equal(toolbarList("numbered"), "numbered");
    assert.equal(toolbarList("none"), "none");
    assert.equal(toolbarList(undefined), "none");
  });
});
