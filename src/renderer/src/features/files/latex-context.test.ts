/**
 * LaTeX 上下文的裁决（2026-11-16「点了没反应」的现场 bug）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { latexContextOf } from "./latex-context.ts";

const tab = (path = "/w/main.tex", extra: { name?: string } = {}) => ({
  root: "/w",
  path,
  ...extra,
});

describe("latexContextOf", () => {
  it("没打开文件 → null（树就是整个面板，没有可编的东西）", () => {
    assert.equal(
      latexContextOf({ activeTab: null, sessionId: "s1", workspaceId: "w1" }),
      null,
    );
  });

  it("没有绑定会话 → null（原来是照样构造，点编译才报 invalid session id）", () => {
    assert.equal(
      latexContextOf({ activeTab: tab(), sessionId: null, workspaceId: null }),
      null,
    );
  });

  it("附图标签（有合成名）→ null（原图引用不在任何工作区里）", () => {
    assert.equal(
      latexContextOf({ activeTab: tab("uuid:att-1", { name: "image-1.png" }), sessionId: "s1", workspaceId: "w1" }),
      null,
    );
  });

  it("绑定了会话 → 完整上下文（root + path + 会话 / 工作区）", () => {
    assert.deepEqual(latexContextOf({ activeTab: tab(), sessionId: "s1", workspaceId: "w1" }), {
      sessionId: "s1",
      workspaceId: "w1",
      root: "/w",
      path: "/w/main.tex",
    });
  });

  it("专注 / 浏览态的额外根只在给出时才带（不能给主进程一个 undefined 字段）", () => {
    assert.equal("extraWorkspaceId" in (latexContextOf({ activeTab: tab(), sessionId: "s1", workspaceId: "w1" }) ?? {}), false);
    assert.equal(
      latexContextOf({ activeTab: tab(), sessionId: "s1", workspaceId: "w1", focusWorkspaceId: "x1" })?.extraWorkspaceId,
      "x1",
    );
    assert.equal(
      "extraWorkspaceId" in (latexContextOf({ activeTab: tab(), sessionId: "s1", workspaceId: "w1", focusWorkspaceId: null }) ?? {}),
      false,
    );
  });
});
