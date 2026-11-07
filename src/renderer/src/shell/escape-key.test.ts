import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMenuDismissKey, isUnclaimedEscape } from "./escape-key.ts";

const key = (key: string, defaultPrevented = false, isComposing = false) => ({ key, defaultPrevented, isComposing });

describe("全局 Esc 的认领判定", () => {
  it("没人认领的 Esc 才接；别的键不接", () => {
    assert.equal(isUnclaimedEscape(key("Escape")), true);
    assert.equal(isUnclaimedEscape(key("Enter")), false);
  });

  it("菜单 / 右键菜单 / 重命名框已 preventDefault 的 Esc 不接（否则菜单关了文档标签也被关）", () => {
    assert.equal(isUnclaimedEscape(key("Escape", true)), false);
  });

  it("输入法组词中的 Esc（取消组词）不接", () => {
    assert.equal(isUnclaimedEscape(key("Escape", false, true)), false);
  });
});

describe("打开着的菜单在文档级认领 Esc", () => {
  it("Esc 接；别的键与输入法组词中的 Esc 不接", () => {
    assert.equal(isMenuDismissKey({ key: "Escape", isComposing: false }), true);
    assert.equal(isMenuDismissKey({ key: "ArrowDown", isComposing: false }), false);
    assert.equal(isMenuDismissKey({ key: "Escape", isComposing: true }), false);
  });
});
