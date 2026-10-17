/**
 * 意图系统共享纯核的测试：NDJSON 分块、事件校验、卡片归约、静默判定、
 * recent / backfill 推导、注入拼接、转录记录校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRecallEvent,
  composeAttachmentPrompt,
  INTENT_CONTEXT_GUIDELINE,
  composeIntentPrompt,
  INTENT_GATE_OFF,
  createNdjsonAssembler,
  createSilenceTimer,
  initialRecallCard,
  stagesOfCard,
  type RecallStageCell,
  parseIntentRecallEvent,
  pendingBackfillFromRecords,
  recallRunView,
  ingestAnswerText,
  type IntentRecallStreamEvent,
  type SilenceScheduler,
} from "./intent-recall.ts";
import { isIntentRecallRecord, type IntentRecallRecord } from "./session.ts";

function userItem(id: string, text: string, timestamp = 1000): { role: "user"; id: string; content: { type: "text"; text: string }[]; timestamp: number } {
  return { role: "user", id, content: [{ type: "text", text }], timestamp };
}

function assistantItem(id: string, text: string, timestamp = 2000): {
  role: "assistant";
  id: string;
  content: { type: "text"; text: string }[];
  timestamp: number;
  status: "complete";
  stopReason: "stop";
  model: { provider: "p"; id: "m" };
} {
  return {
    role: "assistant",
    id,
    content: [{ type: "text", text }],
    timestamp,
    status: "complete",
    stopReason: "stop",
    model: { provider: "p", id: "m" },
  };
}

test("NDJSON 装配器跨 chunk 边界拼行", () => {
  const lines: string[] = [];
  const feed = createNdjsonAssembler((line) => lines.push(line));
  feed('{"type":"accep');
  feed('ted","runId":"r1"}\n{"type":"intent","sc');
  feed('ene":"s"}\r\n\n{"type":"heartbeat","t":1}\n');
  assert.deepEqual(lines, ['{"type":"accepted","runId":"r1"}', '{"type":"intent","scene":"s"}', '{"type":"heartbeat","t":1}']);
});

test("parseIntentRecallEvent 认合法行、拒畸形行", () => {
  const done = parseIntentRecallEvent(
    '{"type":"done","runId":"r1","injection":"块","needsFeedback":true,"timing":{"totalMs":10,"s1Ms":1,"s3Ms":5,"s4Ms":4}}',
  );
  assert.equal(done?.type, "done");
  assert.equal(done !== null && done.type === "done" ? done.needsFeedback : null, true);
  const error = parseIntentRecallEvent('{"type":"error","stage":"budget","message":"超时","retryable":true,"elapsedMs":9}');
  assert.equal(error?.type, "error");
  const review = parseIntentRecallEvent(
    '{"type":"review","summary":"一句","selected":[{"qaId":"q1","when":"09-25 10:00","title":"t","slots":["岗"],"why":"因为","pending":false}],"ask":[],"retried":false}',
  );
  assert.equal(review?.type, "review");
  if (review?.type === "review") assert.equal(review.selected.length, 1);
  // 拒绝：不是 JSON、缺字段、stage 非法
  assert.equal(parseIntentRecallEvent("not json"), null);
  assert.equal(parseIntentRecallEvent('{"type":"intent"}'), null);
  assert.equal(parseIntentRecallEvent('{"type":"stage","stage":"s9","status":"start","round":1}'), null);
  assert.equal(parseIntentRecallEvent('{"type":"done","runId":"r","injection":"i","timing":{}}'), null);
});

test("卡片归约：进度、判缺重跑、完成带待确认数", () => {
  let card = initialRecallCard("turn-1", 100);
  const apply = (event: IntentRecallStreamEvent): void => {
    card = applyRecallEvent(card, event);
  };
  apply({ type: "accepted", runId: "r1", qaTotal: 100, swarm: { endpoint: "vllm", model: "27b" }, budgetMs: 1500000, peak: true, startedAt: 100 });
  assert.equal(card.accepted?.qaTotal, 100);
  assert.equal(card.accepted?.peak, true);
  apply({ type: "stage", stage: "s1", status: "start", round: 1 });
  assert.equal(card.steps.s1, "running");
  apply({ type: "stage", stage: "s1", status: "done", round: 1, ms: 3000 });
  apply({ type: "intent", scene: "代码问题", want: "" });
  assert.equal(card.scene, "代码问题");
  apply({ type: "stage", stage: "s3", status: "start", round: 1 });
  apply({ type: "progress", stage: "s3", round: 1, step: 1, done: 50, total: 100, passed: 10, etaMs: 60000 });
  assert.equal(card.progress?.done, 50);
  apply({ type: "retry", missing: "缺了 X" });
  assert.equal(card.s3Retried, true);
  // v3.1：retry 只标记，不重置进度（线一不再重跑 S3）
  assert.equal(card.progress?.done, 50);
  apply({ type: "stage", stage: "s3", status: "start", round: 2 });
  apply({ type: "progress", stage: "s3", round: 2, step: 1, done: 100, total: 100, passed: 12, etaMs: null });
  apply({ type: "stage", stage: "s3", status: "done", round: 2, ms: 900000 });
  apply({ type: "stage", stage: "s4", status: "start", round: 1 });
  apply({
    type: "review",
    askRemaining: 0,
    summary: "总结一句",
    selected: [],
    ask: [
      { askId: "a1", qaId: "q1", slot: "岗", statement: "陈述", quote: "摘句", when: "09-25 10:00", title: "t", whyUncertain: "拿不准" },
    ],
    retried: true,
    missing: "",
  });
  apply({ type: "stage", stage: "s4", status: "done", round: 1, ms: 40000 });
  assert.equal(card.s4Missing, "", "无 missing 的 review 不显示");
  apply({ type: "done", runId: "r1", injection: "块", needsFeedback: true, timing: { totalMs: 943000, gateMs: 0, s1Ms: 3000, s3Ms: 900000, s4Ms: 40000 } });
  assert.equal(card.status, "done");
  assert.equal(card.pendingAsks, 1);
  assert.deepEqual(card.steps, { gate: "done", s1: "done", s3: "done", s4: "done" });
  // 终态后迟到事件丢弃
  apply({ type: "error", stage: "s3", message: "迟到", retryable: false, elapsedMs: 0 });
  assert.equal(card.status, "done");
});

test("卡片归约：review 带 missing → s4Missing（v3.1 的「没找到」）", () => {
  let card = initialRecallCard("t", 0);
  card = applyRecallEvent(card, { type: "review", askRemaining: 0, summary: "", selected: [], ask: [], retried: false, missing: "这轮没找到跟「锚定问题」相关的旧对话" });
  assert.equal(card.s4Missing, "这轮没找到跟「锚定问题」相关的旧对话");
  // review 不带 missing（空串）不覆盖已有的？——按事件序最后一个 review 为准
  card = applyRecallEvent(card, { type: "review", askRemaining: 0, summary: "", selected: [], ask: [], retried: false, missing: "" });
  assert.equal(card.s4Missing, "");
});

test("卡片归约：error 终态记录 retryable", () => {
  let card = initialRecallCard("t", 0);
  card = applyRecallEvent(card, { type: "error", stage: "config", message: "配置不可用", retryable: false, elapsedMs: 5 });
  assert.equal(card.status, "error");
  assert.equal(card.error?.stage, "config");
  assert.equal(card.error?.retryable, false);
});

test("静默判定：60 秒无行触发、有行重置、dispose 撤销", () => {
  const fired: number[] = [];
  // 假时钟：schedule 记下回调，测试手动推进
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const scheduler: SilenceScheduler = {
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  const timer = createSilenceTimer(60_000, () => fired.push(now), scheduler);
  const tick = (): void => {
    for (const t of timers) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.callback();
      }
    }
  };
  now = 30_000;
  tick();
  assert.equal(fired.length, 0);
  timer.activity(); // 30s 处收到一行，重置
  now = 80_000;
  tick();
  assert.equal(fired.length, 0); // 30s 起算 60s 是 90s，80s 还没到
  now = 90_001;
  tick();
  assert.equal(fired.length, 1); // 静默满 60s
  timer.dispose();
  now = 200_000;
  tick();
  assert.equal(fired.length, 1); // dispose 后不再触发
});

test("注入拼接：注入块 + 空行 + 原话", () => {
  assert.equal(composeIntentPrompt("<intent>背景</intent>", "帮我看看 X"), "<intent>背景</intent>\n\n帮我看看 X");
});

test("backfill：最后 assistant 之后的 user 原样文本（旧→新）", () => {
  const records = [
    userItem("u1", "第一句"),
    assistantItem("a1", "答一"),
    userItem("u2", "失败的那句"),
    userItem("u3", "又失败一句"),
  ];
  assert.deepEqual(pendingBackfillFromRecords(records), ["失败的那句", "又失败一句"]);
  // 引用块原样保留（pi 本子里其它轮也是组合文本）
  const withQuote = [
    userItem("u1", "问"),
    assistantItem("a1", "答"),
    userItem("u2", '<quoted_context index="1" role="user" turn="1">\nx\n</quoted_context>\n\n重试句'),
  ];
  assert.deepEqual(pendingBackfillFromRecords(withQuote), [
    '<quoted_context index="1" role="user" turn="1">\nx\n</quoted_context>\n\n重试句',
  ]);
  // 空 error assistant（abort 边角）也算「最后 assistant」边界吗：不算完整轮但它是
  // 两本账都落的记录（recorder 落带内容的 error；空 error 两边都不落）——
  // 这里只按「转录里最后一条 assistant 终态」划界，与 pi 侧对齐规则一致
  assert.deepEqual(pendingBackfillFromRecords([]), []);
});

test("ingest 的 a：取最后一条 assistant 的最后一块", () => {
  const records = [
    userItem("u1", "问"),
    assistantItem("a1", "中间步骤"),
    assistantItem("a2", "最终答案段"),
  ];
  assert.equal(ingestAnswerText(records), "最终答案段");
  assert.equal(ingestAnswerText([userItem("u1", "问")]), null);
});

const baseRecord: IntentRecallRecord = {
  role: "intent-recall",
  id: "card-1",
  turnId: "turn-1",
  status: "done",
  runId: "r1",
  timestamp: 100,
  startedAt: 100,
  finishedAt: 200,
  scene: "代码问题",
  qaTotal: 100,
  passed: 12,
  budgetMs: 1500000,
  peak: false,
  timings: { totalMs: 100, gateMs: 5, s1Ms: 10, s3Ms: 80, s4Ms: 10 },
  summary: "一句",
  selected: [],
  ask: [],
  error: null,
  halted: null,
  skipped: null,
  gateWhy: null,
};

test("IntentRecallRecord 逐字段校验，坏行跳过", () => {
  assert.equal(isIntentRecallRecord(baseRecord), true);
  assert.equal(isIntentRecallRecord({ ...baseRecord, status: "running" }), false);
  assert.equal(isIntentRecallRecord({ ...baseRecord, role: "compacted" }), false);
  assert.equal(isIntentRecallRecord({ ...baseRecord, startedAt: "100" }), false);
  assert.equal(isIntentRecallRecord({ ...baseRecord, selected: "not-array" }), false);
  assert.equal(isIntentRecallRecord(null), false);
});

test("空注入：composeIntentPrompt 直通原话（不发 \\n\\n 前缀）", () => {
  assert.equal(composeIntentPrompt("", "帮我看看 X"), "帮我看看 X");
  assert.equal(composeIntentPrompt("<intent>背景</intent>", "帮我看看 X"), "<intent>背景</intent>\n\n帮我看看 X");
});

test("halted 字段校验：结构对才收（error 态的位置行数据）", () => {
  assert.equal(isIntentRecallRecord({ ...baseRecord, halted: { stage: "s3", done: 2152, total: 5380 } }), true);
  assert.equal(isIntentRecallRecord({ ...baseRecord, halted: null, skipped: null, gateWhy: null }), true);
  assert.equal(isIntentRecallRecord({ ...baseRecord, halted: { stage: "s3", done: "2152", total: 5380 } }), false);
  assert.equal(isIntentRecallRecord({ ...baseRecord, halted: "s3" }), false);
});

// ── 契约 v3：gate / want / skipped / force ──

test("v3 解析：gate 事件、stage gate、intent 带 want、done 的 skipped+gateWhy+gateMs", () => {
  const gate = parseIntentRecallEvent('{"type":"gate","needIntent":false,"why":"只是打了个招呼","forced":false}');
  assert.equal(gate?.type, "gate");
  if (gate?.type === "gate") {
    assert.equal(gate.needIntent, false);
    assert.equal(gate.why, "只是打了个招呼");
  }
  const stage = parseIntentRecallEvent('{"type":"stage","stage":"gate","status":"done","round":1,"ms":900}');
  assert.equal(stage?.type, "stage");
  const intent = parseIntentRecallEvent('{"type":"intent","scene":"论文写作","want":"理清第二章论证"}');
  assert.deepEqual(intent, { type: "intent", scene: "论文写作", want: "理清第二章论证" });
  // v2 的 intent（无 want）兼容：want 空串
  assert.deepEqual(parseIntentRecallEvent('{"type":"intent","scene":"s"}'), { type: "intent", scene: "s", want: "" });
  const done = parseIntentRecallEvent(
    '{"type":"done","runId":"r1","injection":"","needsFeedback":false,"skipped":"gate","gateWhy":"只是打了个招呼","timing":{"totalMs":2000,"gateMs":900,"s1Ms":0,"s3Ms":0,"s4Ms":0}}',
  );
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.skipped, "gate");
    assert.equal(done.gateWhy, "只是打了个招呼");
    assert.equal(done.timing.gateMs, 900);
  }
  // v2 的 done（无 gateMs/skipped）兼容：gateMs 补 0、skipped 缺席
  const v2 = parseIntentRecallEvent(
    '{"type":"done","runId":"r","injection":"x","needsFeedback":false,"timing":{"totalMs":1,"s1Ms":1,"s3Ms":1,"s4Ms":1}}',
  );
  if (v2?.type === "done") {
    assert.equal(v2.timing.gateMs, 0);
    assert.equal(v2.skipped, undefined);
  }
  // error 的 stage 认 gate
  assert.equal(parseIntentRecallEvent('{"type":"error","stage":"gate","message":"x","retryable":true,"elapsedMs":1}')?.type, "error");
});

test("v3 归约：gate 跳过 → done.skipped=gate，卡片 skipped/gateWhy 在、后三步保持 idle", () => {
  let card = initialRecallCard("t", 0);
  card = applyRecallEvent(card, { type: "accepted", runId: "r", qaTotal: 5380, swarm: { endpoint: "e", model: "m" }, budgetMs: 1, peak: false, startedAt: 1 });
  card = applyRecallEvent(card, { type: "stage", stage: "gate", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "stage", stage: "gate", status: "done", round: 1, ms: 900 });
  card = applyRecallEvent(card, { type: "gate", needIntent: false, why: "只是打了个招呼", forced: false });
  card = applyRecallEvent(card, { type: "intent", scene: "", want: "" }); // v3 跳过时仍可能发空 intent
  card = applyRecallEvent(card, { type: "done", runId: "r", injection: "", needsFeedback: false, skipped: "gate", gateWhy: "只是打了个招呼", timing: { totalMs: 2, gateMs: 1, s1Ms: 0, s3Ms: 0, s4Ms: 0 } });
  assert.equal(card.status, "done");
  assert.equal(card.skipped, "gate");
  assert.equal(card.gateWhy, "只是打了个招呼");
  assert.deepEqual(card.steps, { gate: "done", s1: "idle", s3: "idle", s4: "idle" });
  // gate 通过 + want 归约
  let card2 = initialRecallCard("t2", 0);
  card2 = applyRecallEvent(card2, { type: "gate", needIntent: true, why: "需要分析", forced: false });
  card2 = applyRecallEvent(card2, { type: "intent", scene: "论文", want: "理清论证" });
  assert.equal(card2.gate?.needIntent, true);
  assert.equal(card2.want, "理清论证");
});

/** v3.2：progress 带 step——两步进度；旧服务端没给 step 按 1。 */
test("progress 的 step：v3.2 带值透传，旧服务端缺省补 1，非法值也补 1", () => {
  const line = (extra: string): string =>
    `{"type":"progress","stage":"s3","round":1,"done":10,"total":40,"passed":3,"etaMs":null${extra}}`;
  const with1 = parseIntentRecallEvent(line("")) as Extract<IntentRecallStreamEvent, { type: "progress" }>;
  const with2 = parseIntentRecallEvent(line(`,"step":2`)) as Extract<IntentRecallStreamEvent, { type: "progress" }>;
  const bad = parseIntentRecallEvent(line(`,"step":7`)) as Extract<IntentRecallStreamEvent, { type: "progress" }>;
  assert.equal(with1.step, 1, "旧服务端没给 step：按打分步处理");
  assert.equal(with2.step, 2);
  assert.equal(bad.step, 1, "非法 step 不猜，按 1");
  // 卡片归约带 step；换步时 done/total 用各自事件的值（分母不沿用 accepted.qaTotal）
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, { type: "accepted", runId: "r", qaTotal: 4170, swarm: { endpoint: "e", model: "m" }, budgetMs: 1, peak: false, startedAt: 1 });
  card = applyRecallEvent(card, with1);
  assert.equal(card.progress?.step, 1);
  assert.equal(card.progress?.total, 40);
  card = applyRecallEvent(card, with2);
  assert.equal(card.progress?.step, 2);
  assert.equal(card.progress?.total, 40, "分母用事件自己的 total");
});

