import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { errorCode, isNotFound } from "./fs-errors.ts";

describe("isNotFound", () => {
  test("ENOENT 是「查无此物」——目录还没建，返回空是对的", () => {
    assert.equal(isNotFound(Object.assign(new Error("no such file"), { code: "ENOENT" })), true);
  });

  // 这条是这一刀的由来：权限坏了曾经被当成「一条都没有」
  test("EACCES 不是「没有」，是「读不出来」", () => {
    assert.equal(isNotFound(Object.assign(new Error("permission denied"), { code: "EACCES" })), false);
  });

  test("ENOTDIR 也不是「没有」——该是目录的地方成了文件，说明盘上的东西不对劲", () => {
    assert.equal(isNotFound(Object.assign(new Error("not a directory"), { code: "ENOTDIR" })), false);
  });

  test("不带 code 的普通错误不算「没有」", () => {
    assert.equal(isNotFound(new Error("boom")), false);
  });

  test("null / 字符串这类非对象不会把判定弄崩", () => {
    assert.equal(isNotFound(null), false);
    assert.equal(isNotFound("ENOENT"), false);
    assert.equal(errorCode(undefined), null);
  });

  test("code 不是字符串就当没有 code", () => {
    assert.equal(errorCode(Object.assign(new Error("x"), { code: 2 })), null);
  });
});
