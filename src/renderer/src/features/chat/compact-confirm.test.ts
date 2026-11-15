import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactConfirmLabels } from "./compact-confirm.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

describe("compactConfirmLabels", () => {
  for (const [name, t] of [
    ["zh", zh.chat],
    ["en", en.chat],
  ] as const) {
    it(`${name}：值得压时是普通确认，动作键不说「仍要」`, () => {
      const { hint, action } = compactConfirmLabels(true, t);
      assert.equal(hint, t.compactConfirm);
      assert.equal(action, t.compactGo);
      assert.notEqual(action, t.compactAnyway);
    });

    it(`${name}：对话还短时提醒省不了多少，动作键是「仍要压缩」`, () => {
      const { hint, action } = compactConfirmLabels(false, t);
      assert.equal(hint, t.compactShort);
      assert.equal(action, t.compactAnyway);
    });
  }
});
