/**
 * 召回打分（retrieve.ts）——词法打分移植的正确性、常驻语义（user 层偏好按时间
 * 取新）、两层合并去重与 muted 过滤。纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeById,
  isRecallable,
  isRestatement,
  lexicalScore,
  pickPinned,
  recallHits,
  retrieveMemories,
  selectHits,
  tokenize,
  type MemoryQuery,
  searchMemories,
} from "./retrieve.ts";
import type { MemoryEntry } from "../shared/memory.ts";

function entry(overrides: Partial<MemoryEntry> & { id?: string }): MemoryEntry {
  return {
    id: "mem_default",
    type: "fact",
    text: "用户的项目 orbita 用 bun",
    keywords: ["bun", "orbita"],
    layer: "workspace",
    scopeId: "ws-1",
    sessionId: "s1",
    turns: [1],
    at: Date.now(),
    episodeId: "ep_1",
    source: "chat",
    ...overrides,
  };
}

test("tokenize：拉丁词 + CJK bigram + 单字", () => {
  assert.deepEqual(tokenize("electron-vite 0.1.6"), ["electron-vite", "0.1.6"]);
  assert.deepEqual(tokenize("我的猫叫什么"), ["我的", "的猫", "猫叫", "叫什", "什么"]);
  assert.deepEqual(tokenize("库"), ["库"]);
});

test("lexicalScore：关键词全中给满分；子串通道给中文问句兑底", () => {
  const target = entry({});
  const english: MemoryQuery = { text: "bun orbita", tokens: new Set(["bun", "orbita"]) };
  assert.ok(lexicalScore(english, target) >= 0.7);
  // 中文问句与关键词「猫」零 bigram 交集，但关键词在原文出现 → 子串通道过阈值
  const cat = entry({ id: "mem_cat", text: "用户养了一只猫", keywords: ["猫"] });
  const chinese: MemoryQuery = { text: "我的猫叫什么名字", tokens: new Set(tokenize("我的猫叫什么名字")) };
  assert.ok(lexicalScore(chinese, cat) >= 0.3);
});

test("lexicalScore：关键词 bigram 覆盖通道——复合关键词撞上部分说法边过阈值", () => {
  // 2026-10-29 真机冒烟的实测样本：条目关键词「依赖管理」，query 只说「装依赖」。
  // 子串通道要求整词出现（擦肩而过），token 通道被长 query 稀释——覆盖通道兑底
  const entryBun = entry({ id: "mem_bun", text: "用户的项目依赖统一用 bun 管理", keywords: ["bun", "依赖管理"] });
  const query: MemoryQuery = {
    text: "我要初始化一个新的前端项目，先帮我装依赖。",
    tokens: new Set(tokenize("我要初始化一个新的前端项目，先帮我装依赖。")),
  };
  assert.ok(lexicalScore(query, entryBun) >= 0.3);
  // 关键词的 bigram 一个都不在 query 里 → 覆盖通道不兑底（偶然单字重叠不算）
  const miss = entry({ id: "mem_miss", text: "用户讨厌合并半成品", keywords: ["合并"] });
  const missQuery: MemoryQuery = { text: "帮我装依赖", tokens: new Set(tokenize("帮我装依赖")) };
  assert.ok(lexicalScore(missQuery, miss) < 0.3);
});

test("retrieveMemories：阈值门控、top 限制、字符预算", () => {
  const now = Date.now();
  const pool = [
    // 各自不同的轮：这里测阈值与预算，不测同源复述（见文末那组）
    entry({ id: "m1", keywords: ["bun"], text: "第一条".repeat(10), at: now, turns: [1] }),
    entry({ id: "m2", keywords: ["bun"], text: "第二条".repeat(10), at: now - 1000, turns: [2] }),
    entry({ id: "m3", keywords: ["无关"], text: "不相关的记忆", at: now, turns: [3] }),
  ];
  const hits = retrieveMemories(pool, "bun 用哪个", { now });
  assert.equal(hits.length, 2); // m3 过不了阈值
  assert.equal(hits[0]?.entry.id, "m1"); // 同分新者前
  // 字符预算：装不下整条就跳过，短的可能装得下
  const tight = retrieveMemories(pool, "bun", { now, maxChars: 5 });
  assert.ok(tight.length <= 1);
  assert.ok((tight[0]?.entry.text.length ?? 0) <= 5 || tight.length === 1);
});

test("retrieveMemories：空库 / 空 query 返回空", () => {
  assert.deepEqual(retrieveMemories([], "bun"), []);
  assert.deepEqual(retrieveMemories([entry({ id: "m1" })], "！！！"), []);
});

test("pickPinned：只取 user 层偏好，按时间新者前，条数与预算双门", () => {
  const pool = [
    entry({ id: "old", type: "preference", layer: "user", scopeId: undefined, text: "旧的偏好", at: 1, turns: [2] }),
    entry({ id: "fact-user", layer: "user", scopeId: undefined, text: "user 层的事实", at: 999 }),
    entry({ id: "pref-ws", type: "preference", text: "工作区层的偏好", at: 998 }),
    entry({ id: "new", type: "preference", layer: "user", scopeId: undefined, text: "新的偏好", at: 100 }),
  ];
  const picked = pickPinned(pool);
  assert.deepEqual(picked.map((each) => each.id), ["new", "old"]); // 只认 user 层偏好，新者前
});

test("recallHits：两层合并、id 去重、muted 过滤、常驻打满分区不出两次", () => {
  const now = Date.now();
  const shared = entry({ id: "dup", layer: "user", scopeId: undefined, type: "preference", text: "两边都有的偏好", at: now });
  const layers = {
    user: [shared, entry({ id: "muted", status: "muted", keywords: ["bun"], text: "被关掉的", layer: "user", scopeId: undefined, at: now })],
    scope: [shared, entry({ id: "hit", keywords: ["bun"], text: "词法命中", at: now })],
  };
  const hits = recallHits(layers, "bun", now);
  const ids = hits.map((hit) => hit.entry.id);
  assert.equal(ids.filter((id) => id === "dup").length, 1); // 去重
  assert.ok(!ids.includes("muted")); // muted 不进召回
  assert.ok(ids.includes("hit"));
  assert.ok(ids.includes("dup")); // user 层偏好常驻
});

test("dedupeById / isRecallable 的独立口径", () => {
  assert.equal(dedupeById([entry({ id: "a" }), entry({ id: "a" })]).length, 1);
  assert.equal(isRecallable(entry({ id: "a" })), true);
  assert.equal(isRecallable(entry({ id: "a", status: "muted" })), false);
});

/* ---------- 同源复述（三类提取各写一遍的同一件事）只占一个名额 ---------- */

