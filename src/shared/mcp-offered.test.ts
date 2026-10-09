import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isMcpServerOffered } from "./mcp.ts";

const ws = { id: "w-1", name: "paper3" };
const row = (over: Partial<{ disabled: boolean; scopedTo: string[]; global: boolean; workspaces: string[] }> = {}) => ({
  disabled: over.disabled ?? false,
  scopedTo: over.scopedTo ?? [],
  source: { global: over.global ?? true, workspaces: over.workspaces ?? [] },
});

describe("isMcpServerOffered —— 斜杠面板只列当前工作区能用的 server", () => {
  test("全局、无白名单、启用：任何工作区与 Home 都列", () => {
    assert.equal(isMcpServerOffered(row(), ws), true);
    assert.equal(isMcpServerOffered(row(), null), true);
  });

  test("停用：不列", () => {
    assert.equal(isMcpServerOffered(row({ disabled: true }), ws), false);
  });

  test("只在 B 工作区 .mcp.json 里定义：A 工作区与 Home 不列，B 列", () => {
    const onlyB = row({ global: false, workspaces: ["writing"] });
    assert.equal(isMcpServerOffered(onlyB, ws), false);
    assert.equal(isMcpServerOffered(onlyB, null), false);
    assert.equal(isMcpServerOffered(onlyB, { id: "w-2", name: "writing" }), true);
  });

  test("全局定义但白名单限定：名或 id 命中才列，Home 不列", () => {
    assert.equal(isMcpServerOffered(row({ scopedTo: ["paper3"] }), ws), true);
    assert.equal(isMcpServerOffered(row({ scopedTo: ["w-1"] }), ws), true);
    assert.equal(isMcpServerOffered(row({ scopedTo: ["writing"] }), ws), false);
    assert.equal(isMcpServerOffered(row({ scopedTo: ["paper3"] }), null), false);
  });
});
