import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import { delegationSteps, matchStep } from "./delegation-steps.ts";
import { planTimeline } from "./plan-timeline.ts";

type Status = "pending" | "in_progress" | "waiting" | "done";
type Step = [text: string, status: Status, waitingFor?: string];

let seq = 0;
const at = () => 1_000 + seq * 10;

function plan(...steps: Step[]): TranscriptRecord {
  seq += 1;
  const items = steps.map(([text, status, waitingFor]) => ({ text, status, ...(waitingFor === undefined ? {} : { waitingFor }) }));
  return { id: `p${seq}`, role: "tool", toolCallId: `plan-${seq}`, toolName: "update_plan", input: { items }, content: [], timestamp: at(), status: "complete", isError: false } as unknown as TranscriptRecord;
}

function brokenPlan(): TranscriptRecord {
  seq += 1;
  return { id: `e${seq}`, role: "tool", toolCallId: `plan-${seq}`, toolName: "update_plan", input: { items: [] }, content: [], timestamp: at(), status: "error", isError: true } as unknown as TranscriptRecord;
}

const ID = {
  a: "22bcc8ca-0000-4000-8000-000000000001",
  b: "7894c76e-0000-4000-8000-000000000002",
  c: "e5713009-0000-4000-8000-000000000003",
};

function delegate(childId: string, title: string, planStep?: string): TranscriptRecord {
  seq += 1;
  return {
    id: `d${seq}`,
    role: "tool",
    toolCallId: `del-${seq}`,
    toolName: "delegate",
    input: { title, task: "x", ...(planStep === undefined ? {} : { planStep }) },
    details: { delegate: { childId, title, modelId: "m", thinkingLevel: "medium", workbench: "/w" } },
    content: [],
    timestamp: at(),
    status: "complete",
    isError: false,
  } as unknown as TranscriptRecord;
}

function user(): TranscriptRecord {
  seq += 1;
  return { id: `u${seq}`, role: "user", content: [{ type: "text", text: "hi" }], timestamp: at() } as unknown as TranscriptRecord;
}

/** 跑一遍，返回 childId → 挂到的步的文字（没挂上 = null） */
function run(records: TranscriptRecord[]): Record<string, string | null> {
  const timeline = planTimeline(records.filter((record) => record.role === "tool" && record.toolName === "update_plan"));
  const assign = delegationSteps(records, timeline);
  const textOf = (id: string | null) => (id === null ? null : (timeline?.current.items.find((item) => item.id === id)?.text ?? `??${id}`));
  return Object.fromEntries([...assign].map(([child, step]) => [child, textOf(step)]));
}

const A = "写迁移脚本并跑通";
const B = "给列表页补空态与键盘操作";
const C = "更新设计系统文档";

describe("子会话挂到哪一步：显式参数 planStep", () => {
  it("planStep 逐字对上计划里的一步：就挂它，哪怕在做的是另一步", () => {
    const records = [plan([A, "done"], [B, "in_progress"], [C, "pending"]), delegate(ID.a, "文档同步", C)];
    assert.deepEqual(run(records), { [ID.a]: C });
  });

  it("显式参数优先于推断：派出时在做的是 B，planStep 指 C → C", () => {
    const records = [plan([A, "done"], [B, "in_progress"], [C, "waiting", "等子会话"]), delegate(ID.a, "别的名字", C)];
    assert.equal(run(records)[ID.a], C);
  });

  it("显式参数优先于计划里写的子会话 id 前缀", () => {
    const records = [plan([A, "waiting", `子会话 ${ID.a.slice(0, 8)} 在做`], [B, "pending"]), delegate(ID.a, "t", B)];
    assert.equal(run(records)[ID.a], B);
  });

  it("文字写歪一点（标点、空白、说法略有出入）也认得；差太远就不认，退回推断", () => {
    const fuzzy = [plan([A, "pending"], [B, "in_progress"]), delegate(ID.a, "t", "写迁移脚本、并跑通！")];
    assert.equal(run(fuzzy)[ID.a], A);
    const wrong = [plan([A, "pending"], [B, "in_progress"]), delegate(ID.a, "t", "完全无关的一句话")];
    assert.equal(run(wrong)[ID.a], B);
  });

  it("先派后改计划：planStep 是这一步将来的文字，派出时还没有它 → 等下一版计划写出来再对上", () => {
    const records = [plan([A, "in_progress"], [B, "pending"]), delegate(ID.a, "t", C), plan([A, "done"], [B, "in_progress"], [C, "pending"])];
    assert.equal(run(records)[ID.a], C);
  });

  it("planStep 始终对不上任何一版：回到推断；推断也没有就是没挂上", () => {
    const records = [plan([A, "pending"], [B, "pending"]), delegate(ID.a, "t", "根本没有这一步"), user()];
    assert.equal(run(records)[ID.a], null);
  });
});

