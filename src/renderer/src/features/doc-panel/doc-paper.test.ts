import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectivePaper } from "./doc-paper.ts";

describe("effectivePaper", () => {
  it("浅色 / 黛 / 玄：用设置里的纸面，缺席 = quiet", () => {
    for (const theme of ["light", "graphite", "black"] as const) {
      assert.deepEqual(effectivePaper("focus", theme), { paper: "focus", locked: false });
      assert.deepEqual(effectivePaper(undefined, theme), { paper: "quiet", locked: false });
    }
  });

  it("纸面主题下回落 quiet 并锁住切换", () => {
    assert.deepEqual(effectivePaper("print", "copybook"), { paper: "quiet", locked: true });
    assert.deepEqual(effectivePaper("focus", "typescript"), { paper: "quiet", locked: true });
  });
});
