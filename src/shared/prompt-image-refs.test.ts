import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { composePromptText } from "./prompt-attachments.ts";
import {
  imageOrderNote,
  imageRefToken,
  insertImageRefs,
  parseImageRefs,
  removeImageRef,
} from "./prompt-image-refs.ts";

describe("parseImageRefs", () => {
  it("扫出位置与序号，count 之外的不认", () => {
    const text = "看 [图 1] 和 [图 3]，还有[图 12]";
    deepStrictEqual(
      parseImageRefs(text).map((s) => s.n),
      [1, 3, 12],
    );
    deepStrictEqual(
      parseImageRefs(text, 2).map((s) => s.n),
      [1],
    );
    const first = parseImageRefs(text)[0];
    strictEqual(text.slice(first?.start, first?.end), "[图 1]");
  });
  it("不认 [图 0] 与不带数字的写法", () => {
    deepStrictEqual(parseImageRefs("[图 0] [图] 图 1"), []);
  });
});

describe("insertImageRefs", () => {
  it("句中插入：两边是字就补空格，光标落在末尾空格之后", () => {
    const r = insertImageRefs("左边右边", 2, [1]);
    strictEqual(r.text, "左边 [图 1] 右边");
    strictEqual(r.caret, "左边 [图 1] ".length);
  });
  it("多张用空格隔开；空文本只补尾部空格", () => {
    strictEqual(insertImageRefs("", 0, [1, 2]).text, "[图 1] [图 2] ");
  });
  it("两边已有空白 / 换行不重复补", () => {
    strictEqual(insertImageRefs("a \nb", 2, [3]).text, "a [图 3]\nb");
  });
  it("光标越界按两端夹", () => {
    strictEqual(insertImageRefs("ab", 99, [1]).text, "ab [图 1] ");
    strictEqual(insertImageRefs("ab", -5, [1]).text, "[图 1] ab");
  });
  it("没有图原样返回", () => {
    deepStrictEqual(insertImageRefs("ab", 1, []), { text: "ab", caret: 1 });
  });
});

describe("removeImageRef", () => {
  it("删掉第 2 张：它的小签连一个空格一起走，后面的编号各减一", () => {
    strictEqual(removeImageRef("看 [图 1] 和 [图 2] 与 [图 3] 吧", 2), "看 [图 1] 和 与 [图 2] 吧");
  });
  it("后面没空格就带走前面的", () => {
    strictEqual(removeImageRef("比较 [图 1]", 1), "比较");
  });
  it("没有对应小签（已被手删）只重排", () => {
    strictEqual(removeImageRef("[图 1] 与 [图 3]", 2), "[图 1] 与 [图 2]");
  });
  it("重复写了两次都删", () => {
    strictEqual(removeImageRef("[图 1] a [图 1]", 1), "a");
  });
  it("10 减到 9 长度变化也对", () => {
    strictEqual(removeImageRef("x [图 10]", 3), "x [图 9]");
  });
});

describe("发给模型的文本", () => {
  it("imageOrderNote：按序点名；0 张为空", () => {
    strictEqual(imageOrderNote(0), "");
    strictEqual(imageOrderNote(3), "（附图按顺序：图 1、图 2、图 3。正文里的 [图 N] 指第 N 张。）");
    strictEqual(imageRefToken(2), "[图 2]");
  });
  it("composePromptText：说明紧跟正文，粘贴块在后；无图与以前一字不差", () => {
    strictEqual(composePromptText("图 1 和 [图 2]", [], [], 0), "图 1 和 [图 2]");
    strictEqual(
      composePromptText("[图 1] 是啥", ["长文"], [], 1),
      "[图 1] 是啥\n\n（附图按顺序：图 1。正文里的 [图 N] 指第 N 张。）\n\n<pasted-text>\n长文\n</pasted-text>",
    );
    strictEqual(composePromptText("", [], [], 1), "（附图按顺序：图 1。正文里的 [图 N] 指第 N 张。）");
  });
});