/** v3.2（块 4）：review 的守门员摘句与待问剩余——新字段透传，旧形状缺省兜底。 */
test("review v3.2：selected 带 human/score/connection 等，askRemaining 缺省 0；旧形状照常解析", () => {
  const modern = parseIntentRecallEvent(
    '{"type":"review","summary":"一句","askRemaining":7,"retried":false,"missing":"","selected":[{"qaId":"q1","when":"09-01 12:00","title":"会话","slots":["同一件事"],"why":"给事实","pending":false,"score":0.9,"human":"我原话的逐字摘句","assistant":"","connection":"都在处理同一件事","prediction":"回答会引用它","dupCount":3}],"ask":[]}',
  ) as Extract<IntentRecallStreamEvent, { type: "review" }>;
  assert.equal(modern.askRemaining, 7);
  const item = modern.selected[0]!;
  assert.equal(item.human, "我原话的逐字摘句");
  assert.equal(item.score, 0.9);
  assert.equal(item.connection, "都在处理同一件事");
  assert.equal(item.dupCount, 3);
  const legacy = parseIntentRecallEvent(
    '{"type":"review","summary":"一句","retried":false,"selected":[{"qaId":"q1","when":"09-01 12:00","title":"会话","slots":["同一件事"],"why":"给事实","pending":false}],"ask":[]}',
  ) as Extract<IntentRecallStreamEvent, { type: "review" }>;
  assert.equal(legacy.askRemaining, 0, "旧服务端没给 askRemaining——补 0");
  assert.equal(legacy.selected[0]?.human, undefined, "旧形状没有 human——显示侧退回 why");
  // 卡片归约进 review（含 askRemaining）
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, modern);
  assert.equal(card.review?.askRemaining, 7);
});

