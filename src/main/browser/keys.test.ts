import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseKeyCombo, type KeyStroke } from "./keys.ts";

const ok = (input: string, platform = "linux"): KeyStroke => {
  const stroke = parseKeyCombo(input, platform);
  if ("error" in stroke) throw new Error(stroke.error);
  return stroke;
};

describe("parseKeyCombo", () => {
  test("Enter 产生 \\r（表单提交靠它），Tab / 方向键不产生字符", () => {
    assert.deepEqual(ok("Enter"), { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r", commands: [] });
    assert.equal(ok("Tab").text, "");
    assert.equal(ok("ArrowDown").keyCode, 40);
  });

  test("别名与大小写：esc、return、pgdn、space 都认", () => {
    assert.equal(ok("esc").key, "Escape");
    assert.equal(ok("RETURN").key, "Enter");
    assert.equal(ok("pgdn").key, "PageDown");
    assert.deepEqual([ok("Space").key, ok("Space").text], [" ", " "]);
    assert.equal(ok("arrowup").key, "ArrowUp");
  });

  test("修饰键位：Alt=1 Control=2 Meta=4 Shift=8；Shift+Tab", () => {
    const stroke = ok("Shift+Tab");
    assert.equal(stroke.modifiers, 8);
    assert.equal(stroke.key, "Tab");
    assert.equal(ok("Ctrl+Alt+Delete").modifiers, 3);
  });

  test("字母：Shift 或大写都给大写 key，code 不变；带 Control / Meta 不输入字符", () => {
    assert.deepEqual([ok("a").key, ok("a").text, ok("a").code, ok("a").keyCode], ["a", "a", "KeyA", 65]);
    assert.equal(ok("Shift+a").key, "A");
    assert.equal(ok("A").text, "A");
    assert.equal(ok("Control+a").text, "");
    assert.equal(ok("7").code, "Digit7");
  });

  test("ControlOrMeta：macOS 是 Meta（并带编辑命令），其它平台是 Control", () => {
    const mac = ok("ControlOrMeta+A", "darwin");
    assert.equal(mac.modifiers, 4);
    assert.deepEqual(mac.commands, ["selectAll"]);
    const win = ok("ControlOrMeta+A", "win32");
    assert.equal(win.modifiers, 2);
    assert.deepEqual(win.commands, []);
    assert.deepEqual(ok("Meta+Shift+z", "darwin").commands, ["redo"]);
    assert.deepEqual(ok("Meta+z", "darwin").commands, ["undo"]);
  });

  test("F 键与「+」本身", () => {
    assert.equal(ok("F5").keyCode, 116);
    assert.equal(ok("+").key, "+");
    assert.deepEqual([ok("Shift++").key, ok("Shift++").modifiers], ["+", 8]);
  });

  test("认不出的给出能指导模型改写的错误", () => {
    assert.match(String((parseKeyCombo("Hyper+a", "linux") as { error: string }).error), /Unknown modifier/);
    assert.match(String((parseKeyCombo("Launch", "linux") as { error: string }).error), /Unknown key/);
    assert.match(String((parseKeyCombo("  ", "linux") as { error: string }).error), /empty/);
  });
});
