import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { Provider } from "../../shared/provider.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { PriceChartPoint } from "../../shared/price-chart.ts";
import { buildPriceChart, type ArenaSnapshot, type PriceChartSources } from "./price-chart.ts";
import { appendTaskRecord, chartTasks, emptyTaskBook, taskRecordsOf } from "./task-cost.ts";

const snapshot: ArenaSnapshot = {
  dataset: "lmarena-ai/leaderboard-dataset",
  url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
  revision: "0".repeat(40),
  license: "CC-BY-4.0",
  attribution: "Scores: Arena",
  categories: {
    agent: {
      unit: "net-improvement",
      publishDate: "2026-10-23",
      rows: [
        ["Kimi K3 (Max)", 0.0157, 0.008, 0.023, 100, 22],
        ["GLM-5.3-Flash", -0.0177, -0.024, -0.011, 100, 30],
        ["Qwen3.8-Max", 0.0113, 0.005, 0.017, 100, 25],
        ["Claude Opus 5.5 (Max)", 0.2077, 0.18, 0.23, 100, 1],
        ["Grok 4.7 (xHigh)", 0.05, 0.04, 0.06, 100, 6],
        ["Claude Fable 5.1 (Max)", 0.1394, 0.12, 0.16, 100, 4],
      ],
    },
    webdev: {
      unit: "rating",
      publishDate: "2026-10-23",
      rows: [["Kimi K3.1 Pro (Max)", 1691.6, 1678, 1705, 100, 8]],
    },
  },
};

function provider(id: string, kind: string, models: Provider["models"]["declared"]): Provider {
  return {
    id,
    kind,
    displayName: id,
    endpoint: { baseUrl: "https://x", api: "anthropic-messages" },
    auth: { scheme: "none" },
    models: { declared: models },
  };
}

function meta(id: string, createdAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: "",
    titleSource: "derived",
    stats: null,
    cwd: "/",
    workspaceId: null,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    providerId: "kimi-coding",
    modelId: "k3",
    mode: "plan",
    thinkingLevel: "max",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

function reply(id: string, providerId: string, model: string, level: ThinkingLevel, cost: number): SessionRecord {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider: providerId, id: model },
    usage: {
      input: 1000,
      output: 100,
      cacheRead: 10_000,
      cacheWrite: 0,
      totalTokens: 11_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    timestamp: 1,
    status: "complete",
    stopReason: "stop",
    thinkingLevel: level,
  };
}

const catalog: BuiltinProvider[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "",
    api: "openai-completions",
    models: [
      {
        id: "qwen3.8-max",
        contextWindow: 1,
        maxTokens: 1,
        input: ["text"],
        cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
      },
    ],
  },
];

/**
 * 数据源：把会话日志按回填同一套规则（跳过导入会话、createdAt 正序、消息 id 去重、
 * taskRecordsOf → appendTaskRecord）记成任务账，再交给 buildPriceChart——与 TaskLedger.backfill 同口径。
 * 这里的每条会话都当**子会话**（整条会话一件做完的事）：图的计算只看任务全集，主会话的
 * 「确认的做完的事」怎么来见 task-cost.test.ts 的 chartTasks。
 */
function sources(logs: Record<string, SessionRecord[]>, metas: SessionMeta[], providers: Provider[]): PriceChartSources {
  const book = emptyTaskBook();
  const seen = new Set<string>();
  const native = metas.filter((m) => m.importedFrom === undefined).sort((a, b) => a.createdAt - b.createdAt);
  for (const m of native) {
    for (const item of taskRecordsOf(logs[m.id] ?? [], [], m.thinkingLevel)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      appendTaskRecord(book, m.id, item, () => "2026-10-24");
    }
  }
  return {
    tasks: async () => chartTasks(book.tasks, [], new Set(native.map((m) => m.id))),
    providers: async () => providers,
    catalog: async () => catalog,
  };
}

