import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPlanGate,
  createPlanTools,
  decidePlanStop,
  planReceipt,
  previousPlanFrom,
  type PlanStopState,
  type PlanToolOptions,
} from "./plan-tools.ts";
import { decidePermission, type PermissionMode } from "../shared/permission.ts";
import { diffPlans } from "../shared/plan-diff.ts";
import { parsePlanCall, type PlanItem } from "../shared/plan.ts";

const items = (...pairs: [string, PlanItem["status"]][]): PlanItem[] => pairs.map(([text, status]) => ({ text, status }));
/** pi 本子里一条带 update_plan 调用的 assistant 消息 */
const planEntry = (id: string, list: PlanItem[]) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id, name: "update_plan", arguments: { items: list } }] },
});

function setup(over: Partial<Omit<PlanToolOptions, "branch">> & { branch?: unknown[] } = {}) {
  const state: PlanStopState = { stopping: false };
  const branch = over.branch ?? [];
  const options: PlanToolOptions = {
    getMode: over.getMode ?? (() => "skip" as PermissionMode),
    planFirst: over.planFirst ?? false,
    branch: () => branch,
    state,
  };
  const [tool] = createPlanTools(options);
  assert.ok(tool !== undefined);
  const run = (id: string, params: unknown) => tool.execute(id, params as never, undefined, undefined, undefined as never);
  return { options, state, tool, run, gate: createPlanGate(options), branch };
}