/** v3.2（块 4 §四/§五）：done.context 解析与附件前置段。 */
test("done 带 context：字段全才收，坏形状忽略；附件前置段 = 固定说明 + notice", () => {
  const mk = (context: string): string =>
    `{"type":"done","runId":"r","injection":"<intent>背景</intent>","needsFeedback":false,"timing":{"totalMs":1,"s1Ms":1,"s3Ms":1,"s4Ms":1}${context}}`;
  const withContext = parseIntentRecallEvent(
    mk(`,"context":{"question":2,"md":"# 全文","jsonl":"{}\\n","added":3,"notice":"第 2 问新增 3 条"}`),
  ) as Extract<IntentRecallStreamEvent, { type: "done" }>;
  assert.equal(withContext.context?.question, 2);
  assert.equal(withContext.context?.notice, "第 2 问新增 3 条");
  const broken = parseIntentRecallEvent(mk(`,"context":{"question":"二"}`)) as Extract<IntentRecallStreamEvent, { type: "done" }>;
  assert.equal(broken.context, undefined, "坏形状的 context 整体忽略——退回简版文件");
  const legacy = parseIntentRecallEvent(mk("")) as Extract<IntentRecallStreamEvent, { type: "done" }>;
  assert.equal(legacy.context, undefined, "旧服务端没有 context");
  // §五：附件前置段（发给模型的这一轮 = composeIntentPrompt(它, 原话)）。
  // 2026-10-09 改硬：有新增条目 = 先读指定行再搜（行号从 notice 解析）；没有 = 明说不用读
  const head = composeAttachmentPrompt(
    "/wb/意图系统/上下文.md",
    "上下文文件更新了：第 2 问新增 3 条（岗 1 两条），理由写在文件里（在上下文.md 第 12–34 行）。",
    3,
  );
  assert.ok(head.includes("取回了 3 条相关内容"), "报条数");
  assert.ok(head.includes("第 12–34 行"), "行号从 notice 里解析出来");
  assert.ok(head.includes("路径：/wb/意图系统/上下文.md"));
  assert.ok(head.includes("先用 read 工具读这一段"), "硬要求：先读");
  assert.ok(head.endsWith("（在上下文.md 第 12–34 行）。"), "notice 原文附在后面");
  assert.equal(
    composeIntentPrompt(head, "用户原话"),
    `${head}\n\n用户原话`,
    "附件方式的完整 prompt = 说明 + notice + 空行 + 原话（原话位置不变）",
  );
  // 解析不到行号（旧 notice / 解析不到）→ 退回整文件，不写行号
  const noLines = composeAttachmentPrompt("/p/上下文.md", "上下文文件更新了：第 2 问新增 2 条。", 2);
  assert.ok(noLines.includes("取回了 2 条") && !noLines.includes("行）"), "没有行号就退回整文件");
  // 没有新增条目：明说不用读
  const none = composeAttachmentPrompt("/p/上下文.md", "上下文文件更新了：第 2 问没有取回相关条目（在上下文.md 第 5–6 行）。", 0);
  assert.ok(none.includes("没有取回相关条目") && none.includes("不用读"), "无新增时明说不用读");
  assert.ok(!none.includes("取回了"), "不报条数");
  assert.equal(composeIntentPrompt(composeAttachmentPrompt("/p", "", 0), "原话").split("\n").length, 3, "notice 空时不加空行");
});

