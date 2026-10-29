/**
 * 提取提示词与解析（extract.ts）——三类各自的容错、reason 的硬性、
 * conflictsWith 只认候选表。纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractPrompt,
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
  assert.equal(drafts.every((draft) => draft.pendingPromote === undefined), true);

  const prefRaw = JSON.stringify([
    { text: "跨工作区偏好", reason: "r", keywords: [], turns: [1], crossWorkspace: true },
  ]);
  assert.equal(parseExtractReply(prefRaw, "preference")[0]?.pendingPromote, true);
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
