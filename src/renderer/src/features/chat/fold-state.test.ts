import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearFoldState, foldStateSize, readFoldState, writeFoldState } from "./fold-state.ts";

describe("fold-state（折叠展开态记忆）", () => {
  beforeEach(() => clearFoldState());

  test("没有记录返回 undefined（调用方用默认值）", () => {
    assert.equal(readFoldState("missing"), undefined);
  });

  test("写入后读回，true / false 都记", () => {
    writeFoldState("a", true);
    writeFoldState("b", false);
    assert.equal(readFoldState("a"), true);
    assert.equal(readFoldState("b"), false);
  });

  test("key 是稳定的 entry key，不同 key 互不影响", () => {
    writeFoldState("turn:a:0", true);
    writeFoldState("proc:b:0", false);
    assert.equal(readFoldState("turn:a:0"), true);
    assert.equal(readFoldState("proc:b:0"), false);
  });

  test("命中刷新 LRU：最久未用的先被淘汰", () => {
    // 上限 1000：先写满，再读一次最早写入的那条，然后写新 key
    for (let i = 0; i < 1000; i += 1) writeFoldState(`k${i}`, true);
    assert.equal(readFoldState("k0"), true);
    writeFoldState("new", true);
    assert.equal(readFoldState("k1"), undefined);
    assert.equal(readFoldState("k0"), true);
    assert.equal(foldStateSize(), 1000);
  });

  test("重复写不增加条数", () => {
    writeFoldState("a", true);
    writeFoldState("a", false);
    assert.equal(foldStateSize(), 1);
    assert.equal(readFoldState("a"), false);
  });
});