/** 2026-10-09：意图上下文附件的系统提示词段（与 QUOTE_GUIDELINE 同款注入）。 */
test("INTENT_CONTEXT_GUIDELINE：讲清文件是什么、先读再搜、不是用户这轮的话", () => {
  assert.ok(INTENT_CONTEXT_GUIDELINE.startsWith("<orbita-intent-context>"));
  assert.ok(INTENT_CONTEXT_GUIDELINE.includes("意图系统/上下文.md"));
  assert.ok(INTENT_CONTEXT_GUIDELINE.includes("FIRST"), "先读对应行再自己搜");
  assert.ok(INTENT_CONTEXT_GUIDELINE.includes("never quote it as the user's current words"), "不当成本轮的话");
});

/** v3.3（任务 8）：11 格阶段条——事件序列 → 每格状态与数字；error 停格。 */
test("阶段条 11 格：逐步事件推进逐格点亮，数字跟着走（新服务端全字段）", () => {
  let card = initialRecallCard("t1", 1);
  const cells = (): Record<string, RecallStageCell> => {
    const map: Record<string, RecallStageCell> = {};
    for (const cell of stagesOfCard(card, null)) map[cell.key] = cell;
    return map;
  };
  // 开局：全灰（门卫未判）
  let c = cells();
  assert.equal(c["gate"]!.status, "pending");
  assert.equal(c["score"]!.status, "pending");
  assert.equal(c["edges"]!.status, "pending");
  // 门卫过 + 理解问题
  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "done", round: 1, ms: 1200 });
  c = cells();
  assert.equal(c["gate"]!.status, "done");
  assert.equal(c["understand"]!.status, "done");
  assert.equal(c["understand"]!.ms, 1200);
  // 打分进行中：score running 带数字、passline running 带 K、reasons 灰
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 500, total: 4171, passed: 40, etaMs: 1 });
  c = cells();
  assert.equal(c["score"]!.status, "running");
  assert.deepEqual(c["score"]!.numbers, { done: 500, total: 4171 });
  assert.equal(c["passline"]!.status, "running");
  assert.deepEqual(c["passline"]!.numbers, { passed: 40 });
  assert.equal(c["reasons"]!.status, "pending");
  // 打分收尾、写理由进行中：score 冻结终值、passline 冻结、reasons running
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 4171, total: 4171, passed: 62, etaMs: null });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 2, done: 30, total: 62, passed: 30, etaMs: 1 });
  c = cells();
  assert.equal(c["score"]!.status, "done");
  assert.deepEqual(c["score"]!.numbers, { done: 4171, total: 4171 });
  assert.equal(c["passline"]!.status, "done");
  assert.deepEqual(c["passline"]!.numbers, { passed: 62 });
  assert.equal(c["reasons"]!.status, "running");
  assert.deepEqual(c["reasons"]!.numbers, { done: 30, total: 62 });
  // S3 完 + review（带去重）：dedup 出数字（合并 3 条）、keeper 选条数、确认 2 条 running
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 2, done: 62, total: 62, passed: 62, etaMs: null });
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "done", round: 1, ms: 900000 });
  card = applyRecallEvent(card, { type: "stage", stage: "s4", status: "start", round: 1 });
  card = applyRecallEvent(card, {
    type: "review",
    askRemaining: 3,
    dedup: { before: 10, after: 7 },
    summary: "s",
    selected: [{ qaId: "q1", when: "w", title: "T", slots: ["同一件事"], why: "y", pending: false }],
    ask: [
      { askId: "a1", qaId: "q1", slot: "岗 2", statement: "s", quote: "q", when: "w", title: "T", whyUncertain: "u" },
      { askId: "a2", qaId: "q2", slot: "岗 4", statement: "s2", quote: "q", when: "w", title: "T", whyUncertain: "u" },
    ],
    retried: false,
    missing: "",
  });
  card = applyRecallEvent(card, { type: "stage", stage: "s4", status: "done", round: 1, ms: 8000 });
  c = cells();
  assert.equal(c["reasons"]!.status, "done");
  assert.deepEqual(c["reasons"]!.numbers, { done: 62, total: 62 });
  assert.equal(c["dedup"]!.status, "done");
  assert.deepEqual(c["dedup"]!.numbers, { after: 7, merged: 3 });
  assert.equal(c["keeper"]!.status, "done");
  assert.deepEqual(c["keeper"]!.numbers, { selected: 1 });
  assert.equal(c["keeper"]!.ms, 8000);
  assert.equal(c["confirm"]!.status, "running", "等用户表态时确认格进行中");
  assert.deepEqual(c["confirm"]!.numbers, { asked: 2 });
  assert.equal(c["context"]!.status, "pending");
  // done（带 context.added 与 edgesWritten）：9/10/11 全亮，确认格收工
  card = applyRecallEvent(card, {
    type: "done",
    runId: "r",
    injection: "<intent>x</intent>",
    needsFeedback: true,
    edgesWritten: 18,
    context: { question: 2, md: "#", jsonl: "", added: 3, notice: "n" },
    timing: { totalMs: 910000, gateMs: 700, s1Ms: 1200, s3Ms: 900000, s4Ms: 8000 },
  });
  c = cells();
  assert.equal(c["confirm"]!.status, "done");
  assert.deepEqual(c["confirm"]!.numbers, { asked: 2 });
  assert.equal(c["context"]!.status, "done");
  assert.deepEqual(c["context"]!.numbers, { added: 3 });
  assert.equal(c["answer"]!.status, "done");
  assert.equal(c["edges"]!.status, "done");
  assert.deepEqual(c["edges"]!.numbers, { edges: 18 });
  assert.equal(c["gate"]!.ms, 700, "门卫格用时来自 done.timing.gateMs");
});