const providers = [
  provider("kimi-coding", "kimi-coding", [{ id: "k3" }, { id: "k3.1-pro" }, { id: "kimi-for-coding" }]),
  provider("opencode-go", "opencode-go", [{ id: "qwen3.8-max" }, { id: "glm-5.3-flash" }]),
  provider("anthropic-compatible", "anthropic-compatible", [{ id: "claude-opus-5-5" }]),
];

describe("buildPriceChart", () => {
  const logs = {
    s1: [reply("a1", "kimi-coding", "k3", "max", 1), reply("a2", "kimi-coding", "k3", "max", 1)],
    s2: [reply("b1", "kimi-coding", "k3", "max", 3)],
    s3: [reply("c1", "kimi-coding", "k3", "max", 5)],
    s4: [reply("d1", "opencode-go", "glm-5.3-flash", "low", 0.1)],
    s6: [reply("d2", "opencode-go", "glm-5.3-flash", "high", 0.3)],
    s5: [reply("e1", "opencode-go", "glm-5.3-flash", "medium", 0.2)],
    imported: [reply("z1", "kimi-coding", "k3", "max", 999)],
  };
  const metas = [meta("s1", 1), meta("s2", 2), meta("s3", 3), meta("s4", 4), meta("s6", 4.5), meta("s5", 6), meta("imported", 5, { importedFrom: "/x.jsonl" })];

  test("实测点：各会话段花费的中位数与样本数；导入会话不计", async () => {
    const data = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    const k3 = agent?.points.find((p) => p.modelId === "k3");
    assert.equal(k3?.costBasis, "measured");
    assert.equal(k3?.samples, 3);
    assert.equal(k3?.cost, 3); // 段花费 2、3、5 → 中位数 3
    assert.equal(k3?.thinkingLevel, "max");
  });

  test("榜单没标档的条目：横轴取这个型号全部档位的段（low 0.1、high 0.3、medium 0.2 → 0.2），点的档记 null", async () => {
    const data = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const flash = data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "glm-5.3-flash");
    assert.equal(flash?.thinkingLevel, null);
    assert.equal(flash?.costBasis, "measured");
    assert.equal(flash?.samples, 3);
    assert.ok(Math.abs((flash?.cost ?? 0) - 0.2) < 1e-12);
  });

  describe("实测门槛：少于 3 个任务按估算画，悬停里另带实测", () => {
    const qwen = (id: string, cost: number) => reply(id, "opencode-go", "qwen3.8-max", "high", cost);
    const pointOf = async (taskCount: number) => {
      const qlogs: Record<string, SessionRecord[]> = {};
      const qmetas: SessionMeta[] = [];
      for (let i = 0; i < taskCount; i += 1) {
        qlogs[`q${i}`] = [qwen(`qa${i}`, 30 + i)];
        qmetas.push(meta(`q${i}`, 10 + i));
      }
      const data = await buildPriceChart(sources(qlogs, qmetas, providers), snapshot);
      return data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "qwen3.8-max");
    };

    test("2 个任务：估算点（空心），实测的中位数与任务数随点带上", async () => {
      const point = await pointOf(2);
      assert.equal(point?.costBasis, "estimated");
      assert.equal(point?.samples, 0);
      assert.deepEqual(point?.measured, { cost: 30.5, samples: 2 });
      assert.notEqual(point?.cost, 30.5);
    });

    test("3 个任务：实测中位数画实心点，不再带 measured", async () => {
      const point = await pointOf(3);
      assert.equal(point?.costBasis, "measured");
      assert.equal(point?.samples, 3);
      assert.equal(point?.cost, 31);
      assert.equal(point?.measured, undefined);
    });

    test("不够门槛又找不到官方单价：定不了横轴，列进缺官方单价", async () => {
      const opusLogs = { o1: [reply("oa", "anthropic-compatible", "claude-opus-5-5", "max", 2)] };
      const data = await buildPriceChart(sources(opusLogs, [meta("o1", 1)], providers), snapshot);
      const agent = data.categories.find((c) => c.category === "agent");
      assert.ok(!agent?.points.some((p) => p.modelId === "claude-opus-5-5"));
      assert.ok(agent?.unpriced.some((u) => u.modelId === "claude-opus-5-5"));
    });
  });

  test("没用过、有官方单价：估算点（空心）；没用过、也没有单价：缺官方单价", async () => {
    const data = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    const qwen = agent?.points.find((p) => p.modelId === "qwen3.8-max");
    assert.equal(qwen?.costBasis, "estimated");
    assert.equal(qwen?.samples, 0);
    assert.ok((qwen?.cost ?? 0) > 0);
    assert.deepEqual(agent?.unpriced, [{ modelId: "claude-opus-5-5" }]);
  });

  test("当前分类查不到的已添加型号列为未上榜；换一类就换一批", async () => {
    const data = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    assert.deepEqual(
      agent?.unranked.map((u) => u.modelId),
      ["k3.1-pro", "kimi-for-coding"],
    );
    const webdev = data.categories.find((c) => c.category === "webdev");
    assert.ok(webdev?.unranked.some((u) => u.modelId === "k3"));
    assert.ok(!webdev?.unranked.some((u) => u.modelId === "k3.1-pro"));
  });

  test("用户一个任务都没有：估算点标 reference（参考画像）", async () => {
    const data = await buildPriceChart(sources({}, [], providers), snapshot);
    assert.equal(data.profile.reference, true);
    const qwen = data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "qwen3.8-max");
    assert.equal(qwen?.costBasis, "reference");
  });

  test("套餐服务商在场 → hasPlanProvider；出处带 revision 与署名", async () => {
    const data = await buildPriceChart(sources(logs, metas, providers), snapshot);
    assert.equal(data.hasPlanProvider, true);
    assert.equal(data.source.license, "CC-BY-4.0");
    assert.equal(data.source.revision.length, 40);
  });

  test("档不可考的段（level null）计 token，但不画点、不进估算画像", async () => {
    const book = emptyTaskBook();
    appendTaskRecord(book, "x", { id: "u1", providerId: "kimi-coding", modelId: "k3", tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, cost: 5, timestamp: 1 }, () => "2026-10-24");
    assert.equal(book.tasks[0]?.level, null);
    const tasks = chartTasks(book.tasks, [], new Set(["x"]));
    assert.deepEqual(tasks, []);
    const data = await buildPriceChart({ tasks: async () => tasks, providers: async () => providers, catalog: async () => catalog }, snapshot);
    assert.equal(data.profile.reference, true);
    const k3 = data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "k3");
    assert.equal(k3, undefined);
  });
});

