import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AUTOMATION_TOOLS } from "../shared/permission.ts";
import type { AutomationCardView, AutomationModeRow, AutomationToolOutcome, AutomationToolRequest } from "../shared/automation.ts";
import type { PermissionMode } from "../shared/permission.ts";
import { AUTOMATION_TOOL_NAMES, createAutomationTools, toScheduleRequest } from "./automation-tools.ts";
import { RequestBroker } from "./request-broker.ts";

const card: AutomationCardView = {
  id: "au1",
  title: "等 vLLM",
  schedule: { kind: "interval", unit: "minute", every: 15 },
  target: "this_session",
  status: "active",
  nextRunAt: Date.UTC(2026, 9, 31, 2, 0),
  runCount: 0,
  maxRuns: 12,
};

/** 假主进程：记下收到的 automationRequest，按给定回执回 */
function harness(outcome: AutomationToolOutcome, sessionMode: { current: PermissionMode } = { current: "skip" }) {
  const requests: { sessionId: string; request: AutomationToolRequest }[] = [];
  const modes: PermissionMode[] = [];
  const broker: RequestBroker = new RequestBroker((event) => {
    const { requestId, sessionId, request, mode } = event as {
      requestId: string;
      sessionId: string;
      request: AutomationToolRequest;
      mode: PermissionMode;
    };
    requests.push({ sessionId, request });
    modes.push(mode);
    setImmediate(() => broker.resolve(requestId, outcome));
  });
  const tools = createAutomationTools(broker, "S", () => sessionMode.current);
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    return tool;
  };
  return { requests, modes, byName, tools };
}

const noSignal = undefined as never;

describe("工具名与权限桶同源", () => {
  test("四个工具，名字与 shared/permission.ts 的 AUTOMATION_TOOLS 一致", () => {
    assert.deepEqual([...AUTOMATION_TOOL_NAMES], [...AUTOMATION_TOOLS]);
    const { tools } = harness({ ok: true, text: "" });
    assert.deepEqual(tools.map((tool) => tool.name), [...AUTOMATION_TOOLS]);
  });

  test("create 的说明把关键语义讲给模型：直接生效、this_session 默认、别 sleep 轮询、默认 12 次、间隔下限", () => {
    const description = harness({ ok: true, text: "" }).byName("automation_create").description;
    for (const needle of ["immediately", "this_session", "Do NOT sleep or poll", "12 runs", "5 minutes", "END YOUR TURN", "new_session"]) {
      assert.ok(description.includes(needle), needle);
    }
  });

  test("create 的说明让模型先口头问再请求放行，不再说「去面板里改」", () => {
    const description = harness({ ok: true, text: "" }).byName("automation_create").description;
    for (const needle of ["ask the user in ONE plain sentence", 'automation_update with mode "skip"', "Never request", "Allow button"]) {
      assert.ok(description.includes(needle), needle);
    }
    assert.doesNotMatch(description, /Automations panel|yourself/);
  });
});

describe("toScheduleRequest", () => {
  test("once 的 ISO 时间转成毫秒；带偏移的 ISO 按偏移算", () => {
    assert.deepEqual(toScheduleRequest({ kind: "once", at: "2026-11-02T09:00:00+08:00" }), {
      kind: "once",
      at: Date.UTC(2026, 10, 2, 1, 0),
    });
  });

  test("interval 的 everyMinutes 简写折成 unit minute；完整写法与其它种类原样交给主进程", () => {
    assert.deepEqual(toScheduleRequest({ kind: "interval", everyMinutes: 15 }), { kind: "interval", unit: "minute", every: 15 });
    const full = { kind: "interval", unit: "hour", every: 2 };
    assert.equal(toScheduleRequest(full), full);
    const daily = { kind: "daily", time: "09:00", weekdays: [1, 2] };
    assert.equal(toScheduleRequest(daily), daily);
  });

  test("坏入参抛带字段名的说明", () => {
    assert.throws(() => toScheduleRequest(null), /"schedule"/);
    assert.throws(() => toScheduleRequest({ kind: "once", at: "明天" }), /schedule\.at/);
    assert.throws(() => toScheduleRequest({ kind: "once" }), /schedule\.at/);
  });
});

