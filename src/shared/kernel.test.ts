import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kernelLibraryName, parseSessionDurable } from "./kernel.ts";
import { parseSessionMeta } from "./session.ts";

const BASE = {
  id: "s-1",
  cwd: "/tmp",
  providerId: "p",
  modelId: "m",
  createdAt: 1,
};

describe("parseSessionDurable", () => {
  it("认 ready 与 failed 两种", () => {
    const ready = { status: "ready", library: "s-1.sqlite", conversationId: 3, migratedAt: 9, legacy: { bytes: 10, mtimeMs: 5 } };
    assert.deepEqual(parseSessionDurable(ready), ready);
    assert.deepEqual(parseSessionDurable({ ...ready, legacy: null }), { ...ready, legacy: null });
    assert.deepEqual(parseSessionDurable({ status: "failed", reason: "坏了", at: 2 }), { status: "failed", reason: "坏了", at: 2 });
  });

  it("坏值当缺席：库名带路径、缺会话号、未知状态", () => {
    assert.equal(parseSessionDurable({ status: "ready", library: "../x.sqlite", conversationId: 1, migratedAt: 1 }), null);
    assert.equal(parseSessionDurable({ status: "ready", library: "a.sqlite", migratedAt: 1 }), null);
    assert.equal(parseSessionDurable({ status: "maybe" }), null);
    assert.equal(parseSessionDurable(null), null);
    assert.equal(parseSessionDurable({ status: "failed", at: 1 }), null);
  });

  it("库名由根会话 id 拼出", () => {
    assert.equal(kernelLibraryName("abc-1"), "abc-1.sqlite");
  });
});

describe("parseSessionMeta 的 durable 字段", () => {
  it("缺席时读回的 meta 不带 durable 键（与加字段之前逐键相同）", () => {
    const meta = parseSessionMeta(BASE);
    assert.ok(meta !== null);
    assert.equal("durable" in meta, false);
  });

  it("坏值不带键、不丢整条会话", () => {
    const meta = parseSessionMeta({ ...BASE, durable: { status: "ready" } });
    assert.ok(meta !== null);
    assert.equal("durable" in meta, false);
  });

  it("好值原样读回", () => {
    const durable = { status: "ready", library: "s-1.sqlite", conversationId: 2, migratedAt: 3, legacy: null };
    assert.deepEqual(parseSessionMeta({ ...BASE, durable })?.durable, durable);
  });
});
