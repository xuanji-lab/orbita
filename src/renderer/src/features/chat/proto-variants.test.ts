import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentNameVariantOf, avatarVariantOf, mergeVariants, rowLabelOf, wsTitleVariantOf } from "./proto-variants.ts";

describe("编排工作区页候选版式", () => {
  test("地址参数：title=both 才是带大标题的第一版，其余（含缺省、坏值）都是页头版（默认）", () => {
    assert.equal(wsTitleVariantOf("?title=both"), "both");
    assert.equal(wsTitleVariantOf("?avatar=same&title=both"), "both");
    for (const search of ["", "?title=header", "?title=x", "?avatar=same"]) assert.equal(wsTitleVariantOf(search), "header");
  });
  test("头像候选：avatar=same 才是全同，其余（含缺省、坏值）都是种子默认", () => {
    assert.equal(avatarVariantOf("?avatar=same"), "same");
    for (const search of ["", "?avatar=seeded", "?avatar=x", "?title=header"]) assert.equal(avatarVariantOf(search), "seeded");
  });
  test("运行时切换：只认合法值，坏值忽略，没给的保持", () => {
    const base = { title: "header", avatar: "seeded", agentName: "off" } as const;
    assert.deepEqual(mergeVariants(base, { title: "both" }), { title: "both", avatar: "seeded", agentName: "off" });
    assert.deepEqual(mergeVariants(base, { avatar: "same", title: "x" }), { title: "header", avatar: "same", agentName: "off" });
    assert.deepEqual(mergeVariants({ title: "header", avatar: "same", agentName: "on" }, {}), { title: "header", avatar: "same", agentName: "on" });
    assert.equal(mergeVariants(base, { agentName: "on" }).agentName, "on");
    assert.equal(mergeVariants(base, { agentName: "yes" }).agentName, "off");
  });
  test("侧栏名字候选：默认只写工作区名；开了写「智能体名 · 工作区名」，没起名 / 同名时照旧", () => {
    assert.equal(agentNameVariantOf(""), "off");
    assert.equal(agentNameVariantOf("?agentName=on"), "on");
    assert.equal(rowLabelOf("off", "意图系统", "烛霓"), "意图系统");
    assert.equal(rowLabelOf("on", "意图系统", "烛霓"), "烛霓 · 意图系统");
    assert.equal(rowLabelOf("on", "意图系统", " "), "意图系统");
    assert.equal(rowLabelOf("on", "orbita", "orbita"), "orbita");
  });
});