test("阶段条：error 停在写理由步（s3 + step 2 已到）标红该格，其后保持灰；老服务端字段缺省", () => {
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "done", round: 1, ms: 1000 });
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 100, total: 100, passed: 5, etaMs: null });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 2, done: 3, total: 5, passed: 3, etaMs: null });
  card = applyRecallEvent(card, { type: "error", stage: "s3", message: "x", retryable: true, elapsedMs: 1 });
  const cells = stagesOfCard(card, "s3");
  const by = (key: string): RecallStageCell => cells.find((cell) => cell.key === key)!;
  assert.equal(by("score").status, "done", "打分步已完成——不标红");
  assert.equal(by("passline").status, "done");
  assert.equal(by("reasons").status, "error", "停在写理由步——该格红");
  assert.equal(by("dedup").status, "pending", "其后保持灰");
  assert.equal(by("answer").status, "pending");
  // 老服务端：无 step（全按 step 1）、无 dedup / edgesWritten / context
  let old = initialRecallCard("t2", 1);
  old = applyRecallEvent(old, { type: "gate", needIntent: true, why: "需要", forced: false });
  old = applyRecallEvent(old, { type: "stage", stage: "s3", status: "start", round: 1 });
  old = applyRecallEvent(old, { type: "progress", stage: "s3", round: 1, step: 1, done: 7, total: 9, passed: 2, etaMs: null });
  old = applyRecallEvent(old, {
    type: "review",
    askRemaining: 0,
    summary: "",
    selected: [],
    ask: [],
    retried: false,
    missing: "",
  });
  old = applyRecallEvent(old, { type: "done", runId: "r", injection: "i", needsFeedback: false, timing: { totalMs: 1, gateMs: 1, s1Ms: 1, s3Ms: 1, s4Ms: 1 } });
  const cellsOld = stagesOfCard(old, null);
  const byOld = (key: string): RecallStageCell => cellsOld.find((cell) => cell.key === key)!;
  assert.equal(byOld("score").status, "done");
  assert.deepEqual(byOld("score").numbers, { done: 7, total: 9 }, "无 step 的老服务端：数字落在打分格");
  assert.equal(byOld("reasons").numbers, null, "写理由格无数字（缺省不显示）");
  assert.equal(byOld("dedup").numbers, null);
  assert.equal(byOld("edges").numbers, null, "回写格无数字——格子照常点亮");
  assert.equal(byOld("edges").status, "done");
  assert.deepEqual(byOld("confirm").numbers, { askNone: true }, "无 ask 显示不用问");
});

