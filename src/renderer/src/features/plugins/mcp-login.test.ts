import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { statusNeedsLogin } from "./mcp-login.ts";

describe("statusNeedsLogin", () => {
  test("失败且标了需要登录才算；普通失败、就绪、停用、没读到都不算", () => {
    assert.equal(statusNeedsLogin({ kind: "failed", message: "x", needsLogin: true }), true);
    assert.equal(statusNeedsLogin({ kind: "failed", message: "x" }), false);
    assert.equal(statusNeedsLogin({ kind: "ready", tools: [] }), false);
    assert.equal(statusNeedsLogin({ kind: "disabled" }), false);
    assert.equal(statusNeedsLogin({ kind: "idle" }), false);
    assert.equal(statusNeedsLogin(null), false);
  });

  test("合并状态没标、但某个工作区实例标了：也给登录入口（登录是对这台 server 的）", () => {
    assert.equal(
      statusNeedsLogin({ kind: "ready", tools: ["a"] }, [{ status: { kind: "ready", tools: ["a"] } }, { status: { kind: "failed", message: "x", needsLogin: true } }]),
      true,
    );
    assert.equal(statusNeedsLogin({ kind: "idle" }, [{ status: { kind: "failed", message: "x" } }]), false);
  });
});