// 2026-10-29 隔离实例 memui 的真实提取条目（同一事件段、同一轮）
const coffeeFact = entry({
  id: "f",
  type: "fact",
  text: "用户写作前习惯喝不加糖的手冲咖啡，并称甜饮会让自己犯困（2026-10-29 陈述）。",
  keywords: ["手冲咖啡", "不加糖", "甜饮", "犯困", "写作"],
  turns: [3],
});
const coffeePreference = entry({
  id: "p",
  type: "preference",
  text: "2026-10-29，用户表示写作前习惯喝不加糖的手冲咖啡，并且不喝甜饮，因为甜饮会让用户犯困。",
  keywords: ["手冲咖啡", "不加糖", "甜饮", "写作习惯"],
  turns: [3],
});
const coffeeInsight = entry({
  id: "i",
  type: "insight",
  text: "在为用户安排写作等日常习惯时，应排除用户明确说会带来负面影响的东西（如甜饮让人犯困），只保留其已验证有效的做法（如写作前喝不加糖的手冲咖啡），不要按通用建议额外添加。",
  keywords: ["日常习惯", "负面影响", "排除", "已验证做法"],
  turns: [3],
});

test("isRestatement：同段同轮的换说法复述算；抽象了一层的经验不算", () => {
  assert.equal(isRestatement(coffeeFact, coffeePreference), true);
  // QUMem：同一段交互可以支撑不同抽象层次的记忆——这对要两条都留
  assert.equal(isRestatement(coffeeFact, coffeeInsight), false);
  assert.equal(isRestatement(coffeePreference, coffeeInsight), false);
});

test("isRestatement：不同事件段 / 轮号不相交 / 手动添加都不算同源", () => {
  assert.equal(isRestatement(coffeeFact, { ...coffeePreference, episodeId: "ep_2" }), false);
  assert.equal(isRestatement(coffeeFact, { ...coffeePreference, turns: [4] }), false);
  assert.equal(isRestatement({ ...coffeeFact, episodeId: "" }, { ...coffeePreference, episodeId: "" }), false);
});

test("selectHits：复述只留名次最高的一条，名额让给后面的不同内容", () => {
  const other = (id: string) => entry({ id, text: `另一件事 ${id}`, keywords: [id], episodeId: `ep_${id}` });
  const ranked = [coffeePreference, coffeeFact, coffeeInsight, other("a"), other("b"), other("c"), other("d")].map(
    (item, index) => ({ entry: item, score: 1 - index * 0.1 }),
  );
  const hits = selectHits(ranked, { limit: 5, maxChars: 10_000, taken: [] });
  assert.deepEqual(
    hits.map((hit) => hit.entry.id),
    ["p", "i", "a", "b", "c"],
  );
});

test("recallHits：常驻已装车的偏好，它的同源复述不再占词法名额", () => {
  const pinned = { ...coffeePreference, layer: "user" as const, scopeId: undefined };
  const hits = recallHits({ user: [pinned], scope: [coffeeFact] }, "写作前喝手冲咖啡", Date.now());
  assert.deepEqual(
    hits.map((hit) => [hit.entry.id, hit.pinned === true]),
    [["p", true]],
  );
});

/* ---------- memory_search 的排序（searchMemories） ---------- */

function plain(id: string, text: string, keywords: string[] = []): MemoryEntry {
  return {
    id, type: "fact", text, keywords, layer: "workspace", scopeId: "ws", sessionId: "s", turns: [1],
    at: 1, episodeId: "ep", source: "chat",
  };
}

const SEARCH_POOL = [
  plain("cat", "用户养了一只叫团子的橘猫"),
  plain("coffee", "用户喝咖啡只喝美式"),
  plain("report", "用户写工作汇报要分三条要点", ["写作习惯"]),
  plain("standup", "用户每天下午 2 点开站会", ["站会"]),
  plain("bun", "用户的项目用 bun 管依赖", ["bun"]),
];

test("searchMemories：agent 的短检索句也能找到条目（实例实测两次空手的回归）", () => {
  for (const query of ["猫的名字 团子", "猫 宠物 名字"]) {
    const hits = searchMemories(SEARCH_POOL, query, { limit: 8, now: 1 });
    assert.equal(hits[0]?.entry.id, "cat", query);
  }
});

test("searchMemories：每条都有的词（用户）按区分度降权——不会把沾边的都回出来", () => {
  // 「用户」每条都有、「习惯」只沾到汇报那条的关键词：按区分度加权后只回咖啡那条
  const hits = searchMemories(SEARCH_POOL, "用户喝咖啡的习惯 美式", { limit: 8, now: 1 });
  assert.deepEqual(hits.map((hit) => hit.entry.id), ["coffee"]);
  assert.deepEqual(searchMemories(SEARCH_POOL, "量子计算", { limit: 8, now: 1 }), []);
});
