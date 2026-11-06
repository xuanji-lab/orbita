// 真实模型 TTFT：durable 1.5.0 侧。变体：
//   bare —— 无工具无系统段（= 第一轮 bench-real-durable 的配置）
//   full —— createCodingTools + ~2.6k token 系统段（对齐 coding-agent full 的载荷量级）
// 首事件时刻在 provider stream 的 tee 里记（拿到的是模型真正的第一个 delta，不经 partial 节流）。
// 用法：ZHIPU_KEY=<file> node bench-real-ttft-du.mjs <bare|full>
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";

const DURABLE_ROOT = process.env.DURABLE_ROOT;
const mod = (p) => import(pathToFileURL(resolvePkg(DURABLE_ROOT, p)).href);
const { BACKGROUND_CONTEXT } = await mod("@earendil-works/chord/context");
const { createModels, createProvider } = await mod("@earendil-works/pi-ai/models");
const { anthropicMessagesApi } = await mod("@earendil-works/pi-ai/api/anthropic-messages.lazy");
const { createAssistantMessageEventStream } = await mod("@earendil-works/pi-ai/utils/event-stream");
const durable = await mod("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await mod("@earendil-works/pi-durable/storage/sqlite/node");
const { createCodingTools } = await mod("@earendil-works/pi-durable/tools");

const variant = process.argv[2] ?? "bare";
const KEY = readFileSync(process.env.ZHIPU_KEY, "utf8").trim();
const PROMPT = "用一句话说明 SQLite 的 WAL 模式是什么。";

const context = BACKGROUND_CONTEXT;
const t0 = performance.now();
let firstEventMs = -1; // 模型侧第一个有效 delta（不经 partial 提交节流）
let firstType = "";
const rawApi = anthropicMessagesApi();
const teeApi = {
	stream: (m, c, o) => tee(rawApi.stream(m, c, o)),
	streamSimple: (m, c, o) => tee(rawApi.streamSimple(m, c, o)),
};
function tee(inner) {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const ev of inner) {
				// 首个有效增量：文本或思考的 delta（start/partial 骨架不算字）
				if (firstEventMs < 0 && (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "input_json_delta")) {
					firstEventMs = performance.now() - t0;
					firstType = ev.type;
				}
				out.push(ev);
			}
		} catch { /* 错误走 result */ }
		const final = await inner.result().catch(() => undefined);
		out.end(final);
	})();
	return out;
}

const zhipu = createProvider({
	id: "zhipu-coding",
	name: "Zhipu Coding",
	baseUrl: "https://open.bigmodel.cn/api/anthropic",
	// barebeta 变体：静态注入 coding-agent 0.84.3 同款的 beta 头，检验头假设
	...(variant === "barebeta" ? { headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" } } : {}),
	auth: { apiKey: { name: "zhipu", resolve: async () => ({ auth: { apiKey: KEY, baseUrl: "https://open.bigmodel.cn/api/anthropic" } }) } },
	models: [{
		provider: "zhipu-coding", id: "glm-5.3-flash", name: "glm-5.3-flash", api: "anthropic-messages",
		baseUrl: "https://open.bigmodel.cn/api/anthropic",
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}],
	api: teeApi,
});
const models = createModels();
models.setProvider(zhipu);
const registry = durable.createRegistry();
if (variant === "full") {
	registry.install(createCodingTools());
	const filler = Array.from({ length: 90 }, (_, i) => `Guideline ${i}: 你是一个简洁的编码助手，回答要准确、避免废话，注意文件操作安全与命令执行规范。`).join("\n");
	registry.install(durable.defineExtension({ name: "bench-big", sections: [durable.section("big", () => filler)] }));
}

const dir = await mkdtemp(join(tmpdir(), "ttft-du-"));
const db = join(dir, "ttft.sqlite");
rmSync(db, { force: true });
const harness = await durable.Harness.open(await openNodeSqliteStorage(db), {
	models,
	registry,
	settings: { progress: { partialIntervalMs: 1, outputIntervalMs: 1 } },
}, context);
const root = await harness.root(context, { agent: { model: { provider: "zhipu-coding", modelId: "glm-5.3-flash" } } });
harness.resume();

const settled = await (await root.submit({ type: "input", content: PROMPT, requestId: "ttft" }, context)).wait(context);
const total = performance.now() - t0;
const usage = await harness.usage(context);
const u = usage.models?.["zhipu-coding/glm-5.3-flash"] ?? {};
console.log(JSON.stringify({ side: "du", variant, settled: settled.status, firstEventMs: Math.round(firstEventMs), firstType, totalMs: Math.round(total), inTokens: u.input ?? u.tokens?.input ?? null }));
await harness.close(context);
process.exit(0);
