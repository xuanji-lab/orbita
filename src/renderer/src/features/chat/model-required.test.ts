import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { modelRequiredText } from "./model-required.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

describe("modelRequiredText —— 没选模型时的发送报错", () => {
  test("一个可用服务商都没有：保留「先添加服务商」的原文案", () => {
    assert.equal(modelRequiredText(false, en), en.session.noProvider);
    assert.equal(modelRequiredText(false, zh), zh.session.noProvider);
  });

  test("有服务商但没选模型：改说「先选一个模型」——导入的会话（占位 provider）正是这个状态", () => {
    assert.equal(modelRequiredText(true, en), en.session.pickModelFirst);
    assert.equal(modelRequiredText(true, zh), zh.session.pickModelFirst);
    // 两种文案必须是不同的话，否则选择逻辑白写
    assert.notEqual(modelRequiredText(true, en), modelRequiredText(false, en));
  });
});
