import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectivePaper } from "./doc-paper.ts";

describe("effectivePaper", () => {
  it("沿用设置里的纸面，缺席 = quiet；不再受应用主题锁定", () => {
    assert.equal(effectivePaper("print"), "print");
    assert.equal(effectivePaper("focus"), "focus");
    assert.equal(effectivePaper("quiet"), "quiet");
    assert.equal(effectivePaper(undefined), "quiet");
  });
});
