import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { liveFileOpen } from "./open-panel.ts";

describe("liveFileOpen：文件面板的打开请求只管那一次", () => {
  it("没作废过：请求原样交给面板", () => {
    deepStrictEqual(liveFileOpen({ path: "/a.txt", token: 1 }, null), { path: "/a.txt", token: 1 });
  });
  it("面板离开时作废了这一条：再挂面板不重放", () => {
    deepStrictEqual(liveFileOpen({ path: "/a.txt", token: 1 }, 1), null);
  });
  it("之后来的新请求 token 不同，照常生效", () => {
    deepStrictEqual(liveFileOpen({ path: "/b.txt", token: 2 }, 1), { path: "/b.txt", token: 2 });
  });
  it("没有请求就是没有", () => {
    deepStrictEqual(liveFileOpen(null, 3), null);
  });
});
