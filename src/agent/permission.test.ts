import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PermissionDeniedError, wrapWithPermission, type WrappableTool } from "./permission.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";

function fakeTool(name: string) {
  const calls: unknown[] = [];
  const tool: WrappableTool & { calls: unknown[] } = {
    name,
    calls,
    execute: async (_id, params) => {
      calls.push(params);
      return { ok: true };
    },
  };
  return tool;
}

function wrap(name: string, mode: PermissionMode, answer?: PermissionAnswer) {
  const tool = fakeTool(name);
  const asked: unknown[] = [];
  const wrapped = wrapWithPermission(
    tool,
    () => mode,
    async (request) => {
      asked.push(request);
      return answer ?? { behavior: "allow" };
    },
  );
  return { tool, wrapped, asked };
}

describe("wrapWithPermission", () => {
  test("plan 下 bash 直接抛错，原装 execute 一次都不会被调到", async () => {
    const { tool, wrapped, asked } = wrap("bash", "plan");
    await assert.rejects(
      () => wrapped.execute("c1", { cmd: "rm -rf /" }),
      (error: unknown) => error instanceof PermissionDeniedError,
    );
    assert.deepEqual(tool.calls, [], "被拒的工具绝不能被执行");
    assert.deepEqual(asked, [], "plan 下不该去打扰用户");
  });

  test("skip 下不询问，直接执行", async () => {
    const { tool, wrapped, asked } = wrap("bash", "skip");
    await wrapped.execute("c1", { cmd: "ls" });
    assert.deepEqual(tool.calls, [{ cmd: "ls" }]);
    assert.deepEqual(asked, []);
  });

  test("manual 下先问再执行，问的内容带工具名与入参", async () => {
    const { tool, wrapped, asked } = wrap("write", "manual", { behavior: "allow" });
    await wrapped.execute("c7", { path: "a.ts" });
    assert.deepEqual(asked, [{ toolCallId: "c7", toolName: "write", input: { path: "a.ts" } }]);
    assert.deepEqual(tool.calls, [{ path: "a.ts" }]);
  });

  test("用户拒绝 → 抛错且不执行；理由回灌给模型", async () => {
    const { tool, wrapped } = wrap("bash", "manual", { behavior: "deny", message: "别删那个" });
    await assert.rejects(
      () => wrapped.execute("c1", { cmd: "rm -rf /" }),
      (error: unknown) => error instanceof PermissionDeniedError && /别删那个/.test(error.message),
    );
    assert.deepEqual(tool.calls, []);
  });

  test("用户改写入参后放行 → 执行的是改写后的值", async () => {
    const { tool, wrapped } = wrap("bash", "manual", {
      behavior: "allow",
      input: { cmd: "rm -rf ./build" },
    });
    await wrapped.execute("c1", { cmd: "rm -rf /" });
    assert.deepEqual(tool.calls, [{ cmd: "rm -rf ./build" }], "必须用改写后的入参");
  });

  test("模式是每次取的，不是包装时固定的——中途切档立即生效", async () => {
    const tool = fakeTool("bash");
    let mode: PermissionMode = "skip";
    const wrapped = wrapWithPermission(tool, () => mode, async () => ({ behavior: "allow" }));
    await wrapped.execute("c1", { cmd: "ls" });
    mode = "plan";
    await assert.rejects(() => wrapped.execute("c2", { cmd: "ls" }));
    assert.equal(tool.calls.length, 1);
  });

  test("除 execute 外的字段原样透传（pi 还要用 description / parameters）", () => {
    const tool = { name: "read", description: "d", parameters: { x: 1 }, execute: async () => ({}) };
    const wrapped = wrapWithPermission(tool, () => "skip", async () => ({ behavior: "allow" }));
    assert.equal(wrapped.description, "d");
    assert.deepEqual(wrapped.parameters, { x: 1 });
    assert.equal(wrapped.name, "read");
  });
});
