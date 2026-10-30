/**
 * 价格 · 能力图数据来源的 memo，以及 model_costs 的表与图数据的一致性：
 * 同一个来源喂设置页与 agent 工具，账本没变就不重算，账本一变两边同时看到新数。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { formatModelCosts } from "./model-costs.ts";
import type { ArenaSnapshot } from "./price-chart.ts";
import { createPriceChartSource } from "./price-chart-source.ts";
import type { ChartTask, DayCounts } from "./task-cost.ts";

const snapshot: ArenaSnapshot = {
  dataset: "d",
  url: "u",
  revision: "r",
  license: "l",
  attribution: "a",
  categories: {
    agent: {
      unit: "net-improvement",
      publishDate: "2026-10-23",
      rows: [
        ["Kimi K3 (Max)", 0.0157, 0.008, 0.023, 100, 22],
        ["GLM-5.3-Flash", -0.0177, -0.024, -0.011, 100, 30],
      ],
    },
  },
};

const provider: Provider = {
  id: "kimi-coding",
  kind: "kimi-coding",
  displayName: "Kimi",
  endpoint: { baseUrl: "https://x", api: "anthropic-messages" },
  auth: { scheme: "none" },
  models: { declared: [{ id: "k3" }, { id: "glm-5.3-flash", cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 } }] },
};

const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function task(modelId: string, level: ThinkingLevel, cost: number): ChartTask {
  const totals: DayCounts = {
    tokens: { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 },
    recordedCost: cost,
    unpricedTokens: zeroTokens,
  };
  return { providerId: "kimi-coding", modelId, level, totals };
}

function setup(tasks: ChartTask[]) {
  const state = { version: 1, tasks, builds: 0, sessions: [] as SessionMeta[] };
  const source = createPriceChartSource({
    ledger: {
      settled: async () => undefined,
      version: () => state.version,
      chartTasks: () => {
        state.builds += 1;
        return state.tasks;
      },
    },
    providers: async () => [provider],
    catalog: async () => [],
    sessions: async () => state.sessions,
    snapshot,
  });
  return { state, source };
}

describe("createPriceChartSource", () => {
  test("账本版本与服务商声明都没变：第二次请求原样返回上次的结果，不重算", async () => {
    const { state, source } = setup([task("k3", "max", 2), task("k3", "max", 3), task("k3", "max", 4)]);
    const first = await source();
    const second = await source();
    assert.equal(second, first);
    assert.equal(state.builds, 1);
  });

  test("账本版本变了：重算，新任务进图", async () => {
    const { state, source } = setup([task("k3", "max", 2), task("k3", "max", 3), task("k3", "max", 4)]);
    await source();
    state.tasks = [...state.tasks, task("k3", "max", 100), task("k3", "max", 100)];
    state.version = 2;
    const data = await source();
    assert.equal(state.builds, 2);
    assert.equal(data.categories[0]?.points.find((p) => p.modelId === "k3")?.samples, 5);
  });

  test("表与图数据一致：花费中位数、样本数、估算标记、前沿都从同一份数据来（最便宜的 flash 在前沿上，k3 分更高也在）", async () => {
    // k3·max 三个任务 → 实测中位数 3；glm-5.3-flash 一个任务 → 不够门槛，按官方单价估算
    const { source } = setup([task("k3", "max", 2), task("k3", "max", 3), task("k3", "max", 4), task("glm-5.3-flash", "low", 0.05)]);
    const data = await source();
    const points = data.categories[0]?.points ?? [];
    const k3 = points.find((p) => p.modelId === "k3");
    const flash = points.find((p) => p.modelId === "glm-5.3-flash");
    assert.equal(k3?.cost, 3);
    assert.equal(flash?.costBasis, "estimated");
    const lines = formatModelCosts(data).split("\n");
    const flashLine = lines.find((line) => line.startsWith("glm-5.3-flash |"));
    const k3Line = lines.find((line) => line.startsWith("k3 |"));
    assert.equal(k3Line, "k3 | max | $3.00 n=3 | +1.6%*");
    assert.match(flashLine ?? "", /^glm-5\.3-flash \| default \| est \$[\d.]+ \(n=1 \$0\.050\) \| -1\.8%\*$/);
  });

  test("型号没添加：账本里有它的任务也不出现在表里", async () => {
    const { source } = setup([task("k3", "max", 2), task("claude-opus-5-5", "max", 9)]);
    const text = formatModelCosts(await source());
    assert.ok(!text.includes("claude-opus-5-5"));
  });
});
