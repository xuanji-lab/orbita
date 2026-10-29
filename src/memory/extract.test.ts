/**
 * 提取提示词与解析（extract.ts）——三类各自的容错、reason 的硬性、
 * conflictsWith 只认候选表。纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentRecordedIn,
  buildExtractPrompt,
  FACT_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  PREFERENCE_SYSTEM_PROMPT,
  formatDate,
  parseExtractReply,
  preferenceCandidates,
} from "./extract.ts";
import type { MemoryEntry } from "../shared/memory.ts";

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    type: "preference",
    text: "用户偏好用中文回复",
    keywords: ["中文"],
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

test("formatDate：本地时区 YYYY-MM-DD", () => {
  assert.equal(formatDate(new Date(2026, 9, 29, 1, 0).getTime()), "2026-10-29");
});

test("buildExtractPrompt：日期锚 + 轮快照 + 偏好候选节", () => {
  const prompt = buildExtractPrompt({
    turns: [{ turn: 2, at: new Date(2026, 9, 29, 12, 0).getTime(), userText: "问", assistantText: "答" }],
    now: new Date(2026, 9, 29, 12, 5).getTime(),
    candidates: [entry({ id: "mem_old" })],
  });
  assert.ok(prompt.includes("<date>2026-10-29</date>"));
  assert.ok(prompt.includes('<turn n="2"'));
  assert.ok(prompt.includes("[mem_old] 用户偏好用中文回复"));
});

test("parseExtractReply：剥围栏、取中括号段、逐条校验", () => {
  const raw = "```json\n[{\"text\":\"事实\",\"keywords\":[\"k\"],\"turns\":[1]}]\n```";
  const drafts = parseExtractReply(raw, "fact");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.text, "事实");
});

test("parseExtractReply：偏好没 reason 丢弃、事实不需要；conflictsWith 只认候选表", () => {
  const raw = JSON.stringify([
    { text: "偏好无理由", keywords: [], turns: [1] },
    { text: "偏好有理由", reason: "因为", keywords: [], turns: [1], conflictsWith: "mem_old" },
    { text: "偏好指向幻觉 id", reason: "r", keywords: [], turns: [1], conflictsWith: "mem_ghost" },
  ]);
  const drafts = parseExtractReply(raw, "preference", new Set(["mem_old"]));
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]?.conflictWith, "mem_old");
  assert.equal(drafts[1]?.conflictWith, undefined); // 幻觉 id 不落
});

test("parseExtractReply：经验没依据丢弃；crossWorkspace 只对偏好生效", () => {
  const raw = JSON.stringify([
    { text: "经验无依据", keywords: [], turns: [1] },
    { text: "经验有依据", reason: "第 2 轮交互", keywords: [], turns: [2] },
    { text: "经验也输出 crossWorkspace", reason: "r", keywords: [], turns: [2], crossWorkspace: true },
  ]);
  const drafts = parseExtractReply(raw, "insight");
  assert.equal(drafts.length, 2);
  assert.equal(drafts.every((draft) => draft.crossWorkspace === undefined), true);

  const prefRaw = JSON.stringify([
    { text: "跨工作区偏好", reason: "r", keywords: [], turns: [1], crossWorkspace: true },
  ]);
  assert.equal(parseExtractReply(prefRaw, "preference")[0]?.crossWorkspace, true);
});

test("parseExtractReply：没有支撑轮号的条不落；超过 5 条截断；坏输出空数组", () => {
  const raw = JSON.stringify([{ text: "没有轮号", keywords: [], turns: [] }]);
  assert.equal(parseExtractReply(raw, "fact").length, 0);
  const many = JSON.stringify(
    Array.from({ length: 7 }, (_, index) => ({ text: `条${index}`, keywords: [], turns: [1] })),
  );
  assert.equal(parseExtractReply(many, "fact").length, 5);
  assert.deepEqual(parseExtractReply("模型拒答了", "fact"), []);
  assert.deepEqual(parseExtractReply("前置说明 [\"hmm\"] 后置", "fact"), []);
});

test("preferenceCandidates：覆盖度打分取最像的几条偏好，非偏好不进候选", () => {
  const pool = [
    entry({ id: "p-hit", text: "用户偏好用中文回复" }),
    entry({ id: "p-miss", text: "用户讨厌合并半成品", keywords: ["合并"] }),
    entry({ id: "f", type: "fact", text: "用户偏好用中文回复这件事的事实" }),
  ];
  const candidates = preferenceCandidates(pool, "这一轮里用户又一次强调偏好用中文回复，还说以后都这样");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "p-hit");
});

test("三类提示词都讲清抽象层次：同一意思不换说法写进别类，经验要比原话高一层", () => {
  for (const prompt of [FACT_SYSTEM_PROMPT, PREFERENCE_SYSTEM_PROMPT, INSIGHT_SYSTEM_PROMPT]) {
    assert.ok(prompt.includes("三个抽象层次"));
    assert.ok(prompt.includes("不要换个说法写进本类"));
  }
  assert.ok(FACT_SYSTEM_PROMPT.includes("属于偏好，这里不记"));
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("跨场景的一般原则属于经验"));
  assert.ok(INSIGHT_SYSTEM_PROMPT.includes("经验必须比原话高一层"));
});

test("buildExtractPrompt：agent 当场写下的条目进 <recorded> 节；三类提示词都讲「不要再写一遍」", () => {
  const prompt = buildExtractPrompt({
    turns: [{ turn: 3, at: 1, userText: "不对，汇报要三条要点", assistantText: "已改" }],
    now: 1,
    recorded: [entry({ id: "mem_a", source: "agent", text: "用户要求汇报写成三条要点" })],
  });
  assert.ok(prompt.includes("<recorded>\n- 用户要求汇报写成三条要点\n</recorded>"));
  // 没有就不出节
  assert.equal(buildExtractPrompt({ turns: [], now: 1, recorded: [] }).includes("<recorded>"), false);
  for (const system of [FACT_SYSTEM_PROMPT, PREFERENCE_SYSTEM_PROMPT, INSIGHT_SYSTEM_PROMPT]) {
    assert.ok(system.includes("<recorded>"));
    assert.ok(system.includes("不要重复，也不要换个说法再写一条"));
  }
});

test("agentRecordedIn：只挑同会话、出处轮落在段内的 agent 条目（被撤销的也算）", () => {
  const pool = [
    entry({ id: "in", source: "agent", sessionId: "s1", turns: [3], episodeId: "" }),
    entry({ id: "muted", source: "agent", sessionId: "s1", turns: [2], episodeId: "", status: "muted" }),
    entry({ id: "out-of-range", source: "agent", sessionId: "s1", turns: [9], episodeId: "" }),
    entry({ id: "other-session", source: "agent", sessionId: "s2", turns: [3], episodeId: "" }),
    entry({ id: "chat", source: "chat", sessionId: "s1", turns: [3] }),
  ];
  assert.deepEqual(
    agentRecordedIn(pool, { sessionId: "s1", fromTurn: 2, toTurn: 4 }).map((item) => item.id),
    ["in", "muted"],
  );
});

test("偏好提示词讲清 conflictsWith / crossWorkspace 会直接生效、拿不准就不加", () => {
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("会被直接标为过时"));
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("会被直接记到所有工作区"));
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("拿不准写 false"));
  // 2026-10-29 实例实测：「一句话说理由」这类一次性的回答要求被记成偏好、又被升到所有工作区
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("只管这一轮，不是偏好"));
  assert.ok(PREFERENCE_SYSTEM_PROMPT.includes("只在用户明说这是长期的个人习惯"));
});
