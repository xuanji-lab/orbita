import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseGate, mainWindowShortcut, trayLabels, type KeyInput } from "./close-to-tray.ts";

const key = (patch: Partial<KeyInput>): KeyInput => ({
  type: "keyDown",
  key: "",
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...patch,
});

test("Windows / Linux：关窗是隐藏，不是退出", () => {
  for (const platform of ["win32", "linux"] as const) {
    const gate = new CloseGate();
    assert.deepEqual(gate.decide(platform), { action: "hide", hint: true });
  }
});

test("气泡只给一次：第二次关窗还是隐藏，但不再提示", () => {
  const gate = new CloseGate();
  assert.equal(gate.decide("win32").hint, true);
  assert.deepEqual(gate.decide("win32"), { action: "hide", hint: false });
  assert.deepEqual(gate.decide("win32"), { action: "hide", hint: false });
});

test("真退出开始之后一律放行——否则应用关不掉", () => {
  const gate = new CloseGate();
  gate.beginQuit();
  assert.deepEqual(gate.decide("win32"), { action: "close", hint: false });
  assert.deepEqual(gate.decide("win32"), { action: "close", hint: false });
});

test("darwin 不接这套：关窗就是关窗（那边进程本来就留着，点 Dock 回来）", () => {
  const gate = new CloseGate();
  assert.deepEqual(gate.decide("darwin"), { action: "close", hint: false });
  assert.deepEqual(gate.decide("darwin"), { action: "close", hint: false });
});

test("退出键：darwin 用 Cmd+Q，Windows / Linux 用 Ctrl+Q", () => {
  assert.equal(mainWindowShortcut(key({ key: "q", meta: true }), "darwin"), "quit");
  assert.equal(mainWindowShortcut(key({ key: "q", control: true }), "darwin"), null);
  assert.equal(mainWindowShortcut(key({ key: "q", control: true }), "win32"), "quit");
  assert.equal(mainWindowShortcut(key({ key: "q", control: true }), "linux"), "quit");
  assert.equal(mainWindowShortcut(key({ key: "q", meta: true }), "win32"), null);
});

test("退出键不被别的修饰键与按键形态串台", () => {
  assert.equal(mainWindowShortcut(key({ key: "q" }), "win32"), null, "没有修饰键不算");
  assert.equal(mainWindowShortcut(key({ key: "q", control: true, shift: true }), "win32"), null);
  assert.equal(mainWindowShortcut(key({ key: "q", control: true, alt: true }), "win32"), null);
  assert.equal(mainWindowShortcut(key({ key: "w", control: true }), "win32"), null);
  assert.equal(mainWindowShortcut(key({ key: "q", control: true, type: "keyUp" }), "win32"), null);
});

test("托盘文案跟界面语言走", () => {
  assert.equal(trayLabels("zh").show, "显示主窗口");
  assert.equal(trayLabels("en").show, "Show window");
  assert.notEqual(trayLabels("zh").quit, trayLabels("en").quit);
});
