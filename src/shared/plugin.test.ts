import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBlockingMcpProblem,
  isPluginName,
  parsePluginViewId,
  pluginViewId,
  scopeApplies,
} from "./plugin.ts";

describe("isPluginName", () => {
  it("认小写字母数字开头、含 . _ - 的名字，上限 64 位", () => {
    for (const ok of ["pdf", "skill-creator", "a.b_c-d", "0abc", "x".repeat(64)]) {
      assert.equal(isPluginName(ok), true, ok);
    }
  });
  it("拒大写、空、前导符号、空格、路径分隔符与超长", () => {
    for (const bad of ["", "PDF", ".hidden", "-x", "a b", "a/b", "a\\b", "a@b", "a:b", "x".repeat(65)]) {
      assert.equal(isPluginName(bad), false, bad);
    }
  });
});

describe("scopeApplies", () => {
  it("global 覆盖所有会话，含没有工作区的", () => {
    assert.equal(scopeApplies({ kind: "global" }, null), true);
    assert.equal(scopeApplies({ kind: "global" }, "w1"), true);
  });
  it("workspaces 只认名单里的工作区，Home 会话不在其中", () => {
    const scope = { kind: "workspaces", ids: ["w1", "w2"] } as const;
    assert.equal(scopeApplies({ ...scope, ids: [...scope.ids] }, "w2"), true);
    assert.equal(scopeApplies({ ...scope, ids: [...scope.ids] }, "w3"), false);
    assert.equal(scopeApplies({ ...scope, ids: [...scope.ids] }, null), false);
  });
  it("off 对谁都不生效；空名单的 workspaces 也不覆盖任何会话", () => {
    assert.equal(scopeApplies({ kind: "off" }, "w1"), false);
    assert.equal(scopeApplies({ kind: "workspaces", ids: [] }, "w1"), false);
  });
});

describe("视图 id", () => {
  it("来回拆得回去", () => {
    for (const [origin, key] of [
      ["plugin", "pdf"],
      ["user-skill", "my-skill"],
      ["user-mcp", "miyo"],
    ] as const) {
      assert.deepEqual(parsePluginViewId(pluginViewId(origin, key)), { origin, key });
    }
  });
  it("不认没有前缀或只有前缀的 id", () => {
    assert.equal(parsePluginViewId("pdf"), null);
    assert.equal(parsePluginViewId("plugin:"), null);
    assert.equal(parsePluginViewId("other:x"), null);
  });
});

describe("isBlockingMcpProblem", () => {
  it("找不到可执行文件只是提醒，其余都挡开轮装配", () => {
    assert.equal(isBlockingMcpProblem(null), false);
    assert.equal(isBlockingMcpProblem({ kind: "command-missing", command: "/x" }), false);
    assert.equal(isBlockingMcpProblem({ kind: "unknown-variable", variable: "X" }), true);
    assert.equal(isBlockingMcpProblem({ kind: "config-missing", key: "k" }), true);
    assert.equal(isBlockingMcpProblem({ kind: "invalid", reason: "r" }), true);
  });
});