/** v3.4（任务 9）：S4 progress——守门员格「已写 N 条 · M 字」，不碰 S3 两步账。 */
test("s4 progress：解析接受 stage s4（无 step），keeper 格显示写字数；s3 两步不受影响", () => {
  const line = (done: number, total: number, passed: number): string =>
    `{"type":"progress","stage":"s4","round":1,"done":${done},"total":${total},"passed":${passed},"etaMs":null}`;
  const ev = parseIntentRecallEvent(line(3, 90, 1450)) as Extract<IntentRecallStreamEvent, { type: "progress" }>;
  assert.equal(ev.stage, "s4", "解析接受 stage s4");
  assert.equal(ev.step, 1, "无 step 补 1（s4 不消费）");
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 4171, total: 4171, passed: 62, etaMs: null });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 2, done: 62, total: 62, passed: 62, etaMs: null });
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "done", round: 1, ms: 100 });
  card = applyRecallEvent(card, { type: "stage", stage: "s4", status: "start", round: 1 });
  // 思考阶段：done=0、字数照涨
  card = applyRecallEvent(card, { type: "progress", stage: "s4", round: 1, step: 1, done: 0, total: 90, passed: 620, etaMs: null });
  let cells = stagesOfCard(card, null);
  let keeper = cells.find((cell) => cell.key === "keeper")!;
  assert.equal(keeper.status, "running");
  assert.deepEqual(keeper.numbers, { s4done: 0, s4chars: 620 }, "思考阶段：0 条 · 620 字");
  const score = cells.find((cell) => cell.key === "score")!;
  assert.deepEqual(score.numbers, { done: 4171, total: 4171 }, "s3 两步账不被 s4 事件污染（score 仍是 step1 终值）");
  // 正文阶段：条数与字数一起涨
  card = applyRecallEvent(card, { type: "progress", stage: "s4", round: 1, step: 1, done: 3, total: 90, passed: 1450, etaMs: null });
  cells = stagesOfCard(card, null);
  keeper = cells.find((cell) => cell.key === "keeper")!;
  assert.deepEqual(keeper.numbers, { s4done: 3, s4chars: 1450 }, "已写 3 条 · 1,450 字");
  // s4 完成 + review：格子回到「选 N 条」
  card = applyRecallEvent(card, {
    type: "review",
    askRemaining: 0,
    summary: "",
    selected: [{ qaId: "q1", when: "w", title: "T", slots: ["同一件事"], why: "y", pending: false }],
    ask: [],
    retried: false,
    missing: "",
  });
  card = applyRecallEvent(card, { type: "stage", stage: "s4", status: "done", round: 1, ms: 420000 });
  cells = stagesOfCard(card, null);
  keeper = cells.find((cell) => cell.key === "keeper")!;
  assert.equal(keeper.status, "done");
  assert.deepEqual(keeper.numbers, { selected: 1 }, "完成后照旧「选 N 条」");
  assert.equal(keeper.ms, 420000);
});

