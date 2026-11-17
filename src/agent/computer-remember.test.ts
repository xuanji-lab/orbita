/**
 * 「这一次记住了哪一类」的审计注记：一次性、按会话。
 *
 * 真机上判断它有没有生效，看会话 JSONL 里那一条 tool result 的
 * `details.computerUse.rememberedClass`——所以这里钉住的是「取一次就消失、别的会话拿不到」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { noteRememberedClass, takeRememberedClass } from "./computer-remember.ts";

describe("computer-remember —— rememberedClass 的一次性注记", () => {
  test("写下之后取到一次，再取就是 null（只进被批准的那一条结果）", () => {
    noteRememberedClass("s1", "confined");
    assert.equal(takeRememberedClass("s1"), "confined");
    assert.equal(takeRememberedClass("s1"), null);
  });

  test("按会话分开：A 的注记不会被 B 的调用取走", () => {
    noteRememberedClass("s2", "confined");
    assert.equal(takeRememberedClass("s3"), null);
    assert.equal(takeRememberedClass("s2"), "confined");
  });

  test("没写过就是 null——不编造（读件 / 逸出件 / 没记住的调用都不该带这个字段）", () => {
    assert.equal(takeRememberedClass("never"), null);
  });
});
