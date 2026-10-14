/**
 * 摘抄页签过滤的测试：本会话 / 全部两档与关键词匹配口径。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { MemoryExcerptItem } from "../../../../shared/memory.ts";
import { filterExcerpts } from "./excerpt-filter.ts";

const item = (id: string, extra: Partial<MemoryExcerptItem["entry"]>, sessionTitle: string | null = "那次讨论"): MemoryExcerptItem => ({
  entry: {
    id,
    text: `摘抄 ${id}`,
    keywords: [],
    sessionId: extra.sessionId ?? "s1",
    timestamp: 1,
    source: "excerpt",
    ...extra,
  },
  token: "t".repeat(40),
  sessionTitle,
  current: false,
});

const WORDS = { position: "我说的 · 立场", agree: "agent 说的 · 认同" } as Record<string, string>;

describe("filterExcerpts", () => {
  const items = [
    item("a", { sessionId: "s1", text: "先调研再动手", stance: "position" }),
    item("b", { sessionId: "s2", text: "多 agent 不需要 SDK", stance: "agree" }, "另一条会话"),
    item("c", { sessionId: "s1", text: "dev 端口固定", stance: "doubt" }, null),
  ];

  test("本会话档只留这条会话摘的；全部档原样", () => {
    assert.deepEqual(
      filterExcerpts(items, "session", "s1", "", WORDS).map((x) => x.entry.id),
      ["a", "c"],
    );
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "", WORDS).map((x) => x.entry.id),
      ["a", "b", "c"],
    );
  });

  test("关键词按正文 / 出处标题 / 态度词匹配，大小写不敏感；空搜索 = 全过", () => {
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "调研", WORDS).map((x) => x.entry.id),
      ["a"],
    );
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "另一条", WORDS).map((x) => x.entry.id),
      ["b"],
    );
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "SDK", WORDS).map((x) => x.entry.id),
      ["b"],
    );
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "认同", WORDS).map((x) => x.entry.id),
      ["b"],
    );
    assert.equal(filterExcerpts(items, "all", "s1", "  ", WORDS).length, 3);
    assert.deepEqual(filterExcerpts(items, "all", "s1", "不存在的词", WORDS), []);
  });

  test("会话已删（标题 null）的条目仍按正文搜得到", () => {
    assert.deepEqual(
      filterExcerpts(items, "all", "s1", "端口", WORDS).map((x) => x.entry.id),
      ["c"],
    );
  });
});