describe("子会话挂到哪一步：计划文字里的子会话 id", () => {
  it("waitingFor 里写了 id 前 8 位：挂那一步（waiting，不是 in_progress）", () => {
    const records = [plan([A, "done"], [B, "waiting", `子会话 ${ID.a.slice(0, 8)} 在做`], [C, "in_progress"]), delegate(ID.a, "迁移")];
    assert.equal(run(records)[ID.a], B);
  });

  it("步骤文字里写的也算；不足 8 位不算", () => {
    const inText = [plan([`${ID.a.slice(0, 8)} 做迁移`, "waiting"], [B, "in_progress"]), delegate(ID.a, "t")];
    assert.equal(run(inText)[ID.a], `${ID.a.slice(0, 8)} 做迁移`);
    const short = [plan([`${ID.a.slice(0, 7)} 做迁移`, "waiting"], [B, "pending"]), user(), delegate(ID.a, "t"), user()];
    assert.equal(run(short)[ID.a], null);
  });

  it("id 写在下一轮才改的计划里也认（不受「这一轮」限制）", () => {
    const records = [plan([A, "in_progress"], [B, "pending"]), delegate(ID.a, "t"), user(), plan([A, "done"], [B, "waiting", `子会话 ${ID.a.slice(0, 8)} 在做`])];
    assert.equal(run(records)[ID.a], B);
  });

  it("同一版里几步都提到它：取第一个没做完的", () => {
    const records = [
      plan([`${ID.a.slice(0, 8)} 上一项`, "done"], [`${ID.a.slice(0, 8)} 做完上一项后接着做`, "waiting"], [B, "pending"]),
      delegate(ID.a, "t"),
    ];
    assert.equal(run(records)[ID.a], `${ID.a.slice(0, 8)} 做完上一项后接着做`);
  });

  it("点了别的子会话名字的步，不让没点名的子会话顺手拿走", () => {
    const records = [
      plan([A, "pending"], [B, "pending"]),
      delegate(ID.a, "迁移脚本"),
      delegate(ID.b, "查卡顿"),
      plan([A, "waiting", `子会话 ${ID.a.slice(0, 8)} 在做`], [B, "waiting", `子会话 ${ID.b.slice(0, 8)} 在查`]),
      delegate(ID.c, "别的活"),
      user(),
    ];
    assert.deepEqual(run(records), { [ID.a]: A, [ID.b]: B, [ID.c]: null });
  });
});

describe("子会话挂到哪一步：推断兜底", () => {
  it("派出时有 in_progress 的步：挂它", () => {
    const records = [plan([A, "done"], [B, "in_progress"], [C, "pending"]), delegate(ID.a, "补空态")];
    assert.equal(run(records)[ID.a], B);
  });

  it("先派人、后改计划：交出去的步在下一版里新变成 waiting → 挂那一步（不是派出时的上一步）", () => {
    const records = [
      plan([A, "in_progress"], [B, "pending"], [C, "pending"]),
      delegate(ID.a, "补空态与键盘操作"),
      plan([A, "done"], [B, "waiting", "子会话在做"], [C, "in_progress"]),
    ];
    // 候选 = 派出时在做的 A（下一版里仍在）与新变成 waiting 的 B、新变成 in_progress 的 C；标题与 B 最像
    assert.equal(run(records)[ID.a], B);
  });

  it("先派人、后改计划：派出时没有在做的步，下一版新变成 in_progress 的步 → 挂它", () => {
    const records = [plan([A, "done"], [B, "pending"]), delegate(ID.a, "t"), plan([A, "done"], [B, "in_progress"])];
    assert.equal(run(records)[ID.a], B);
  });

  it("写计划之前就派人：第一张计划里新变成在做 / 在等的步 → 挂它", () => {
    const records = [delegate(ID.a, "写迁移脚本"), plan([A, "waiting", "等子会话"], [B, "pending"])];
    assert.equal(run(records)[ID.a], A);
  });

  it("先改计划、后派人（同一轮）：刚标成 waiting 的步 → 挂它", () => {
    const records = [plan([A, "done"], [B, "waiting", "等子会话交回"], [C, "pending"]), delegate(ID.a, "补空态和键盘操作")];
    assert.equal(run(records)[ID.a], B);
  });

  it("派出时在做的步在下一版里被删 / 改得对不上了：不再拿它，改看下一版的新步", () => {
    const records = [
      plan([A, "in_progress"], [B, "pending"]),
      delegate(ID.a, "补空态与键盘操作"),
      plan(["彻底重写的另一说法甲", "done"], [B, "waiting", "子会话在做"]),
    ];
    assert.equal(run(records)[ID.a], B);
  });

  it("两个子会话同一批派出、下一版有两个新 waiting 的步：按标题各挂各的", () => {
    const records = [
      plan([A, "in_progress"], [B, "pending"], [C, "pending"]),
      delegate(ID.a, "补空态与键盘操作"),
      delegate(ID.b, "更新设计系统文档"),
      plan([A, "done"], [B, "waiting", "等子会话"], [C, "waiting", "等子会话"]),
    ];
    assert.deepEqual(run(records), { [ID.a]: B, [ID.b]: C });
  });

  it("标题与候选都不像：两个子会话不挂同一步（先到先得，后到的挂下一个候选）", () => {
    const records = [
      plan([A, "pending"], [B, "pending"]),
      delegate(ID.a, "qqq"),
      delegate(ID.b, "zzz"),
      plan([A, "waiting", "等甲"], [B, "waiting", "等乙"]),
    ];
    const result = run(records);
    assert.notEqual(result[ID.a], result[ID.b]);
    assert.ok(result[ID.a] !== null && result[ID.b] !== null);
  });

  it("下一版计划隔了用户消息才来：不算「紧接着」，不挂", () => {
    const records = [plan([A, "done"], [B, "pending"]), delegate(ID.a, "t"), user(), plan([A, "done"], [B, "in_progress"])];
    assert.equal(run(records)[ID.a], null);
  });

  it("没写过计划 / 只有被拒的 update_plan：全部没挂上", () => {
    assert.deepEqual(run([delegate(ID.a, "t"), user()]), { [ID.a]: null });
    assert.deepEqual(run([brokenPlan(), delegate(ID.a, "t")]), { [ID.a]: null });
  });

  it("被拒的 update_plan 夹在派人与下一版之间：当没发生", () => {
    const records = [plan([A, "done"], [B, "pending"]), delegate(ID.a, "t"), brokenPlan(), plan([A, "done"], [B, "in_progress"])];
    assert.equal(run(records)[ID.a], B);
  });
});

