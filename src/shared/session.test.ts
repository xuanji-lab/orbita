import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSessionTitle, parseSessionMeta, SESSION_TITLE_MAX } from "./session.ts";

const valid = {
  id: "a7f3c1d2",
  title: "Rebuild the renderer",
  cwd: "/Users/wafo/repo/orbita-lab",
  workspaceId: null,
  piSessionFile: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
  createdAt: 1000,
  updatedAt: 2000,
};

describe("deriveSessionTitle", () => {
  it("取第一行", () => {
    strictEqual(deriveSessionTitle("把外壳重做一遍\n第二行不要"), "把外壳重做一遍");
  });

  it("前后空白不进标题", () => {
    strictEqual(deriveSessionTitle("  \n  重做外壳  \n"), "重做外壳");
  });

  it("超长截断加省略号——侧栏只有 288px，标题得一行放得下", () => {
    const title = deriveSessionTitle("x".repeat(200));
    strictEqual(title.length, SESSION_TITLE_MAX + 1);
    strictEqual(title.endsWith("…"), true);
  });

  it("刚好不超长就不截断", () => {
    const text = "y".repeat(SESSION_TITLE_MAX);
    strictEqual(deriveSessionTitle(text), text);
  });

  it("空输入给空标题——会话可以建了还没发过消息", () => {
    strictEqual(deriveSessionTitle("   \n  "), "");
  });
});

describe("parseSessionMeta", () => {
  it("完整的一条原样解出来", () => {
    deepStrictEqual(parseSessionMeta(valid), { ...valid, mode: "manual" });
  });

  // 少一条会话，比多一条指向空白的假会话好
  it("缺关键字段返回 null，让调用方跳过这条", () => {
    for (const key of ["id", "cwd", "providerId", "modelId", "createdAt"]) {
      const broken = { ...valid, [key]: undefined };
      strictEqual(parseSessionMeta(broken), null, `缺 ${key} 时应当返回 null`);
    }
    strictEqual(parseSessionMeta({ ...valid, id: "" }), null);
    strictEqual(parseSessionMeta(null), null);
    strictEqual(parseSessionMeta("{}"), null);
    strictEqual(parseSessionMeta([]), null);
  });

  it("标题可以缺——建了还没发消息的会话就是这样", () => {
    strictEqual(parseSessionMeta({ ...valid, title: undefined })?.title, "");
  });

  it("不认识的权限档退回最保守的 plan，而不是丢掉整条会话", () => {
    strictEqual(parseSessionMeta({ ...valid, mode: "yolo" })?.mode, "plan");
    strictEqual(parseSessionMeta({ ...valid, mode: undefined })?.mode, "plan");
  });

  it("缺 updatedAt 就用 createdAt 兜底", () => {
    strictEqual(parseSessionMeta({ ...valid, updatedAt: undefined })?.updatedAt, valid.createdAt);
  });

  it("不认识的字段丢掉，不原样带过去", () => {
    deepStrictEqual(parseSessionMeta({ ...valid, junk: 1, nested: { a: 1 } }), {
      ...valid,
      mode: "manual",
    });
  });

  // 本字段落地之前存的会话没有 pi 的本子，只能读不能续——界面要如实说出来
  it("缺 piSessionFile 视为不能续", () => {
    strictEqual(parseSessionMeta({ ...valid, piSessionFile: undefined })?.piSessionFile, null);
    strictEqual(parseSessionMeta({ ...valid, piSessionFile: 7 })?.piSessionFile, null);
    strictEqual(
      parseSessionMeta({ ...valid, piSessionFile: "/x/pi-sessions/a.jsonl" })?.piSessionFile,
      "/x/pi-sessions/a.jsonl",
    );
  });

  // 刀 B 之前存下的会话没有这个字段，它们不属于任何工作区，落到侧栏 TASKS 下
  it("缺 workspaceId 视为不属于任何工作区", () => {
    strictEqual(parseSessionMeta({ ...valid, workspaceId: undefined })?.workspaceId, null);
    strictEqual(parseSessionMeta({ ...valid, workspaceId: 42 })?.workspaceId, null);
    strictEqual(parseSessionMeta({ ...valid, workspaceId: "w1" })?.workspaceId, "w1");
  });
});
