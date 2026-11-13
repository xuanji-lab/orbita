import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OfmResolved } from "../../../../shared/doc.ts";
import { createTargetResolver } from "./ofm-targets.ts";

const hit = (name: string): OfmResolved => ({ path: `/w/${name}`, root: "/w", relative: name });

describe("文档目标解析器", () => {
  it("同一拍里的多个查询合并成一次 IPC；同目标走缓存", async () => {
    const calls: string[][] = [];
    const resolver = createTargetResolver(async (items) => {
      calls.push(items.map((i) => `${i.kind}:${i.target}`));
      return items.map((i) => (i.target === "丢了" ? null : hit(i.target)));
    });
    const [a, b, c, a2] = await Promise.all([
      resolver.resolve("a.png", "image"),
      resolver.resolve("页", "link"),
      resolver.resolve("丢了", "link"),
      resolver.resolve("a.png", "image"),
    ]);
    assert.equal(a?.relative, "a.png");
    assert.equal(b?.relative, "页");
    assert.equal(c, null);
    assert.equal(a2, a);
    assert.deepEqual(calls, [["image:a.png", "link:页", "link:丢了"]]);
    await resolver.resolve("a.png", "image");
    assert.equal(calls.length, 1);
  });

  it("invalidate 后重新问；IPC 出错当找不到且不缓存失败", async () => {
    let fail = true;
    let n = 0;
    const resolver = createTargetResolver(async (items) => {
      n += 1;
      if (fail) throw new Error("boom");
      return items.map((i) => hit(i.target));
    });
    assert.equal(await resolver.resolve("x", "link"), null);
    fail = false;
    assert.equal((await resolver.resolve("x", "link"))?.relative, "x");
    assert.equal(n, 2);
    resolver.invalidate();
    await resolver.resolve("x", "link");
    assert.equal(n, 3);
  });
});
