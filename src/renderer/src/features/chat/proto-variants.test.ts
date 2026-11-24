import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentNameVariantOf, avatarVariantOf, mergeVariants, nameOrderOf, orbitEVariantOf, rowLabelOf, wsTitleVariantOf } from "./proto-variants.ts";

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
    const rest = { orbitE: "0.3" } as const;
    const base = { title: "header", avatar: "seeded", agentName: "off", ...rest } as const;
    assert.deepEqual(mergeVariants(base, { title: "both" }), { title: "both", avatar: "seeded", agentName: "off", ...rest });
    assert.deepEqual(mergeVariants(base, { avatar: "same", title: "x" }), { title: "header", avatar: "same", agentName: "off", ...rest });
    assert.deepEqual(mergeVariants({ ...base, avatar: "same", agentName: "on" }, {}), { title: "header", avatar: "same", agentName: "on", ...rest });
    assert.equal(mergeVariants(base, { orbitE: "0.45" }).orbitE, "0.45");
    assert.equal(mergeVariants(base, { orbitE: 0.45 }).orbitE, "0.3");
    // 眼睛不再是临时开关（进了设计面板）：传 eyes 不改任何东西
    const stale: Record<string, unknown> = { eyes: "xl" };
    assert.deepEqual(mergeVariants(base, stale), base);
    assert.equal(mergeVariants(base, { agentName: "on" }).agentName, "on");
    assert.equal(mergeVariants(base, { agentName: "yes" }).agentName, "off");
  });
  test("偏心率候选：地址里给合法值才用，缺省是 0.3", () => {
    assert.equal(orbitEVariantOf(""), "0.3");
    assert.equal(orbitEVariantOf("?orbitE=0.15"), "0.15");
    assert.equal(orbitEVariantOf("?orbitE=0.9"), "0.3");
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

describe("名字顺序（页头、设计面板、树根卡共用）：工作区名为主、智能体名为副，候选开关反过来", () => {
  test("默认：工作区名为主", () => {
    assert.deepEqual(nameOrderOf("off", "意图系统", "烛霓"), { primary: "意图系统", secondary: "烛霓" });
  });
  test("agentName=on：智能体名为主", () => {
    assert.deepEqual(nameOrderOf("on", "意图系统", "烛霓"), { primary: "烛霓", secondary: "意图系统" });
  });
  test("没起名 / 与工作区同名 / 只有空白：只有主名", () => {
    assert.deepEqual(nameOrderOf("on", "orbita", ""), { primary: "orbita", secondary: null });
    assert.deepEqual(nameOrderOf("off", "orbita", "orbita"), { primary: "orbita", secondary: null });
    assert.deepEqual(nameOrderOf("off", "orbita", "  "), { primary: "orbita", secondary: null });
  });
});
