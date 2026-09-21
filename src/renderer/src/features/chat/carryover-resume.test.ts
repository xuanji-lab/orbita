import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCarryoverFollowUp,
  buildCarryoverSeed,
  canResumeInSource,
} from "./carryover-resume.ts";
// deriveSessionTitle 是运行时导出，而 @shared 别名只在构建期由 electron-vite 解析——
// 测试里对运行时真源走相对路径（type 仍走别名，与 home-cards.test.ts 同款纪律）
import { deriveSessionTitle } from "../../../../shared/session.ts";
import type { Carryover, SessionMeta } from "@shared/session";

/** 一条遗留事项的最小替身（断言只读组装进种子的部分，其余按需覆盖） */
const item = (patch: Partial<Carryover> = {}): Carryover => ({
  id: "c1",
  title: "补上失败的测试",
  detail: "retry 耗尽后 session-guard 那一条没跑过",
  sourceSessionId: "s1",
  sourceMessageRange: null,
  status: "open",
  createdAt: 0,
  doneAt: null,
  ...patch,
});

/** 一份会话 meta 替身：可用性判断只读 id 与 piSessionFile */
const meta = (id: string, piSessionFile: string | null): SessionMeta =>
  ({
    id,
    title: "t",
    titleSource: "derived",
    cwd: "/tmp",
    workspaceId: null,
    providerId: "p",
    modelId: "m",
    mode: "plan",
    thinkingLevel: "medium",
    piSessionFile,
    pinned: false,
    archived: false,
    starred: false,
    completion: "open",
    closedAt: null,
    recentQueries: [],
    stats: null,
    createdAt: 0,
    updatedAt: 0,
  }) as SessionMeta;

describe("buildCarryoverSeed（方案 A：新会话种子）", () => {
  test("带来源标题：首行交代出处，正文是 title + detail + 开工指令", () => {
    const seed = buildCarryoverSeed(item(), "修 retry 链路");
    assert.equal(
      seed,
      "继续处理任务「修 retry 链路」收尾时留下的遗留事项：\n\n" +
        "补上失败的测试\n\n" +
        "当时的上下文摘录：retry 耗尽后 session-guard 那一条没跑过\n\n" +
        "请基于以上上下文接手这件事，继续推进直至完成。",
    );
  });

  test("来源已删（sourceTitle = null）：措辞退到无来源版，title / detail 仍在", () => {
    const seed = buildCarryoverSeed(item(), null);
    assert.ok(seed.startsWith("继续处理一条遗留事项（来源任务已删除）："));
    assert.ok(seed.includes("补上失败的测试"));
    assert.ok(seed.includes("retry 耗尽后 session-guard 那一条没跑过"));
  });

  test("detail 为空：摘录行整段省略，不留下空壳", () => {
    const seed = buildCarryoverSeed(item({ detail: "" }), "来源");
    assert.ok(!seed.includes("摘录"));
    assert.equal(seed, "继续处理任务「来源」收尾时留下的遗留事项：\n\n补上失败的测试\n\n请基于以上上下文接手这件事，继续推进直至完成。");
  });

  test("首行是可读的会话标题（deriveSessionTitle 截断规则内）", () => {
    const longTitle = "一".repeat(80);
    const seed = buildCarryoverSeed(item(), longTitle);
    const derived = deriveSessionTitle(seed);
    // 新会话标题由首句截断推导：首行必须先装得下出处与事项语义
    assert.ok(derived.startsWith("继续处理任务「"));
    assert.ok(derived.length <= 61); // SESSION_TITLE_MAX(60) + 省略号
  });
});

describe("buildCarryoverFollowUp（方案 B：原会话内的用户消息）", () => {
  test("不交代来源标题（原对话在场），点名事项并要求接着做完", () => {
    const text = buildCarryoverFollowUp(item());
    assert.equal(
      text,
      "继续处理这件收尾时留下的遗留事项：\n\n" +
        "补上失败的测试\n\n" +
        "当时的上下文摘录：retry 耗尽后 session-guard 那一条没跑过\n\n" +
        "请接着把它做完。",
    );
  });

  test("detail 为空：同样省略摘录行", () => {
    const text = buildCarryoverFollowUp(item({ detail: "" }));
    assert.ok(!text.includes("摘录"));
  });
});

describe("canResumeInSource（方案 B 可用性）", () => {
  test("来源存在且有 pi 本子 → 可续跑", () => {
    assert.equal(canResumeInSource(item(), [meta("s1", "/x/session.jsonl")]), true);
  });

  test("来源存在但无本子（导入的只读会话）→ 不可", () => {
    assert.equal(canResumeInSource(item(), [meta("s1", null)]), false);
  });

  test("来源已删 → 不可", () => {
    assert.equal(canResumeInSource(item(), [meta("other", "/x.jsonl")]), false);
    assert.equal(canResumeInSource(item(), []), false);
  });
});
