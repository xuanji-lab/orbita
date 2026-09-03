import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { LOADING, READY, describeList, failed } from "./load-state.ts";

describe("describeList", () => {
  it("还在读、手里没有：是加载态，不是空态", () => {
    deepStrictEqual(describeList(LOADING, 0), { error: null, body: "loading" });
  });

  it("读完了、真的一个都没有：才是空态", () => {
    deepStrictEqual(describeList(READY, 0), { error: null, body: "empty" });
  });

  it("读完了有东西：列出来", () => {
    deepStrictEqual(describeList(READY, 3), { error: null, body: "list" });
  });

  // 这一条是这刀的由来：磁盘权限坏了以前显示成「你的会话全没了」
  it("从没读成功过就失败：只有错误，绝不说「一个都没有」", () => {
    deepStrictEqual(describeList(failed(new Error("EACCES: permission denied")), 0), {
      error: "EACCES: permission denied",
      body: "none",
    });
  });

  it("刷新失败但上一份还在：错误行贴在列表上面，列表不清空", () => {
    deepStrictEqual(describeList(failed(new Error("boom")), 2), { error: "boom", body: "list" });
  });

  it("静默刷新（手里有数据时再读）不闪加载态", () => {
    deepStrictEqual(describeList(LOADING, 2), { error: null, body: "list" });
  });

  it("catch 到的不是 Error 也能压成一句话", () => {
    deepStrictEqual(failed("disk gone"), { kind: "failed", message: "disk gone" });
  });
});
