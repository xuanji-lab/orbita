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

  test("schema v4：why / later / confirm 都是可选字段，说明里讲了怎么用", () => {
    const { tool } = setup();
    const schema = tool.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(schema.properties), ["items", "why", "later", "confirm"]);
    assert.deepEqual(schema.required, ["items"]);
    for (const word of ["`why`", "`later`", "`confirm`", "same batch as the next step's first tool call"]) {
      assert.ok(tool.description.includes(word), word);
    }
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

describe("停下来：terminate 与同批拦截", () => {
  test("plan 档写新计划：execute 带 terminate、details.awaiting；回执要求停下", async () => {
    const { run, state } = setup({ getMode: () => "plan" });
    const out = (await run("c1", { items: [{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }] })) as {
      terminate?: boolean;
      details: { awaiting?: boolean };
      content: { text: string }[];
    };
    assert.equal(out.terminate, true);
    assert.equal(out.details.awaiting, true);
    assert.match(out.content[0]?.text ?? "", /plan mode/);
    assert.equal(state.stopping, false);
  });

  test("confirm：问题进 details，回执要求停下", async () => {
    const { run } = setup();
    const out = (await run("c1", { items: [{ text: "a", status: "in_progress" }], confirm: ["删不删？", "  "] })) as {
      terminate?: boolean;
      details: { confirm?: string[] };
    };
    assert.equal(out.terminate, true);
    assert.deepEqual(out.details.confirm, ["删不删？"]);
  });

  test("闸门：update_plan 决定停之后，同批后面的调用被拦且带 terminate（不抛错）；之前的拦不住", () => {
    const { gate, state } = setup({ getMode: () => "plan" });
    const event = (id: string, toolName: string, input: Record<string, unknown>) => ({ toolCallId: id, toolName, input });
    assert.equal(gate(event("r0", "read", { path: "a" })), null);
    assert.equal(gate(event("p1", "update_plan", { items: [{ text: "a", status: "in_progress" }] })), null);
    assert.equal(state.stopping, true);
    const held = gate(event("r1", "read", { path: "b" }));
    assert.equal(held?.block, true);
    assert.equal(held?.terminate, true);
    assert.match(held?.reason ?? "", /confirm your plan/);
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
