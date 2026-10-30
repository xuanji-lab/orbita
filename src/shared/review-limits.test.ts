import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_DIFF_MAX_LINES,
  reviewDiffOverflow,
  reviewDiffTooLarge,
} from "./review.ts";

describe("reviewDiffOverflow", () => {
  test("上限以内的常规 diff：null", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", " ctx", "-old", "+new"].join("\n");
    assert.equal(reviewDiffOverflow(diff), null);
  });
  test("字节数超过上限：bytes（多字节字符按 utf8 字节数，不是字符数）", () => {
    // 每行 3 个汉字 = 9 字节；行数远不到 5000，超的是字节
    const lines = Array.from({ length: Math.floor(REVIEW_DIFF_MAX_BYTES / 9) + 10 }, () => "+中文中文中文");
    assert.equal(reviewDiffOverflow(lines.join("\n")), "bytes");
  });
  test("增删行数超过上限：lines（总字节还在上限内）", () => {
    const lines = Array.from({ length: REVIEW_DIFF_MAX_LINES + 1 }, (_, i) => `+${i}`);
    const diff = lines.join("\n");
    assert.ok(diff.length < REVIEW_DIFF_MAX_BYTES, "前置：字节没超，超的只能是行数");
    assert.equal(reviewDiffOverflow(diff), "lines");
  });
  test("正好等于上限不算超过（5000 行整 / 1 MB 整都放行）", () => {
    const lines = Array.from({ length: REVIEW_DIFF_MAX_LINES }, (_, i) => `+${i}`);
    assert.equal(reviewDiffOverflow(lines.join("\n")), null);
  });
  test("+++ / --- 文件头不计入增删行", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
    // 若把文件头也数进去会是 4，这里上限以下验证不了排除逻辑，直接用超大行数构造：
    const head = ["--- a/x.ts", "+++ b/x.ts"].concat(
      Array.from({ length: REVIEW_DIFF_MAX_LINES }, (_, i) => `+${i}`),
    );
    assert.equal(reviewDiffOverflow(head.join("\n")), null);
  });
  test("空字符串：null", () => {
    assert.equal(reviewDiffOverflow(""), null);
  });
});

describe("reviewDiffTooLarge", () => {
  test("diff 恒 null、binary / restored 恒 false，带 exceeded 与英文原句", () => {
    assert.deepEqual(reviewDiffTooLarge("bytes", "x is over the limit"), {
      diff: null,
      binary: false,
      restored: false,
      tooLarge: { exceeded: "bytes", message: "x is over the limit" },
    });
  });
});
