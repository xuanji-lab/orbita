import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLast, getView, setLast, setView, type MemoryStorage } from "./view-memory.ts";

function fake(): MemoryStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe("view-memory（S2 / S4）", () => {
  it("演示文稿的页、文档的滚动位置按文件记，互不覆盖", () => {
    const s = fake();
    setView("/a.md", { page: 4 }, s);
    setView("/a.md", { scroll: 1200 }, s);
    setView("/b.md", { page: 1 }, s);
    assert.deepEqual(getView("/a.md", s), { page: 4, scroll: 1200 });
    assert.deepEqual(getView("/b.md", s), { page: 1 });
    assert.deepEqual(getView("/none.md", s), {});
  });

  it("每个工作区 × 类型各记上次打开的一份；清掉后为 null", () => {
    const s = fake();
    setLast("w1:doc", "/w1/a.md", s);
    setLast("w1:slides", "/w1/d.md", s);
    assert.equal(getLast("w1:doc", s), "/w1/a.md");
    assert.equal(getLast("w2:doc", s), null);
    setLast("w1:doc", null, s);
    assert.equal(getLast("w1:doc", s), null);
    assert.equal(getLast("w1:slides", s), "/w1/d.md");
  });

  it("记的份数有上限，最早的先丢；坏数据不抛", () => {
    const s = fake();
    for (let i = 0; i < 70; i += 1) setView(`/f${i}.md`, { page: i }, s);
    assert.deepEqual(getView("/f0.md", s), {});
    assert.deepEqual(getView("/f69.md", s), { page: 69 });
    s.setItem("orbita.docpanel.v1", "{坏的");
    assert.deepEqual(getView("/f69.md", s), {});
  });
});