/* ---------- 运行卡（四胶囊版）的相位派生：recallRunView ---------- */
test("运行卡相位：开局门卫 → 理解 → 打分 → 写理由 → 摘句，环刻度跟着走", () => {
  let card = initialRecallCard("t1", 1);
  let view = recallRunView(card);
  assert.equal(view.current, "gate");
  assert.equal(view.pills.understand, "pending");
  assert.equal(view.fraction, 0.04);
  assert.deepEqual(view.detail, { kind: "gate" });

  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "start", round: 1 });
  view = recallRunView(card);
  assert.equal(view.current, "understand");
  assert.equal(view.pills.understand, "running");
  assert.equal(view.fraction, 0.12);

  card = applyRecallEvent(card, { type: "stage", stage: "s1", status: "done", round: 1, ms: 900 });
  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 1000, total: 4000, passed: 12, etaMs: null });
  view = recallRunView(card);
  assert.equal(view.current, "score");
  assert.equal(view.pills.understand, "done");
  assert.equal(view.pills.score, "running");
  assert.equal(view.pills.reasons, "pending");
  assert.equal(view.fraction, 0.16 + 0.48 * 0.25);
  assert.deepEqual(view.detail, { kind: "score", done: 1000, total: 4000, passed: 12 });

  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 1, done: 4000, total: 4000, passed: 62, etaMs: null });
  card = applyRecallEvent(card, { type: "progress", stage: "s3", round: 1, step: 2, done: 30, total: 62, passed: 30, etaMs: null });
  view = recallRunView(card);
  assert.equal(view.current, "reasons");
  assert.equal(view.pills.score, "done");
  assert.equal(view.pills.reasons, "running");
  assert.equal(view.fraction, 0.64 + 0.16 * (30 / 62));
  assert.deepEqual(view.detail, { kind: "reasons", done: 30, total: 62 });

  card = applyRecallEvent(card, { type: "stage", stage: "s3", status: "done", round: 1, ms: 30000 });
  card = applyRecallEvent(card, { type: "stage", stage: "s4", status: "start", round: 1 });
  card = applyRecallEvent(card, { type: "progress", stage: "s4", round: 1, step: 1, done: 3, total: 90, passed: 1450, etaMs: null });
  view = recallRunView(card);
  assert.equal(view.current, "keeper");
  assert.equal(view.pills.confirm, "pending");
  assert.deepEqual(view.detail, { kind: "keeper", done: 3, chars: 1450 });
});