describe("update_plan", () => {
  test("回执：几步做完 + 当前在做", () => {
    assert.equal(
      planReceipt([{ text: "a", status: "done" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]),
      "Plan updated: 1/3 done. Now: b",
    );
    assert.equal(planReceipt([{ text: "a", status: "done" }]), "Plan updated: 1/1 done. All steps done.");
  });

  test("回执：waiting 的步列在后面带上等什么，不算完成；没有在做的也不说「All steps done」", () => {
    assert.equal(
      planReceipt([
        { text: "a", status: "done" },
        { text: "b", status: "waiting", waitingFor: "等你改权限" },
        { text: "c", status: "in_progress" },
      ]),
      "Plan updated: 1/3 done. Now: c Waiting: b (等你改权限).",
    );
    assert.equal(
      planReceipt([{ text: "a", status: "done" }, { text: "b", status: "waiting" }]),
      "Plan updated: 1/2 done. Waiting: b.",
    );
  });

  test("执行：回执给模型，整张计划进 details；坏入参照样拒（校验在 shared/plan.ts）", async () => {
    const { run } = setup();
    const out = await run("c1", { items: [{ text: "a", status: "in_progress" }] });
    assert.deepEqual((out as { details: unknown }).details, { plan: [{ text: "a", status: "in_progress" }] });
    assert.equal((out as { terminate?: boolean }).terminate, undefined);
    await assert.rejects(() => run("c2", { items: [] }), /requires "items"/);
  });

  test("三档权限一律放行（plan 档也能写计划）", () => {
    for (const mode of ["plan", "manual", "skip"] as const) {
      assert.deepEqual(decidePermission(mode, "update_plan"), { behavior: "allow" });
    }
  });

  test("规则：in_progress 是此刻真在做的那一步，卡住的标 waiting（取代「前一步没完不能开后一步」）", () => {
    const { tool } = setup();
    const description = tool.description;
    assert.match(description, /in_progress is the step you are actually working on right now/);
    assert.match(description, /at most one step is in_progress at a time/);
    assert.match(description, /`waiting`, not in_progress/);
    assert.match(description, /`waitingFor`/);
    assert.match(description, /do not save the ticks for the end/);
    assert.doesNotMatch(description, /Do not start a later step while an earlier one/);
    assert.doesNotMatch(description, /Exactly one step is in_progress/);
  });

  test("用户要求先做某一步：提到未完成步骤最前、标 in_progress、写 why，原来那步回 pending 或 waiting（promptGuidelines）", () => {
    const { tool } = setup();
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    assert.match(guidelines, /asks you to do some step first/);
    assert.match(guidelines, /move that step to the front of the unfinished steps, mark it in_progress/);
    assert.match(guidelines, /the user asked to do this first/);
    assert.match(guidelines, /goes back to pending .* or to waiting with `waitingFor`/);
    assert.match(guidelines, /never keep a stuck step in_progress/);
    // 主会话 PR #446 的第三条（计划外新活先进计划）没被冲掉
    assert.match(guidelines, /user's new message asks for something the current plan does not cover/);
  });

  test("schema：status 枚举含 waiting，items 里有可选的 waitingFor", () => {
    const { tool } = setup();
    const itemSchema = (tool.parameters as unknown as { properties: { items: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } })
      .properties.items.items;
    assert.deepEqual(itemSchema.properties["status"]?.enum, ["pending", "in_progress", "waiting", "done"]);
    assert.ok("waitingFor" in itemSchema.properties);
    assert.deepEqual(itemSchema.required, ["text", "status"]);
  });

  test("跳步：先做第 3 步 + 第 2 步 waiting 的调用能过校验，details 带 waitingFor；挪了顺序没写 why 会被提醒、写了不提醒", async () => {
    const two = items(["装好", "in_progress"], ["立场表", "pending"], ["检验", "pending"]);
    const jumped = {
      items: [
        { text: "立场表", status: "in_progress" },
        { text: "装好", status: "waiting", waitingFor: "等你改权限" },
        { text: "检验", status: "pending" },
      ],
    };
    const { run } = setup({ branch: [planEntry("p1", two), planEntry("p2", parsePlanCall(jumped).items)] });
    const out = await run("p2", jumped);
    const text = (out as { content: { text: string }[] }).content[0]?.text ?? "";
    assert.match(text, /Now: 立场表 Waiting: 装好 \(等你改权限\)/);
    assert.match(text, /pass `why`/);
    assert.deepEqual((out as { details: { plan: PlanItem[] } }).details.plan[1], { text: "装好", status: "waiting", waitingFor: "等你改权限" });
    const withWhy = await run("p2", { ...jumped, why: "user asked to do this first" });
    assert.doesNotMatch((withWhy as { content: { text: string }[] }).content[0]?.text ?? "", /pass `why`/);
  });

  test("只是把卡住的步标 waiting（顺序不变）：不算结构改动，不提醒 why、plan 档也不因此停下", async () => {
    const before = items(["装好", "in_progress"], ["立场表", "pending"]);
    const call = { items: [{ text: "装好", status: "waiting", waitingFor: "等你" }, { text: "立场表", status: "in_progress" }] };
    const { run } = setup({ branch: [planEntry("p1", before), planEntry("p2", parsePlanCall(call).items)], getMode: () => "plan" });
    const out = await run("p2", call);
    assert.doesNotMatch((out as { content: { text: string }[] }).content[0]?.text ?? "", /pass `why`/);
    assert.equal((out as { details: { awaiting?: boolean } }).details.awaiting, undefined);
  });

  test("schema v4：why / later / confirm 都是可选字段，说明里讲了怎么用", () => {
    const { tool } = setup();
    const schema = tool.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(schema.properties), ["items", "why", "later", "confirm"]);
    assert.deepEqual(schema.required, ["items"]);
    for (const word of ["`why`", "`later`", "`confirm`", "same batch as the next step's first tool call"]) {
      assert.ok(tool.description.includes(word), word);
    }
  });

  test("用户中途提计划外的新活：先进计划（自成步骤 + why）再开干，并行的旧活在步骤里写明", () => {
    const { tool } = setup();
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    assert.match(guidelines, /user's new message asks for something the current plan does not cover/);
    assert.match(guidelines, /update the plan before you start on it/);
    assert.match(guidelines, /keeps running alongside/);
  });

  test("计划外的活要先加步骤、顺手看到的写 later：规则在 promptGuidelines（随工具启用、整会话不变），不只在说明里", () => {
    const { tool } = setup();
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    assert.match(guidelines, /BEFORE you do it/);
    assert.match(guidelines, /`later`/);
    assert.ok(tool.promptSnippet !== undefined && tool.promptSnippet !== "");
  });

  test("结构改了没写 why：回执里提醒，不拒；写了就不提醒；第一张不提醒；later 回执记一笔", async () => {
    const before = [planEntry("p1", items(["看代码", "in_progress"], ["补测试", "pending"])), planEntry("p2", items(["看代码", "in_progress"], ["补测试", "pending"]))];
    const added = { items: [{ text: "看代码", status: "done" }, { text: "修时区", status: "in_progress" }, { text: "补测试", status: "pending" }] };
    const { run } = setup({ branch: before });
    const noWhy = await run("p2", added);
    assert.match((noWhy as { content: { text: string }[] }).content[0]?.text ?? "", /pass `why`/);
    const withWhy = await run("p2", { ...added, why: "测试发现差一天", later: ["日期解析不一致"] });
    const text = (withWhy as { content: { text: string }[] }).content[0]?.text ?? "";
    assert.doesNotMatch(text, /pass `why`/);
    assert.match(text, /Noted 1 for later/);
    const first = await setup().run("p1", { items: [{ text: "a", status: "in_progress" }] });
    assert.doesNotMatch((first as { content: { text: string }[] }).content[0]?.text ?? "", /pass `why`/);
  });
});

describe("previousPlanFrom：本子里上一张计划", () => {
  test("倒着找最近一次，排除正在处理的这次调用；坏条目跳过；没有 = null", () => {
    const branch = [planEntry("p1", items(["旧", "done"])), planEntry("p2", items(["新", "in_progress"]))];
    assert.deepEqual(previousPlanFrom(branch, "p3"), items(["新", "in_progress"]));
    assert.deepEqual(previousPlanFrom(branch, "p2"), items(["旧", "done"]));
    assert.equal(previousPlanFrom([], "p1"), null);
    assert.equal(previousPlanFrom([planEntry("p1", [{ text: "", status: "done" }])], "p9"), null);
    assert.equal(previousPlanFrom([{ type: "custom" }, null], "p9"), null);
  });
});

describe("decidePlanStop：什么时候停下来等用户", () => {
  const decide = (mode: PermissionMode, planFirst: boolean, prev: PlanItem[] | null, next: unknown) => {
    const call = parsePlanCall(next);
    return decidePlanStop({ mode, planFirst, call, diff: diffPlans(prev, call.items), hadPlan: prev !== null });
  };
  const two = items(["看代码", "in_progress"], ["补测试", "pending"]);

  test("带 confirm：任何档位都停", () => {
    for (const mode of ["plan", "manual", "skip"] as const) {
      assert.equal(decide(mode, false, null, { items: two, confirm: ["要兼容旧格式吗？"] }), "confirm");
    }
  });

  test("plan 档：新计划停；结构改了停；只打勾不停；全勾完不停", () => {
    assert.equal(decide("plan", false, null, { items: two }), "plan-mode");
    assert.equal(decide("plan", false, two, { items: [...two, { text: "写 README", status: "pending" }] }), "plan-mode");
    assert.equal(decide("plan", false, two, { items: items(["看代码", "done"], ["补测试", "in_progress"]) }), null);
    assert.equal(decide("plan", false, two, { items: items(["看代码", "done"], ["补测试", "done"]) }), null);
  });

  test("manual / skip 默认不停", () => {
    assert.equal(decide("manual", false, null, { items: two }), null);
    assert.equal(decide("skip", false, null, { items: two }), null);
  });

  test("先给我看计划：只在第一张（或换了一张新计划）上停，之后改动不停", () => {
    assert.equal(decide("skip", true, null, { items: two }), "plan-first");
    assert.equal(decide("skip", true, two, { items: [...two, { text: "写 README", status: "pending" }] }), null);
    assert.equal(decide("skip", true, two, { items: items(["调研向量库", "in_progress"], ["写对比表", "pending"]) }), "plan-first");
  });
});

describe("停下来：先停、让 agent 用正文说话（没有 terminate、没有按钮）", () => {
  const textOf = (out: unknown): string => (out as { content: { text: string }[] }).content[0]?.text ?? "";

  test("plan 档写新计划：details.awaiting；回执要求在正文里说要开工请切出 plan 档，且不 terminate", async () => {
    const { run } = setup({ getMode: () => "plan" });
    const out = await run("c1", { items: [{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }] });
    assert.equal((out as { terminate?: boolean }).terminate, undefined);
    assert.equal((out as { details: { awaiting?: boolean } }).details.awaiting, true);
    assert.match(textOf(out), /plan mode/);
    assert.match(textOf(out), /switch the permission out of plan mode/);
    assert.match(textOf(out), /no more tools/);
  });

  test("confirm：回执要求把问题在正文里问出来（用户在聊天框答，没有按钮）；问题不进 details", async () => {
    const { run } = setup();
    const out = await run("c1", { items: [{ text: "a", status: "in_progress" }], confirm: ["删不删？", "  "] });
    assert.equal((out as { details: { awaiting?: boolean } }).details.awaiting, true);
    assert.equal("confirm" in (out as { details: object }).details, false);
    assert.match(textOf(out), /ask the question\(s\) from `confirm` in plain prose/);
    assert.match(textOf(out), /no buttons/);
  });

  test("先给我看计划：回执要求一两句话 + 问题放正文", async () => {
    const { run } = setup({ planFirst: true });
    assert.match(textOf(await run("c1", { items: [{ text: "a", status: "in_progress" }] })), /before any work starts/);
  });

  test("闸门：update_plan 决定停之后，本轮其余工具调用被拦（block，不抛错、不带 terminate），让它回头用正文说话；之前的拦不住", () => {
    const { gate, state } = setup({ getMode: () => "plan" });
    const event = (id: string, toolName: string, input: Record<string, unknown>) => ({ toolCallId: id, toolName, input });
    assert.equal(gate(event("r0", "read", { path: "a" })), null);
    assert.equal(gate(event("p1", "update_plan", { items: [{ text: "a", status: "in_progress" }] })), null);
    assert.equal(state.stopping, true);
    const held = gate(event("r1", "read", { path: "b" }));
    assert.equal(held?.block, true);
    assert.equal("terminate" in (held ?? {}), false);
    assert.match(held?.reason ?? "", /paused for their reply/);
    assert.match(held?.reason ?? "", /plain prose/);
    // 同批第二个 update_plan 也按自己的判定走，不被当成「后面的调用」拦
    assert.equal(gate(event("p2", "update_plan", { items: [{ text: "a", status: "in_progress" }] })), null);
  });

  test("闸门：不停的计划不拦任何调用；入参过不了校验也不置位", () => {
    const { gate, state } = setup();
    assert.equal(gate({ toolCallId: "p1", toolName: "update_plan", input: { items: [{ text: "a", status: "in_progress" }] } }), null);
    assert.equal(gate({ toolCallId: "r1", toolName: "read", input: {} }), null);
    const bad = setup({ getMode: () => "plan" });
    assert.equal(bad.gate({ toolCallId: "p1", toolName: "update_plan", input: { items: [] } }), null);
    assert.equal(bad.state.stopping, false);
  });
});