describe("子会话挂到哪一步：计划换了一张", () => {
  const old = () => plan(["读两份交接，核对实例", "done"], ["第一版原型：真 renderer 出样张", "in_progress"], ["复核交付，逐张看截图", "pending"]);

  it("新计划里有文字相同的步：按文字接过去，不作废", () => {
    const records = [
      old(),
      delegate(ID.a, "样张"),
      user(),
      plan(["起体验实例并放样张会话", "pending"], ["第一版原型：真 renderer 出样张", "waiting", "等子会话"], ["写交接", "pending"]),
    ];
    // 新计划与旧计划只有一步文字相同：判为一张新计划（步 id 作废），子会话仍按文字挂到那一步
    assert.equal(run(records)[ID.a], "第一版原型：真 renderer 出样张");
  });

  it("旧步改过说法（同一张计划里 id 不变）后又被新计划顶掉：用它最后的说法对新计划", () => {
    const records = [
      plan(["修滚动位置记忆", "in_progress"], ["补输入框缩略图", "pending"], ["打包", "pending"]),
      delegate(ID.a, "滚动"),
      plan(["修滚动位置记忆（含回到底部）", "waiting", "等子会话"], ["补输入框缩略图", "pending"], ["打包", "pending"]),
      user(),
      plan(["全新的另一件事", "in_progress"], ["修滚动位置记忆（含回到底部）", "pending"], ["别的", "pending"]),
    ];
    assert.equal(run(records)[ID.a], "修滚动位置记忆（含回到底部）");
  });

  it("新计划里一步也对不上：没挂上（归「其他子会话」）", () => {
    const records = [old(), delegate(ID.a, "样张"), user(), plan(["完全不同的甲", "in_progress"], ["完全不同的乙", "pending"], ["完全不同的丙", "pending"])];
    assert.equal(run(records)[ID.a], null);
  });

  it("后一张计划里写了 id 前缀：不管旧计划，直接挂上", () => {
    const records = [old(), delegate(ID.a, "样张"), user(), plan(["新计划甲", "waiting", `子会话 ${ID.a.slice(0, 8)} 在做`], ["新计划乙", "pending"])];
    assert.equal(run(records)[ID.a], "新计划甲");
  });
});

describe("matchStep：planStep 的文字对计划里的哪一步", () => {
  const items = [{ text: "写迁移脚本并跑通" }, { text: "补空态与键盘操作" }];
  it("逐字 > 去标点空白 > 互相包含 > 相似；对不上 null", () => {
    assert.equal(matchStep(items, "补空态与键盘操作"), items[1]);
    assert.equal(matchStep(items, "补空态，与键盘操作。"), items[1]);
    assert.equal(matchStep(items, "写迁移脚本并跑通（含回滚）"), items[0]);
    assert.equal(matchStep(items, "补空态和键盘操作"), items[1]);
    assert.equal(matchStep(items, "与此无关的一句话"), null);
    assert.equal(matchStep(items, "。。"), null);
  });
  it("太短的包含不算（避免「测试」吞掉所有含「测试」的步）", () => {
    assert.equal(matchStep([{ text: "跑全量测试再出体验包" }], "测试"), null);
  });
});
