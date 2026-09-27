import { test } from "node:test";
import assert from "node:assert/strict";
import { browserShortcut, type KeyInput } from "./shortcuts.ts";

const key = (patch: Partial<KeyInput>): KeyInput => ({
  type: "keyDown",
  key: "",
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...patch,
});

test("macOS 用 Cmd，Windows / Linux 用 Ctrl", () => {
  assert.equal(browserShortcut(key({ key: "r", meta: true }), "darwin"), "reload");
  assert.equal(browserShortcut(key({ key: "r", control: true }), "darwin"), null);
  assert.equal(browserShortcut(key({ key: "r", control: true }), "win32"), "reload");
  assert.equal(browserShortcut(key({ key: "l", meta: true }), "darwin"), "focus-address");
  assert.equal(browserShortcut(key({ key: "[", meta: true }), "darwin"), "back");
  assert.equal(browserShortcut(key({ key: "]", control: true }), "linux"), "forward");
});

test("F5 各平台都是刷新；Cmd+Shift+R 也是刷新", () => {
  assert.equal(browserShortcut(key({ key: "F5" }), "darwin"), "reload");
  assert.equal(browserShortcut(key({ key: "R", meta: true, shift: true }), "darwin"), "reload");
});

test("Alt + 方向键只在 Windows / Linux 生效（macOS 上那是按词移动光标）", () => {
  assert.equal(browserShortcut(key({ key: "ArrowLeft", alt: true }), "win32"), "back");
  assert.equal(browserShortcut(key({ key: "ArrowRight", alt: true }), "linux"), "forward");
  assert.equal(browserShortcut(key({ key: "ArrowLeft", alt: true }), "darwin"), null);
});

test("keyUp 与普通按键不拦", () => {
  assert.equal(browserShortcut(key({ type: "keyUp", key: "r", meta: true }), "darwin"), null);
  assert.equal(browserShortcut(key({ key: "r" }), "darwin"), null);
  assert.equal(browserShortcut(key({ key: "l", meta: true, shift: true }), "darwin"), null);
});
