/**
 * chktex 触发节奏的账：保存后只跑一次、连续保存只跑最后一次、出错不外溢、卸载后不再跑。
 *
 * 用真计时器（几毫秒的去抖）而不是假时钟：这里是 node --test，没有 sinon；
 * 5ms 的量级既稳定又快。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createLintScheduler } from "./latex-lint-trigger.ts";

const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("createLintScheduler", () => {
  test("一次保存 → 一次检查", async () => {
    let runs = 0;
    const scheduler = createLintScheduler(() => {
      runs += 1;
    }, 5);
    scheduler.request();
    await tick(25);
    assert.equal(runs, 1);
    scheduler.dispose();
  });

  test("连续保存只跑最后一次（去抖窗口内重置计时）", async () => {
    let runs = 0;
    const scheduler = createLintScheduler(() => {
      runs += 1;
    }, 20);
    scheduler.request();
    await tick(5);
    scheduler.request();
    await tick(5);
    scheduler.request();
    await tick(60);
    assert.equal(runs, 1);
    scheduler.dispose();
  });

  test("两次保存隔得够远 → 各跑一次", async () => {
    let runs = 0;
    const scheduler = createLintScheduler(() => {
      runs += 1;
    }, 5);
    scheduler.request();
    await tick(25);
    scheduler.request();
    await tick(25);
    assert.equal(runs, 2);
    scheduler.dispose();
  });

  test("检查抛错 / reject 不外溢（未安装 chktex 一类的失败只是这一轮没结果）", async () => {
    let runs = 0;
    const scheduler = createLintScheduler(() => {
      runs += 1;
      if (runs === 1) throw new Error("no chktex");
      return Promise.reject(new Error("channel down"));
    }, 5);
    scheduler.request();
    await tick(25);
    scheduler.request();
    await tick(25);
    assert.equal(runs, 2);
    scheduler.dispose();
  });

  test("cancel / dispose 之后不再跑", async () => {
    let runs = 0;
    const scheduler = createLintScheduler(() => {
      runs += 1;
    }, 10);
    scheduler.request();
    scheduler.cancel();
    await tick(30);
    scheduler.request();
    scheduler.dispose();
    await tick(30);
    assert.equal(runs, 0);
  });
});
