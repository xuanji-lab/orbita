/**
 * 补蒸蒸馏执行的回归网（纯核，依赖全注入）：日期锚在轮当时、候选每轮现取且
 * 拿不到当空、模型输出解析、单轮失败不拖垮整批、批内并发上限、查询文本拼串。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { MemoryBackfillTurnInput, MemoryBackfillTurnResult } from "../shared/agent-ipc.ts";
import type { MemoryCandidate } from "../shared/memory.ts";
import { candidatesQuery, mapWithLimit, runBackfillDistill, type BackfillDistillDeps } from "./backfill-distill.ts";

const CANDIDATE: MemoryCandidate = { id: "mem_old", text: "用户以前用 npm", timestamp: 1_600_000_000_000 };

const turn = (patch: Partial<MemoryBackfillTurnInput> = {}): MemoryBackfillTurnInput => ({
  sessionId: "s1",
  turn: 2,
  at: 1_650_000_000_000,
  userText: "以后都用 bun，别再用 npm 了",
  assistantText: "好的，记住了。",
  scope: { workspaceId: null, cwd: "/tmp/demo" },
  ...patch,
});

/** 记录调用参数的假依赖；callText 是模型输出，callError 非空时这轮调用失败。 */
function fakeDeps(options: {
  callText?: string;
  callError?: string;
  candidates?: MemoryCandidate[] | "throw";
} = {}): BackfillDistillDeps & {
  candidateQueries: { sessionId: string; query: string }[];
  calls: { now: number; candidates: readonly MemoryCandidate[]; fallback: unknown }[];
} {
  const candidateQueries: { sessionId: string; query: string }[] = [];
  const calls: { now: number; candidates: readonly MemoryCandidate[]; fallback: unknown }[] = [];
  return {
    candidateQueries,
    calls,
    fetchCandidates: async (input) => {
      candidateQueries.push({ sessionId: input.sessionId, query: input.query });
      if (options.candidates === "throw") throw new Error("主进程没回");
      return options.candidates ?? [];
    },
    callDistillModel: async (input) => {
      calls.push({ now: input.now, candidates: input.candidates, fallback: input.fallback });
      if (options.callError !== undefined) return { ok: false, error: options.callError };
      return { ok: true, text: options.callText ?? "[]" };
    },
  };
}

describe("runBackfillDistill", () => {
  test("成功：日期锚在轮当时（now = turn.at）、候选逐轮现取、解析进 entries", async () => {
    const deps = fakeDeps({
      callText: '[{"text":"用户决定改用 bun，不再用 npm","keywords":["bun"],"supersedes":"mem_old"}]',
      candidates: [CANDIDATE],
    });
    const results = await runBackfillDistill([turn()], deps);
    assert.equal(results.length, 1);
    const first = results[0];
    assert.ok(first?.ok);
    assert.equal(first.sessionId, "s1");
    assert.equal(first.turn, 2);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0]?.text, "用户决定改用 bun，不再用 npm");
    // supersedes 只认候选表里的 id（mem_old 在表里，收下）
    assert.equal(first.entries[0]?.supersedes, "mem_old");
    // 日期锚与候选查询
    assert.equal(deps.calls[0]?.now, 1_650_000_000_000);
    assert.equal(deps.calls[0]?.candidates.length, 1);
    assert.equal(deps.candidateQueries[0]?.query, "以后都用 bun，别再用 npm 了\n好的，记住了。");
  });

  test("候选问答失败：当空候选照常蒸（判不了推翻总比判错好）", async () => {
    const deps = fakeDeps({ candidates: "throw", callText: '[{"text":"一条记忆","keywords":[]}]' });
    const results = await runBackfillDistill([turn()], deps);
    const first = results[0];
    assert.ok(first?.ok);
    assert.equal(first.entries[0]?.supersedes, undefined);
    assert.equal(deps.calls[0]?.candidates.length, 0);
  });

  test("模型调用失败：收敛成 ok:false 带一句人话，不抛", async () => {
    const deps = fakeDeps({ callError: "429 too many requests" });
    const results = await runBackfillDistill([turn()], deps);
    const first = results[0];
    assert.ok(first !== undefined && !first.ok);
    if (first !== undefined && !first.ok) assert.equal(first.error, "429 too many requests");
  });

  test("模型输出读不懂：ok:true 配空 entries（蒸出 0 条也是成功）", async () => {
    const deps = fakeDeps({ callText: "这不是 JSON" });
    const results = await runBackfillDistill([turn()], deps);
    const first = results[0];
    assert.ok(first?.ok);
    assert.deepEqual(first.entries, []);
  });

  test("单轮抛异常不拖垮整批；fallback 原样透传给模型调用", async () => {
    const fallback = { provider: { id: "zai", api: "openai-completions", baseUrl: "", apiKey: "k", models: [] }, modelId: "glm-5.3" };
    const calls: { fallback: unknown }[] = [];
    const deps: BackfillDistillDeps = {
      fetchCandidates: async () => [],
      callDistillModel: async (input) => {
        calls.push({ fallback: input.fallback });
        if (input.userText === "炸掉") throw new Error("意外的崩");
        return { ok: true, text: "[]" };
      },
    };
    const results = await runBackfillDistill(
      [turn({ userText: "正常轮", fallback }), turn({ userText: "炸掉", turn: 3 })],
      deps,
    );
    assert.equal(results.length, 2);
    assert.ok(results[0]?.ok);
    assert.ok(!results[1]?.ok);
    assert.equal(calls[0]?.fallback, fallback);
  });
});

describe("mapWithLimit", () => {
  test("保序收集结果、限并发、空批与超量都正常", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
    assert.ok(peak <= 2);
    assert.deepEqual(await mapWithLimit([], 3, async (x) => x), []);
    const single = await mapWithLimit([7], 5, async (x) => x);
    assert.deepEqual(single, [7]);
  });
});

describe("candidatesQuery", () => {
  test("用户文本 + 回答拼串，截 8000", () => {
    assert.equal(candidatesQuery("问", "答"), "问\n答");
    const long = "x".repeat(9000);
    assert.equal(candidatesQuery(long, "答").length, 8000);
  });
});

/** 类型完备性：结果形状穷尽（编译期检查的运行时影子）。 */
test("MemoryBackfillTurnResult 两分支都造得出来", () => {
  const ok: MemoryBackfillTurnResult = { sessionId: "s", turn: 1, ok: true, entries: [] };
  const fail: MemoryBackfillTurnResult = { sessionId: "s", turn: 1, ok: false, error: "x" };
  assert.ok(ok.ok);
  assert.ok(!fail.ok);
});
