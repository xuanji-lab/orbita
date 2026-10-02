import { test } from "node:test";
import assert from "node:assert/strict";
import { isDrawerToggleShortcut } from "./drawer-shortcut.ts";

const event = (init: { ctrlKey?: boolean; altKey?: boolean; key: string; code: string }) => ({
  ctrlKey: init.ctrlKey ?? false,
  altKey: init.altKey ?? false,
  key: init.key,
  code: init.code,
});

test("Windows：key 就是 d / D（Shift），code 是 KeyD", () => {
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, altKey: true, key: "d", code: "KeyD" })), true);
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, altKey: true, key: "D", code: "KeyD" })), true);
});

test("macOS：Option 改变 event.key（Option+D → ∂，Shift+Option+D → Ï），靠 code 兜底", () => {
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, altKey: true, key: "∂", code: "KeyD" })), true);
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, altKey: true, key: "Ï", code: "KeyD" })), true);
});

test("缺修饰键、按错键都不算", () => {
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, key: "d", code: "KeyD" })), false);
  assert.equal(isDrawerToggleShortcut(event({ altKey: true, key: "d", code: "KeyD" })), false);
  assert.equal(isDrawerToggleShortcut(event({ ctrlKey: true, altKey: true, key: "e", code: "KeyE" })), false);
});
