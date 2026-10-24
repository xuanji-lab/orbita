import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { Provider } from "../../shared/provider.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { buildPriceChart, type ArenaSnapshot, type PriceChartSources, type SessionScan } from "./price-chart.ts";

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

function sources(logs: Record<string, SessionRecord[]>, metas: SessionMeta[], providers: Provider[]): PriceChartSources & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    sessions: {
      list: async () => metas,
      readRawLog: async (id) => {
        reads.push(id);
        return logs[id] ?? [];
      },
    },
    readPiFile: async () => null,
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
    s4: [reply("d1", "opencode-go", "glm-5.3-flash", "low", 0.1), reply("d2", "opencode-go", "glm-5.3-flash", "high", 0.3)],
    imported: [reply("z1", "kimi-coding", "k3", "max", 999)],
  };
  const metas = [meta("s1", 1), meta("s2", 2), meta("s3", 3), meta("s4", 4), meta("imported", 5, { importedFrom: "/x.jsonl" })];

  test("实测点：各会话段花费的中位数与样本数；导入会话不计", async () => {
    const { data } = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    const k3 = agent?.points.find((p) => p.modelId === "k3");
    assert.equal(k3?.costBasis, "measured");
    assert.equal(k3?.samples, 3);
    assert.equal(k3?.cost, 3); // 段花费 2、3、5 → 中位数 3
    assert.equal(k3?.thinkingLevel, "max");
    assert.equal(k3?.providerId, "kimi-coding");
  });

  test("榜单没标档的条目：横轴取这个型号全部档位的段（low 0.1、high 0.3 → 0.2），点的档记 null", async () => {
    const { data } = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const flash = data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "glm-5.3-flash");
    assert.equal(flash?.thinkingLevel, null);
    assert.equal(flash?.samples, 2);
    assert.ok(Math.abs((flash?.cost ?? 0) - 0.2) < 1e-12);
  });

  test("没用过、有官方单价：估算点（空心）；没用过、也没有单价：缺官方单价", async () => {
    const { data } = await buildPriceChart(sources(logs, metas, providers), snapshot);
    const agent = data.categories.find((c) => c.category === "agent");
    const qwen = agent?.points.find((p) => p.modelId === "qwen3.8-max");
    assert.equal(qwen?.costBasis, "estimated");
    assert.equal(qwen?.samples, 0);
    assert.ok((qwen?.cost ?? 0) > 0);
    assert.deepEqual(agent?.unpriced, [{ providerId: "anthropic-compatible", modelId: "claude-opus-5-5" }]);
  });

  test("当前分类查不到的已添加型号列为未上榜；换一类就换一批", async () => {
    const { data } = await buildPriceChart(sources(logs, metas, providers), snapshot);
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
    const { data } = await buildPriceChart(sources({}, [], providers), snapshot);
    assert.equal(data.profile.reference, true);
    const qwen = data.categories.find((c) => c.category === "agent")?.points.find((p) => p.modelId === "qwen3.8-max");
    assert.equal(qwen?.costBasis, "reference");
  });

  test("套餐服务商在场 → hasPlanProvider；出处带 revision 与署名", async () => {
    const { data } = await buildPriceChart(sources(logs, metas, providers), snapshot);
    assert.equal(data.hasPlanProvider, true);
    assert.equal(data.source.license, "CC-BY-4.0");
    assert.equal(data.source.revision.length, 40);
  });

  test("缓存：updatedAt 没变的会话不重读", async () => {
    const src = sources(logs, metas, providers);
    const cache = new Map<string, SessionScan>();
    await buildPriceChart(src, snapshot, cache);
    const first = src.reads.length;
    await buildPriceChart(src, snapshot, cache);
    assert.equal(src.reads.length, first);
  });
});
