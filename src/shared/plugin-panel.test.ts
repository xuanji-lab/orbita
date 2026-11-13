import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PANEL_ACTION_MAX_CHARS,
  PANEL_PAYLOAD_MAX_BYTES,
  checkPanelAction,
  dataMessageParts,
  parsePanelMessage,
} from "./plugin-panel.ts";

describe("checkPanelAction", () => {
  it("正常动作：载荷 JSON 往返后原样落地", () => {
    const result = checkPanelAction("feedback", { pid: "P0181", verdict: "useful" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "feedback");
      assert.deepEqual(result.payload, { pid: "P0181", verdict: "useful" });
      assert.equal(result.json, '{"pid":"P0181","verdict":"useful"}');
    }
  });

  it("载荷缺省当 null", () => {
    const result = checkPanelAction("refresh", undefined);
    assert.deepEqual(result.ok && result.payload, null);
    assert.equal(result.ok && result.json, "null");
  });

  it("动作名：空 / 全空白 / 非字符串 / 含控制字符一律 invalid", () => {
    for (const bad of ["", "   ", 7, null, undefined, {}, "a\nb", "a\u0000b", "tab\tname"]) {
      assert.deepEqual(checkPanelAction(bad, null), { ok: false, reason: "invalid" }, String(bad));
    }
  });

  it("动作名 64 字符恰好可以，65 字符拒", () => {
    assert.equal(checkPanelAction("a".repeat(PANEL_ACTION_MAX_CHARS), null).ok, true);
    assert.deepEqual(checkPanelAction("a".repeat(PANEL_ACTION_MAX_CHARS + 1), null), { ok: false, reason: "action-too-long" });
  });

  it("载荷按 UTF-8 字节数算：16 KB 的汉字（每字 3 字节）会超", () => {
    // JSON 引号占 2 字节；ASCII 刚好顶满的那一条能过，多 1 字节就拒
    const fits = "x".repeat(PANEL_PAYLOAD_MAX_BYTES - 2);
    assert.equal(checkPanelAction("a", fits).ok, true);
    assert.deepEqual(checkPanelAction("a", fits + "x"), { ok: false, reason: "payload-too-large" });
    const cjk = "汉".repeat(Math.ceil(PANEL_PAYLOAD_MAX_BYTES / 3));
    assert.deepEqual(checkPanelAction("a", cjk), { ok: false, reason: "payload-too-large" });
  });

  it("不能序列化的载荷（循环引用 / BigInt / 函数）一律 invalid，不抛", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    assert.deepEqual(checkPanelAction("a", cycle), { ok: false, reason: "invalid" });
    assert.deepEqual(checkPanelAction("a", 10n), { ok: false, reason: "invalid" });
    assert.deepEqual(checkPanelAction("a", () => 1), { ok: false, reason: "invalid" });
  });

  it("载荷里的 __proto__ 只是一个自有键，不污染原型", () => {
    const result = checkPanelAction("a", JSON.parse('{"__proto__":{"polluted":1}}'));
    assert.equal(result.ok, true);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("parsePanelMessage", () => {
  it("认 orbita:ready，emptyState 只在严格为 true 时算数", () => {
    assert.deepEqual(parsePanelMessage({ type: "orbita:ready" }), { kind: "ready", emptyState: false });
    assert.deepEqual(parsePanelMessage({ type: "orbita:ready", emptyState: true }), { kind: "ready", emptyState: true });
    assert.deepEqual(parsePanelMessage({ type: "orbita:ready", emptyState: "yes" }), { kind: "ready", emptyState: false });
  });

  it("认 orbita:action，原样带出动作与载荷（校验交给 checkPanelAction）", () => {
    assert.deepEqual(parsePanelMessage({ type: "orbita:action", action: "x", payload: [1] }), { kind: "action", action: "x", payload: [1] });
  });

  it("别的一律忽略：非对象、数组、未知 type、宿主自己的消息类型（模板不能冒充宿主）", () => {
    for (const raw of [null, undefined, 3, "orbita:ready", [], { type: "orbita:data" }, { type: 1 }, {}]) {
      assert.deepEqual(parsePanelMessage(raw), { kind: "ignored" });
    }
  });
});

describe("dataMessageParts", () => {
  it("有值带 mtime；空与问题都当 empty（问题由宿主自己说，不发给模板）", () => {
    assert.deepEqual(dataMessageParts({ kind: "ready", value: { a: 1 }, updatedAt: 5 }), { data: { a: 1 }, state: "ready", updatedAt: 5 });
    assert.deepEqual(dataMessageParts({ kind: "empty" }), { data: null, state: "empty", updatedAt: null });
    assert.deepEqual(dataMessageParts({ kind: "problem", problem: { kind: "too-large", bytes: 9 } }), { data: null, state: "empty", updatedAt: null });
  });
});