describe("automation_create", () => {
  test("把入参翻成 automationRequest（until 的 ISO 转毫秒），成功回执翻成文本 + details.automation 卡", async () => {
    const h = harness({ ok: true, text: 'Automation "等 vLLM" (id au1) is active.', automation: card });
    const result = await h.byName("automation_create").execute(
      "call1",
      {
        title: "等 vLLM",
        prompt: "看日志",
        schedule: { kind: "interval", everyMinutes: 15 },
        maxRuns: 12,
        until: "2026-11-01T00:00:00Z",
        target: "new_session",
        model: " glm-5.3 ",
      },
      undefined,
      undefined,
      noSignal,
    );
    assert.deepEqual(h.requests, [
      {
        sessionId: "S",
        request: {
          op: "create",
          title: "等 vLLM",
          prompt: "看日志",
          schedule: { kind: "interval", unit: "minute", every: 15 },
          maxRuns: 12,
          until: Date.UTC(2026, 10, 1),
          target: "new_session",
          model: " glm-5.3 ",
        },
      },
    ]);
    assert.deepEqual(result.details, { automation: card });
    const text = result.content[0];
    assert.ok(text?.type === "text" && text.text.includes("is active"));
  });

  test("没给的可选项不带进请求；target 不是合法值就当没给", async () => {
    const h = harness({ ok: true, text: "ok", automation: card });
    await h.byName("automation_create").execute(
      "c",
      { title: "t", prompt: "p", schedule: { kind: "hourly", minute: 0 }, target: "everywhere" },
      undefined,
      undefined,
      noSignal,
    );
    assert.deepEqual(h.requests[0]?.request, { op: "create", title: "t", prompt: "p", schedule: { kind: "hourly", minute: 0 } });
  });

  test("主进程拒绝：错误原样成为工具失败原因；本地就能判的（缺标题 / 坏 ISO）不发请求", async () => {
    const h = harness({ ok: false, error: "At most 5 active automations can be bound to one session." });
    await assert.rejects(
      h.byName("automation_create").execute("c", { title: "t", prompt: "p", schedule: { kind: "hourly", minute: 0 } }, undefined, undefined, noSignal),
      /At most 5/,
    );
    assert.equal(h.requests.length, 1);
    await assert.rejects(h.byName("automation_create").execute("c", { prompt: "p", schedule: {} }, undefined, undefined, noSignal), /"title"/);
    await assert.rejects(
      h.byName("automation_create").execute("c", { title: "t", prompt: "p", schedule: { kind: "hourly", minute: 0 }, until: "改天" }, undefined, undefined, noSignal),
      /"until"/,
    );
    assert.equal(h.requests.length, 1, "后两次没有发请求");
  });
});

describe("automation_list / automation_cancel", () => {
  test("list：每条一行（id、标题、状态、去处、次数、下次），不带 details", async () => {
    const h = harness({ ok: true, text: "1 automation(s) in this workspace.", automations: [card] });
    const result = await h.byName("automation_list").execute("c", {}, undefined, undefined, noSignal);
    assert.deepEqual(h.requests[0]?.request, { op: "list" });
    const text = result.content[0];
    assert.ok(text?.type === "text");
    assert.ok(text.text.includes('- au1 · "等 vLLM" · active · sent back into its session · 0 run(s) of 12 · next 2026-10-31T02:00:00.000Z'));
    assert.equal(result.details, undefined);
  });

  test("cancel：发 cancel 请求带 id；缺 id 本地就抛", async () => {
    const h = harness({ ok: true, text: 'Automation "等 vLLM" is cancelled; it will not run again.' });
    const result = await h.byName("automation_cancel").execute("c", { automationId: "au1" }, undefined, undefined, noSignal);
    assert.deepEqual(h.requests[0]?.request, { op: "cancel", automationId: "au1" });
    assert.ok(result.content[0]?.type === "text" && result.content[0].text.includes("cancelled"));
    await assert.rejects(h.byName("automation_cancel").execute("c", {}, undefined, undefined, noSignal), /"automationId"/);
  });
});

describe("automation_update / create.mode（改权限档）", () => {
  const row: AutomationModeRow = { state: "pending", requestId: "r1", automationId: "au1", title: "每日一篇", sessionMode: "manual" };

  test("update：发 update 请求（只带 id 与 mode），请求里带会话此刻的权限档；回执的行进 details.automationMode", async () => {
    const mode = { current: "manual" as PermissionMode };
    const h = harness({ ok: true, text: "NOT changed", automation: card, modeRow: row }, mode);
    const result = await h.byName("automation_update").execute("c", { automationId: "au1", mode: "skip", prompt: "偷偷改指令" }, undefined, undefined, noSignal);
    assert.deepEqual(h.requests[0]?.request, { op: "update", automationId: "au1", mode: "skip" }, "别的字段 agent 改不了，也不会被带出去");
    assert.deepEqual(h.modes, ["manual"]);
    assert.deepEqual(result.details, { automation: card, automationMode: row });
    mode.current = "skip";
    await h.byName("automation_update").execute("c", { automationId: "au1", mode: "plan" }, undefined, undefined, noSignal);
    assert.deepEqual(h.modes, ["manual", "skip"], "档位每次现读");
  });

  test("update：坏 mode / 缺 id 本地就抛，不发请求；主进程拒绝的原样成为失败原因", async () => {
    const h = harness({ ok: false, error: "No such automation in this workspace." });
    await assert.rejects(h.byName("automation_update").execute("c", { automationId: "au1", mode: "manual" }, undefined, undefined, noSignal), /"mode"/);
    await assert.rejects(h.byName("automation_update").execute("c", { mode: "skip" }, undefined, undefined, noSignal), /"automationId"/);
    assert.equal(h.requests.length, 0);
    await assert.rejects(h.byName("automation_update").execute("c", { automationId: "x", mode: "skip" }, undefined, undefined, noSignal), /No such automation/);
  });

  test("create：mode 只认 plan / skip，别的值当没给", async () => {
    const h = harness({ ok: true, text: "ok", automation: card });
    const base = { title: "t", prompt: "p", schedule: { kind: "hourly", minute: 0 }, target: "new_session" };
    await h.byName("automation_create").execute("c", { ...base, mode: "skip" }, undefined, undefined, noSignal);
    await h.byName("automation_create").execute("c", { ...base, mode: "manual" }, undefined, undefined, noSignal);
    assert.equal((h.requests[0]?.request as { mode?: string }).mode, "skip");
    assert.equal("mode" in (h.requests[1]?.request ?? {}), false);
  });
});