test("运行卡相位：等确认——环停 86%，确认胶囊在转，细节报条数", () => {
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, {
    type: "review",
    askRemaining: 0,
    summary: "",
    selected: [],
    ask: [
      { askId: "a1", qaId: "q1", slot: "同一目的", statement: "s", quote: "", when: "w", title: "t", whyUncertain: "u" },
      { askId: "a2", qaId: "q2", slot: "同一目的", statement: "s", quote: "", when: "w", title: "t", whyUncertain: "u" },
    ],
    retried: false,
    missing: "",
  });
  card = applyRecallEvent(card, {
    type: "done",
    runId: "r1",
    injection: "",
    needsFeedback: true,
    timing: { totalMs: 58000, gateMs: 100, s1Ms: 900, s3Ms: 30000, s4Ms: 20000 },
  });
  const view = recallRunView(card);
  assert.equal(view.awaitingConfirm, true);
  assert.equal(view.current, null);
  assert.equal(view.fraction, 0.86);
  assert.equal(view.pills.confirm, "running");
  assert.deepEqual(view.detail, { kind: "confirm", asked: 2 });
});

test("运行卡相位：不用问的轮——确认胶囊直接勾，细节是收尾间隙", () => {
  let card = initialRecallCard("t1", 1);
  card = applyRecallEvent(card, { type: "gate", needIntent: true, why: "需要", forced: false });
  card = applyRecallEvent(card, { type: "review", askRemaining: 0, summary: "", selected: [], ask: [], retried: false, missing: "" });
  let view = recallRunView(card);
  assert.equal(view.pills.confirm, "done");
  card = applyRecallEvent(card, {
    type: "done",
    runId: "r1",
    injection: "块",
    needsFeedback: false,
    timing: { totalMs: 10000, gateMs: 100, s1Ms: 900, s3Ms: 5000, s4Ms: 3000 },
  });
  view = recallRunView(card);
  assert.equal(view.awaitingConfirm, false);
  assert.equal(view.pills.confirm, "done");
});

test("INTENT_GATE_OFF：开关关闭是空注入、照常用原话回答，不是「本轮不回答」的 null", () => {
  assert.equal(INTENT_GATE_OFF.injection, "");
  assert.equal(composeIntentPrompt(INTENT_GATE_OFF.injection, "回复 ok"), "回复 ok");
});
