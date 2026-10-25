/**
 * 工作区写操作的广播外壳：成功才广播、失败不广播、顺序在落盘之后。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { afterWorkspaceMutation } from "./change.ts";

test("成功：先跑完写操作再广播，返回写操作的结果", async () => {
  const order: string[] = [];
  const created = await afterWorkspaceMutation(async () => {
    order.push("write");
    return { id: "w1" };
  }, () => order.push("broadcast"));
  assert.deepEqual(order, ["write", "broadcast"]);
  assert.deepEqual(created, { id: "w1" });
});

test("失败：不广播（列表没变），错误照旧抛给 IPC 调用方", async () => {
  let broadcasts = 0;
  await assert.rejects(
    () =>
      afterWorkspaceMutation(async () => {
        throw new Error("重名");
      }, () => {
        broadcasts += 1;
      }),
    /重名/,
  );
  assert.equal(broadcasts, 0);
});
