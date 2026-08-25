import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isSubmitKey, type SubmitKeyEvent } from "./composer-keys.ts";

const event = (patch: Partial<SubmitKeyEvent>): SubmitKeyEvent => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...patch,
});

describe("isSubmitKey", () => {
  it("裸 Enter 是发送", () => {
    deepStrictEqual(isSubmitKey(event({})), true);
  });

  it("Shift+Enter 是换行，不是发送", () => {
    deepStrictEqual(isSubmitKey(event({ shiftKey: true })), false);
  });

  it("别的键都不是发送", () => {
    deepStrictEqual(isSubmitKey(event({ key: "a" })), false);
    deepStrictEqual(isSubmitKey(event({ key: "Escape" })), false);
  });

  // 这两条是真实事故：中文输入法里 Enter 是确认候选词，不判组词就会把没上屏的词发出去
  it("输入法组词中的 Enter 不是发送（isComposing）", () => {
    deepStrictEqual(isSubmitKey(event({ isComposing: true })), false);
  });

  it("输入法组词中的 Enter 不是发送（只置 keyCode 229 的那些输入法）", () => {
    deepStrictEqual(isSubmitKey(event({ keyCode: 229 })), false);
  });
});
