/**
 * 词法召回的回归网：正常命中（关键词优先）、阈值门控、top N、字符预算、
 * 时间衰减、空库 / 空 query。全部固定 `now`——衰减不该让用例随时间漂移。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "../../shared/memory.ts";
import { lexicalScore, retrieveMemories, tokenize, type EntryScorer } from "./retrieve.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const entry = (text: string, keywords: string[], timestamp = NOW): MemoryEntry => ({
  id: `mem_${text.slice(0, 4)}`,
  text,
  keywords,
  sessionId: "session-1",
  timestamp,
});

const CORPUS: MemoryEntry[] = [
  entry("用户偏好用 bun 作为包管理器，禁用 npm", ["bun", "包管理器"]),
  entry("项目用 electron-vite 构建，dev server 固定 5273 端口", ["electron-vite", "端口"]),
  entry("用户喜欢深色主题，界面 accent 用黄色", ["主题", "accent"]),
];

describe("tokenize", () => {
  test("拉丁词小写化，中文切 bigram，单字成段的收单字", () => {
    assert.deepEqual(tokenize("Bun 与 electron-vite"), ["bun", "electron-vite", "与"]);
    assert.deepEqual(tokenize("包管理器"), ["包管", "管理", "理器"]);
    assert.deepEqual(tokenize("库"), ["库"]);
    assert.deepEqual(tokenize("，。！"), []);
  });
});

describe("lexicalScore", () => {
  test("关键词命中权重高于只在正文里命中", () => {
    const query = { text: "包管理器", tokens: new Set(tokenize("包管理器")) };
    const inBoth = lexicalScore(query, CORPUS[0]!); // 关键词与正文都有「包管理器」
    const bodyOnly = lexicalScore(query, entry("团队约定了包管理器的选型", ["构建"]));
    assert.ok(inBoth > bodyOnly);
    assert.equal(inBoth, 1); // 3 个 token 全中：0.7（关键词）+ 0.3（正文）
    assert.ok(bodyOnly > 0 && bodyOnly < inBoth);
  });

  test("一个都不中 = 0", () => {
    assert.equal(lexicalScore({ text: "x", tokens: new Set(tokenize("终端面板")) }, CORPUS[2]!), 0);
  });

  test("query 分不出 token 时 0（不除零）", () => {
    assert.equal(lexicalScore({ text: "，。", tokens: new Set<string>() }, CORPUS[0]!), 0);
  });
});

describe("retrieveMemories", () => {
  test("正常命中：相关条目按分倒序，命中关键词的那条排最前", () => {
    const hits = retrieveMemories(CORPUS, "包管理器用什么", { now: NOW });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.entry.text, "用户偏好用 bun 作为包管理器，禁用 npm");
    assert.ok((hits[0]?.score ?? 0) >= 0.3);
  });

  test("阈值门控：只有 bigram 偶然重叠的低分条目不返回", () => {
    // query 与条目正文共享「右栏/宽度」两个 bigram，但关键词（终端）原样没出现
    // → 只有 token 通道的 (0.3+0.3)/7 ≈ 0.09，过不了 0.3
    const hits = retrieveMemories([entry("终端面板在右栏，可以拖宽度", ["终端"])], "右栏的宽度怎么调", {
      now: NOW,
    });
    assert.deepEqual(hits, []);
  });

  test("关键词在 query 原文中原样出现 = 刻意命中，压线过闸（子串通道语义）", () => {
    // 同一对 query/条目，关键词「终端」出现在问句里——哪怕 bigram 打分低，
    // 子串通道也把它抬到阈值线（真机验收缺陷修复的语义，见 lexicalScore 头注）
    const hits = retrieveMemories([entry("终端面板在右栏，可以拖宽度", ["终端"])], "终端的字号能不能调", {
      now: NOW,
    });
    assert.equal(hits.length, 1);
  });

  test("top5：第八条强命中也只装 5 条", () => {
    const many = Array.from({ length: 8 }, (_, index) => entry(`记忆 ${index}：包管理器用 bun`, ["bun", "包管理器"]));
    const hits = retrieveMemories(many, "包管理器", { now: NOW });
    assert.equal(hits.length, 5);
  });

  test("预算：长条目装到 1500 字符就停，不装半截", () => {
    const long = Array.from({ length: 8 }, (_, index) =>
      entry(`${"补".repeat(299)}${index}`, ["bun", "包管理器"]),
    );
    const hits = retrieveMemories(long, "包管理器", { now: NOW });
    assert.equal(hits.length, 5);
    assert.equal(
      hits.reduce((total, hit) => total + hit.entry.text.length, 0),
      1500,
    );
  });

  test("预算：一条就超预算时也给它（最高分那条再长也比空手强）", () => {
    const hits = retrieveMemories([entry("补".repeat(2000), ["bun"])], "bun", { now: NOW, maxChars: 1500 });
    assert.equal(hits.length, 1);
  });

  test("时间衰减：同相关内容，老条目分低、排在后", () => {
    const fresh = entry("用户偏好用 bun 作为包管理器", ["bun", "包管理器"], NOW);
    const stale = entry("用户偏好用 bun 作为包管理器", ["bun", "包管理器"], NOW - 90 * DAY);
    const hits = retrieveMemories([stale, fresh], "包管理器", { now: NOW });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.entry, fresh);
    assert.ok((hits[1]?.score ?? 1) < (hits[0]?.score ?? 0));
    // 90 天 ≈ 半个半衰期：老条目约打七折，不是判负
    assert.ok((hits[1]?.score ?? 0) > 0.3);
  });

  test("空库 / 空 query 都是空手，不抛", () => {
    assert.deepEqual(retrieveMemories([], "包管理器", { now: NOW }), []);
    assert.deepEqual(retrieveMemories(CORPUS, "，。！", { now: NOW }), []);
    assert.deepEqual(retrieveMemories(CORPUS, "", { now: NOW }), []);
  });

  test("打分器是可换的扩展位：换一个 scorer，门控 / 排序 / 预算照样走", () => {
    // ponytail: 这里只验证签名可用——embedding 打分器将来走同一条路，不实现向量检索
    const constant: EntryScorer = () => 0.9;
    const hits = retrieveMemories(CORPUS, "任意一句话", { now: NOW, scorer: constant });
    assert.equal(hits.length, 3);
    assert.ok(hits.every((hit) => hit.score === 0.9));
  });

  test("阈值与预算都可调（调用方要更严 / 更宽时不必改这里）", () => {
    const strict = retrieveMemories(CORPUS, "包管理器用什么", { now: NOW, threshold: 0.9 });
    assert.deepEqual(strict, []);
    const one = retrieveMemories(CORPUS, "包管理器用什么", { now: NOW, limit: 1 });
    assert.equal(one.length, 1);
  });
});

describe("关键词子串通道（真机验收缺陷回归：中文自然问句打 0 分）", () => {
  // 验收时的真实条目与真实问句：「我的猫叫什么名字？」对雪球条目 bigram 零交集，
  // 修复前得分 0.000 过不了阈值
  const cat = entry("用户养了一只叫「雪球」的橘猫，是 2023-05-04 捡到的。", ["雪球", "猫", "橘猫", "宠物", "2023-05-04"]);

  test("自然问句命中一个关键词即过阈值", () => {
    const hits = retrieveMemories([cat], "我的猫叫什么名字？", { now: NOW });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.entry.text, cat.text);
    assert.ok(hits[0]!.score >= 0.3);
  });

  test("多个关键词命中排更高（雪球+猫 > 只有猫）", () => {
    const single = lexicalScore({ text: "我的猫叫什么", tokens: new Set(tokenize("我的猫叫什么")) }, cat);
    const multi = lexicalScore({ text: "雪球这只猫", tokens: new Set(tokenize("雪球这只猫")) }, cat);
    assert.ok(multi > single);
    assert.ok(single >= 0.3);
  });

  test("与条目无关的问句仍然 0 分（阈值门控不被稀释）", () => {
    assert.equal(lexicalScore({ text: "今晚吃什么", tokens: new Set(tokenize("今晚吃什么")) }, cat), 0);
    assert.deepEqual(retrieveMemories([cat], "今晚吃什么", { now: NOW }), []);
  });

  test("关键词大小写不敏感（latin）", () => {
    const bun = CORPUS[0]!;
    assert.ok(lexicalScore({ text: "BUN 好用吗", tokens: new Set(tokenize("BUN 好用吗")) }, bun) >= 0.3);
  });
});
