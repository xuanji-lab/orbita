/**
 * 记忆库 IPC 入参校验（requests.ts）——renderer 来的都是不可信数据，形状不对当场抛。
 * 纯模块直测（node --test）。
 *
 * （此前这个文件误为 library.test.ts 的逐字副本，requests.ts 本身没有测试。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseEntriesRequest, parseMutation, parseScopeToken, parseSessionId } from "./requests.ts";

const TOKEN = "a".repeat(40);

test("parseScopeToken：只认 user 或 40 位 hex", () => {
  assert.equal(parseScopeToken("user"), "user");
  assert.equal(parseScopeToken(TOKEN), TOKEN);
  assert.throws(() => parseScopeToken("../etc"));
  assert.throws(() => parseScopeToken(42));
});

test("parseEntriesRequest / parseSessionId：all 与类型筛选；空 sessionId 拒", () => {
  assert.deepEqual(parseEntriesRequest({ token: "all" }), { token: "all" });
  assert.deepEqual(parseEntriesRequest({ token: TOKEN, type: "fact" }), { token: TOKEN, type: "fact" });
  assert.throws(() => parseEntriesRequest({ token: "all", type: "mood" }));
  assert.throws(() => parseSessionId(""));
});

test("parseMutation：两个撤销 op 只收 token + entryId", () => {
  assert.deepEqual(parseMutation({ op: "restorePrevious", token: TOKEN, entryId: "mem_1", extra: 1 }), {
    op: "restorePrevious",
    token: TOKEN,
    entryId: "mem_1",
  });
  assert.deepEqual(parseMutation({ op: "returnToWorkspace", token: "user", entryId: "mem_1" }), {
    op: "returnToWorkspace",
    token: "user",
    entryId: "mem_1",
  });
  assert.throws(() => parseMutation({ op: "restorePrevious", token: TOKEN }));
});

test("parseMutation：拍板类 op 已删除，一律拒收；setStatus 不收 stale", () => {
  for (const op of ["decidePromote", "undoPromote", "decideConflict", "undoConflict"]) {
    assert.throws(() => parseMutation({ op, token: TOKEN, entryId: "mem_1", decision: "user" }), /unknown memory mutation op/);
  }
  assert.throws(() => parseMutation({ op: "setStatus", token: TOKEN, entryId: "mem_1", status: "stale" }));
  assert.equal(parseMutation({ op: "setStatus", token: TOKEN, entryId: "mem_1", status: "muted" }).op, "setStatus");
});

test("parseMutation：edit 正文 trim 后非空、addManual 理由可选", () => {
  assert.throws(() => parseMutation({ op: "edit", token: TOKEN, entryId: "mem_1", text: "  " }));
  assert.deepEqual(parseMutation({ op: "addManual", token: "user", type: "fact", text: " 事实 " }), {
    op: "addManual",
    token: "user",
    type: "fact",
    text: "事实",
  });
});
