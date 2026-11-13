import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Carryover } from "@shared/session";
import type { WrapupEntry } from "@shared/wrapup";
import { prefillLeft, reconcileLeft } from "./carryover-prefill.ts";

const noticed = (id: string, title: string, detail = ""): Carryover => ({
  id,
  title,
  detail,
  sourceSessionId: "s1",
  sourceMessageRange: null,
  origin: "noticed",
  anchor: "c1",
  status: "open",
  createdAt: 0,
  doneAt: null,
});
const entry = (title: string): WrapupEntry => ({ title, detail: "模型摘录", turns: [1, 2] });

describe("prefillLeft：收尾只确认，不再让模型回看收割", () => {
  test("有以后再做 / 有计划：用「开着的以后再做 + 计划没做完的步」完全替换扫描模型给的", () => {
    const left = prefillLeft({
      modelLeft: [entry("模型回看出来的一件事")],
      unfinishedSteps: ["README 写用法"],
      noticed: [noticed("n1", "日期解析不一致", "非 ISO 写法")],
    });
    assert.deepEqual(left, [
      { title: "日期解析不一致", detail: "非 ISO 写法", turns: null },
      { title: "README 写用法", detail: "", turns: null },
    ]);
  });

  test("写过计划且全做完、也没有以后再做：留下的事为空——不去采信模型回看出来的", () => {
    assert.deepEqual(prefillLeft({ modelLeft: [entry("模型的")], unfinishedSteps: [], noticed: [] }), []);
  });

  test("没有计划也没有以后再做（老会话）：沿用扫描模型给的", () => {
    const modelLeft = [entry("模型的")];
    assert.deepEqual(prefillLeft({ modelLeft, unfinishedSteps: null, noticed: [] }), modelLeft);
  });

  test("按文字去重（去空白）：计划里没做完的步与同名的以后再做只留一条", () => {
    const left = prefillLeft({ modelLeft: [], unfinishedSteps: ["日期 解析不一致"], noticed: [noticed("n1", "日期解析不一致")] });
    assert.equal(left.length, 1);
  });
});

describe("reconcileLeft：确认时怎么落", () => {
  const locate = () => null;
  test("卡上留着的开着的以后再做不再新记；卡上删掉的标丢掉；新的（计划没做完的步 / 自己加的）新记", () => {
    const result = reconcileLeft({
      left: [
        { title: "日期解析不一致", detail: "" },
        { title: "README 写用法", detail: "" },
      ],
      noticed: [noticed("n1", "日期解析不一致"), noticed("n2", "加 CI")],
      locate,
    });
    assert.deepEqual(result.drafts.map((d) => d.title), ["README 写用法"]);
    assert.deepEqual(result.dismissIds, ["n2"]);
  });

  test("空标题忽略；全留着 = 什么都不新记、什么都不丢", () => {
    const result = reconcileLeft({ left: [{ title: "  ", detail: "" }, { title: "加 CI", detail: "" }], noticed: [noticed("n2", "加 CI")], locate });
    assert.deepEqual(result, { drafts: [], dismissIds: [] });
  });
});