describe("一个点 = 型号 × 档：几家服务商、几个别名合成一个", () => {
  const rate = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n });
  // 两家以上服务商 + 别名：Kimi Code 的 k3、Anthropic 兼容的 kimi-k3、OpenCode Go 的 kimi-k3
  const kimiEverywhere = [
    provider("kimi-coding", "kimi-coding", [{ id: "k3", cost: rate(1) }]),
    provider("anthropic-compatible", "anthropic-compatible", [{ id: "kimi-k3", cost: rate(9) }, { id: "my-private-model" }]),
    provider("opencode-go", "opencode-go", [{ id: "kimi-k3" }, { id: "my-private-model" }]),
  ];
  const agentOf = async (logs: Record<string, SessionRecord[]>, metas: SessionMeta[]) => {
    const data = await buildPriceChart(sources(logs, metas, kimiEverywhere), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    assert.ok(agent !== undefined);
    return agent;
  };

  test("两家服务商 + 一个别名合成一个点，代表 id 取最先添加的那个；未上榜也按型号去重", async () => {
    const agent = await agentOf({}, []);
    const kimi = agent.points.filter((p) => p.boardName === "Kimi K3 (Max)");
    assert.equal(kimi.length, 1);
    assert.equal(kimi[0]?.modelId, "k3");
    assert.deepEqual(agent.unranked, [{ modelId: "my-private-model" }]);
  });

  test("几家单价不同：按服务商列表顺序取第一个查得到的（先添加的 Kimi Code 自填 $1）", async () => {
    const logs = { s: [reply("x", "kimi-coding", "k3", "max", 1)] };
    const agent = await agentOf(logs, [meta("s", 1)]);
    const kimi = agent.points.find((p) => p.boardName === "Kimi K3 (Max)");
    // 估算 = 单价按画像构成加权 × 任务 token 中位数；四项单价都是 1，加权后就是 1 $/M
    assert.ok(kimi !== undefined);
    assert.ok(Math.abs(kimi.cost - 11_100 / 1_000_000) < 1e-12);
  });

  test("任务跨服务商、跨别名合在一起：各 1 个、合计 3 个就画实测中位数", async () => {
    const logs = {
      a: [reply("a1", "kimi-coding", "k3", "max", 1)],
      b: [reply("b1", "anthropic-compatible", "kimi-k3", "max", 2)],
      c: [reply("c1", "opencode-go", "kimi-k3", "max", 4)],
    };
    const agent = await agentOf(logs, [meta("a", 1), meta("b", 2), meta("c", 3)]);
    const kimi = agent.points.filter((p) => p.boardName === "Kimi K3 (Max)");
    assert.equal(kimi.length, 1);
    assert.equal(kimi[0]?.costBasis, "measured");
    assert.equal(kimi[0]?.samples, 3);
    assert.equal(kimi[0]?.cost, 2);
  });

  test("合计只有 2 个：仍按估算画，实测随点带上", async () => {
    const logs = {
      a: [reply("a1", "kimi-coding", "k3", "max", 1)],
      b: [reply("b1", "anthropic-compatible", "kimi-k3", "max", 2)],
    };
    const agent = await agentOf(logs, [meta("a", 1), meta("b", 2)]);
    const kimi = agent.points.find((p) => p.boardName === "Kimi K3 (Max)");
    assert.equal(kimi?.costBasis, "estimated");
    assert.deepEqual(kimi?.measured, { cost: 1.5, samples: 2 });
  });
});

