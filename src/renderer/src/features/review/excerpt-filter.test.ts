import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExcerptItem } from "../../../../shared/excerpt.ts";
import { filterExcerpts } from "./excerpt-filter.ts";

const item = (id: string, sessionId: string, text: string, title: string | null = "某次会话"): ExcerptItem => ({
  excerpt: { id, text, sessionId, turn: 1, role: "assistant", createdAt: 0 },
  sessionTitle: title,
});

const items = [
  item("a", "s1", "多 agent 不一定需要一个 SDK"),
  item("b", "s2", "先调研再动手，结论用自然语言讲", "开源准备"),
  item("c", "s1", "dev server 固定在 127.0.0.1:5274", null),
];

describe("filterExcerpts", () => {
  test("本会话档只留这条会话的，全部档全留，顺序不变", () => {
    assert.deepEqual(filterExcerpts(items, "session", "s1", "").map((x) => x.excerpt.id), ["a", "c"]);
    assert.deepEqual(filterExcerpts(items, "all", "s1", "").map((x) => x.excerpt.id), ["a", "b", "c"]);
  });

  test("没打开会话时本会话档为空", () => {
    assert.deepEqual(filterExcerpts(items, "session", null, ""), []);
  });

  test("关键词匹配正文与会话标题，大小写不敏感；多个词都要命中", () => {
    assert.deepEqual(filterExcerpts(items, "all", "s1", "sdk").map((x) => x.excerpt.id), ["a"]);
    assert.deepEqual(filterExcerpts(items, "all", "s1", "开源").map((x) => x.excerpt.id), ["b"]);
    assert.deepEqual(filterExcerpts(items, "all", "s1", "dev 5274").map((x) => x.excerpt.id), ["c"]);
    assert.deepEqual(filterExcerpts(items, "all", "s1", "dev bun"), []);
    assert.equal(filterExcerpts(items, "all", "s1", "   ").length, 3);
  });

  test("会话已删（标题 null）时只按正文匹配", () => {
    assert.deepEqual(filterExcerpts(items, "all", "s1", "某次").map((x) => x.excerpt.id), ["a"]);
  });
});
