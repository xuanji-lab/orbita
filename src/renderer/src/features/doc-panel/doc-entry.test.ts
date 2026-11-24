import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { baseOfPath, dirOfPath, initialOpenPath, splitWhere } from "./doc-entry.ts";

describe("initialOpenPath：点入口时开哪份", () => {
  it("上次打开的那份还在 → 接着开它", () => {
    assert.equal(initialOpenPath({ requested: null, remembered: "/w/a.md", rememberedExists: true }), "/w/a.md");
  });
  it("从没打开过 → 空态（不挑最近改的那份）", () => {
    assert.equal(initialOpenPath({ requested: null, remembered: null, rememberedExists: false }), null);
  });
  it("上次那份被删了 / 被移出工作区 → 回到空态", () => {
    assert.equal(initialOpenPath({ requested: null, remembered: "/w/a.md", rememberedExists: false }), null);
  });
  it("外部已经要求打开某份 → 让位，这里不开", () => {
    assert.equal(initialOpenPath({ requested: "/w/b.md", remembered: "/w/a.md", rememberedExists: true }), null);
  });
});

describe("路径写法", () => {
  it("目录与文件名，兼容 Windows 反斜杠", () => {
    assert.equal(dirOfPath("/Users/me/ws/未命名文档.md"), "/Users/me/ws");
    assert.equal(baseOfPath("/Users/me/ws/未命名文档.md"), "未命名文档.md");
    assert.equal(dirOfPath("C:\\code\\ws\\a.md"), "C:\\code\\ws");
    assert.equal(baseOfPath("C:\\code\\ws\\a.md"), "a.md");
    assert.equal(baseOfPath("a.md"), "a.md");
  });
  it("splitWhere：前段 + 末级目录名；两段拼回去就是原路径（去掉末尾分隔符）", () => {
    assert.deepEqual(splitWhere("/Users/me/Orbita/research-vault"), { head: "/Users/me/Orbita/", tail: "research-vault" });
    assert.deepEqual(splitWhere("/Users/me/Orbita/research-vault/"), { head: "/Users/me/Orbita/", tail: "research-vault" });
    assert.deepEqual(splitWhere("C:\\code\\ws"), { head: "C:\\code\\", tail: "ws" });
    assert.deepEqual(splitWhere("ws"), { head: "", tail: "ws" });
    assert.deepEqual(splitWhere("/"), { head: "", tail: "" });
  });
});
