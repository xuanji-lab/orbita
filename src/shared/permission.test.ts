import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_TIMEOUT_DEFAULT_SECONDS, COMMAND_TIMEOUT_FLOOR_SECONDS, gatedCommandTimeout } from "./permission.ts";

describe("gatedCommandTimeout（闸门改入参与界面「上限」显示同一条规则）", () => {
  test("不填 → 默认上限；小于下限 → 抬到下限；比下限大 → 原样", () => {
    assert.equal(gatedCommandTimeout(undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
    assert.equal(gatedCommandTimeout(60), COMMAND_TIMEOUT_FLOOR_SECONDS);
    assert.equal(gatedCommandTimeout(COMMAND_TIMEOUT_FLOOR_SECONDS), COMMAND_TIMEOUT_FLOOR_SECONDS);
    assert.equal(gatedCommandTimeout(900), 900);
  });

  test("非法值原样留给工具报错，不在这里修", () => {
    assert.equal(gatedCommandTimeout(0), 0);
    assert.equal(gatedCommandTimeout(-5), -5);
    assert.equal(gatedCommandTimeout("60"), "60");
    assert.equal(gatedCommandTimeout(null), null);
    assert.ok(Number.isNaN(gatedCommandTimeout(Number.NaN)));
  });
});
