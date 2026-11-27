import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveChatPath, rootOf } from "./chat-paths.ts";

describe("resolveChatPath：回答里的图片路径 → 盘上的绝对路径", () => {
  test("markdown 管线编过的中文路径解回来（2026-11-22 实例里第一张图就因此没显示）", () => {
    assert.equal(
      resolveChatPath("/Users/a/Home/%E6%96%B0%E5%8A%A0%E5%9D%A1.png", null),
      "/Users/a/Home/新加坡.png",
    );
  });
  test("file:// 地址与相对路径", () => {
    assert.equal(resolveChatPath("file:///Users/a/x.png", null), "/Users/a/x.png");
    assert.equal(resolveChatPath("./shots/x.png", "/w/s"), "/w/s/shots/x.png");
    assert.equal(resolveChatPath("x.png", null), null);
  });
  test("坏的百分号编码原样留着，不抛", () => {
    assert.equal(resolveChatPath("/a/100%.png", null), "/a/100%.png");
  });
});

describe("rootOf：路径落在哪个根（最长前缀）", () => {
  const roots = [
    { kind: "workspace" as const, label: "w", path: "/w", exists: true },
    { kind: "attached" as const, label: "deep", path: "/w/deep", exists: true },
  ];
  test("取最长的那个根；同名前缀不算", () => {
    assert.equal(rootOf("/w/deep/a.png", roots)?.label, "deep");
    assert.equal(rootOf("/w/a.png", roots)?.label, "w");
    assert.equal(rootOf("/wx/a.png", roots), null);
  });
});