describe("手写表外的型号（新服务商）：规范化兜底配上榜", () => {
  test("xAI 的 grok-4.7 在有它的分类里出点、在没有它的分类里进未上榜", async () => {
    const xai = [
      provider("xai", "xai", [{ id: "grok-4.7", cost: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 } }]),
      provider("kimi-coding", "kimi-coding", [{ id: "k3" }]),
    ];
    const data = await buildPriceChart(sources({}, [], xai), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    const grok = agent?.points.find((p) => p.modelId === "grok-4.7");
    assert.equal(grok?.thinkingLevel, "xhigh");
    assert.equal(grok?.boardName, "Grok 4.7 (xHigh)");
    const webdev = data.categories.find((c) => c.category === "webdev");
    assert.ok(webdev?.unranked.some((u) => u.modelId === "grok-4.7"));
  });
});

describe("用过、但榜单没评的档：借同型号评过的最高档的分（2026-10-25 用户：「用 max 顶替」）", () => {
  const rate = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  // 有官方单价（自填），才定得了估算；第二家用来验「几家服务商的任务合在一起」
  const fable = [
    provider("anthropic-compatible", "anthropic-compatible", [{ id: "claude-fable-5-1", cost: rate }, { id: "my-private-model" }]),
    provider("claude", "claude", [{ id: "claude-fable-5-1" }]),
  ];
  /** 每个 [服务商, 档, 花费] 一个子会话 = 一个任务 */
  const agentOf = async (tasks: [string, ThinkingLevel, number][], declared: Provider[] = fable, model = "claude-fable-5-1") => {
    const logs: Record<string, SessionRecord[]> = {};
    const metas: SessionMeta[] = [];
    tasks.forEach(([providerId, level, cost], i) => {
      logs[`t${i}`] = [reply(`r${i}`, providerId, model, level, cost)];
      metas.push(meta(`t${i}`, i + 1));
    });
    const data = await buildPriceChart(sources(logs, metas, declared), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    assert.ok(agent !== undefined);
    return agent;
  };
  const pointsOf = (agent: { points: { modelId: string }[] }) =>
    agent.points.filter((p) => p.modelId === "claude-fable-5-1") as PriceChartPoint[];

  test("够 3 个任务：画实心点，纵轴借最高档的分与榜单条目，横轴是这一档自己的实测中位数", async () => {
    const agent = await agentOf([
      ["anthropic-compatible", "high", 2],
      ["anthropic-compatible", "high", 3],
      ["claude", "high", 4],
    ]);
    const [max, high] = pointsOf(agent);
    assert.equal(max?.thinkingLevel, "max");
    assert.equal(max?.scoreFrom, undefined);
    assert.equal(high?.thinkingLevel, "high");
    assert.equal(high?.scoreFrom, "max");
    assert.equal(high?.score, 0.1394);
    assert.equal(high?.boardName, "Claude Fable 5.1 (Max)");
    assert.equal(high?.costBasis, "measured");
    assert.equal(high?.samples, 3);
    assert.equal(high?.cost, 3);
    assert.equal(max?.folded, undefined);
  });

  test("不够 3 个、最高档那一点也是估算：两点会叠在一起，并进最高档那一点（folded），不另画", async () => {
    const agent = await agentOf([
      ["anthropic-compatible", "high", 2],
      ["claude", "high", 4],
      ["claude", "xhigh", 7],
    ]);
    const points = pointsOf(agent);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.thinkingLevel, "max");
    assert.equal(points[0]?.costBasis, "estimated");
    assert.deepEqual(points[0]?.folded, [
      { thinkingLevel: "high", samples: 2, cost: 3 },
      { thinkingLevel: "xhigh", samples: 1, cost: 7 },
    ]);
  });

  test("不够 3 个、最高档那一点是实测：位置不重合，借分点按估算画（空心），实测随点带上", async () => {
    const agent = await agentOf([
      ["claude", "max", 10],
      ["claude", "max", 12],
      ["claude", "max", 14],
      ["claude", "high", 5],
    ]);
    const [max, high] = pointsOf(agent);
    assert.equal(max?.costBasis, "measured");
    assert.equal(max?.cost, 12);
    assert.equal(high?.scoreFrom, "max");
    assert.equal(high?.costBasis, "estimated");
    assert.ok((high?.cost ?? 0) > 0);
    assert.notEqual(high?.cost, 12);
    assert.notEqual(high?.cost, 5);
    assert.deepEqual(high?.measured, { cost: 5, samples: 1 });
    assert.equal(max?.folded, undefined);
  });

  test("没有官方单价、任务又不够 3 个：定不了横轴，不借分；型号进缺官方单价", async () => {
    const noRates = [provider("claude", "claude", [{ id: "claude-fable-5-1" }])];
    const agent = await agentOf([["claude", "high", 3]], noRates);
    assert.deepEqual(pointsOf(agent), []);
    assert.ok(agent.unpriced.some((u) => u.modelId === "claude-fable-5-1"));
  });

  test("整个型号不在榜上：进未上榜，不借分", async () => {
    const agent = await agentOf([["anthropic-compatible", "high", 2]], fable, "my-private-model");
    assert.ok(agent.unranked.some((u) => u.modelId === "my-private-model"));
    assert.ok(!agent.points.some((p) => p.modelId === "my-private-model"));
  });

  test("只用了榜单评过的档：没有借分点；榜单条目没标档的型号（GLM-5.3-Flash）也不借（那个点包了全部档位）", async () => {
    const maxOnly = await agentOf([["claude", "max", 2]]);
    assert.ok(!maxOnly.points.some((p) => p.scoreFrom !== undefined));
    const flashLogs = { f: [reply("f1", "opencode-go", "glm-5.3-flash", "high", 1)] };
    const priced = [provider("opencode-go", "opencode-go", [{ id: "glm-5.3-flash", cost: rate }])];
    const data = await buildPriceChart(sources(flashLogs, [meta("f", 1)], priced), snapshot);
    const flash = data.categories.find((c) => c.category === "agent")?.points.filter((p) => p.modelId === "glm-5.3-flash");
    assert.equal(flash?.length, 1);
    assert.equal(flash?.[0]?.thinkingLevel, null);
    assert.equal(flash?.[0]?.folded, undefined);
  });
});
