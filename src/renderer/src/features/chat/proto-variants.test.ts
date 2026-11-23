import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { avatarVariantOf, mergeVariants, showQuietSlogan, wsTitleVariantOf } from "./proto-variants.ts";

describe("编排工作区页候选版式", () => {
  test("地址参数：title=header 才是页头版，其余（含缺省、坏值）都是现状", () => {
    assert.equal(wsTitleVariantOf("?title=header"), "header");
    assert.equal(wsTitleVariantOf("?avatar=same&title=header"), "header");
    for (const search of ["", "?title=both", "?title=x", "?avatar=same"]) assert.equal(wsTitleVariantOf(search), "both");
  });
  test("页头版只在星系全空时留 slogan；现状版永远不走这条（门面另有）", () => {
    assert.equal(showQuietSlogan("header", { planets: [], sessions: 0 }), true);
    assert.equal(showQuietSlogan("header", { planets: [], sessions: 3 }), false);
    assert.equal(showQuietSlogan("header", { planets: [1], sessions: 0 }), false);
    assert.equal(showQuietSlogan("both", { planets: [], sessions: 0 }), false);
  });

  test("头像候选：avatar=same 才是全同，其余（含缺省、坏值）都是种子默认", () => {
    assert.equal(avatarVariantOf("?avatar=same"), "same");
    for (const search of ["", "?avatar=seeded", "?avatar=x", "?title=header"]) assert.equal(avatarVariantOf(search), "seeded");
  });
  test("运行时切换：只认合法值，坏值忽略，没给的保持", () => {
    const base = { title: "both", avatar: "seeded" } as const;
    assert.deepEqual(mergeVariants(base, { title: "header" }), { title: "header", avatar: "seeded" });
    assert.deepEqual(mergeVariants(base, { avatar: "same", title: "x" }), { title: "both", avatar: "same" });
    assert.deepEqual(mergeVariants({ title: "header", avatar: "same" }, {}), { title: "header", avatar: "same" });
  });
});
