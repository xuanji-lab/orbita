// 压缩场景：对同一条会话手动 compact() 一次，量耗时、事件循环阻塞、摘要请求形状、内存。
// 用法：BENCH_SPEC=<json> [CA_ROOT=…] [DURABLE_ROOT=…] node bench-compact.mjs <ca|du>
// mock 的摘要路径固定睡 summaryMs（默认 2s）——报告时按摘要请求数扣除这段已知停顿。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";
import { benchSpec, emitter, memorySampler, roundMb } from "./bench-lib.mjs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const side = process.argv[2];
const spec = benchSpec();
const emit = emitter();
const mem = memorySampler();

try {
	let compactMs;
	let summaryInfo = null;
	let before = 0;
	const h = monitorEventLoopDelay({ resolution: 10 });
	const t0 = Date.now();
	h.enable();

	if (side === "ca") {
		const CA_ROOT = process.env.CA_ROOT;
		const mod = (p) => import(pathToFileURL(resolvePkg(CA_ROOT, p)).href);
		const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = await mod("@earendil-works/pi-coding-agent");
		const cwd = await mkdtemp(join(tmpdir(), "bench-compact-"));
		const services = await createAgentSessionServices({ cwd, resourceLoaderOptions: { noSkills: true, extensionFactories: [] } });
		services.settingsManager.applyOverrides({
			retry: { maxRetries: 0, baseDelayMs: 1 },
			defaultTools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
		});
		services.modelRuntime.registerProvider("bench", {
			apiKey: "bench", baseUrl: spec.mockUrl, api: "openai-completions",
			models: [{ id: "bench-model", name: "Bench Model", api: "openai-completions", input: ["text", "image"], reasoning: false, contextWindow: 2_000_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
		const model = services.modelRuntime.getModel("bench", "bench-model");
		const sessionManager = SessionManager.open(spec.piFile, undefined, cwd);
		const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
		before = Date.now();
		const result = await session.compact();
		compactMs = Date.now() - before;
		summaryInfo = { result: String(result?.status ?? result ?? "") .slice(0, 120) };
		await session.dispose();
	} else {
		const DURABLE_ROOT = process.env.DURABLE_ROOT;
		const mod = (p) => import(pathToFileURL(resolvePkg(DURABLE_ROOT, p)).href);
		const { BACKGROUND_CONTEXT } = await mod("@earendil-works/chord/context");
		const { createModels, createProvider } = await mod("@earendil-works/pi-ai/models");
		const { openAICompletionsApi } = await mod("@earendil-works/pi-ai/api/openai-completions.lazy");
		const durable = await mod("@earendil-works/pi-durable");
		const { openNodeSqliteStorage } = await mod("@earendil-works/pi-durable/storage/sqlite/node");
		const { NodeExecutionEnv } = await mod("@earendil-works/pi-durable/env/node");
		const { createCodingTools } = await mod("@earendil-works/pi-durable/tools");
		const context = BACKGROUND_CONTEXT;
		const models = createModels();
		models.setProvider(createProvider({
			id: "bench", name: "Bench Mock", baseUrl: spec.mockUrl,
			auth: { apiKey: { name: "bench", resolve: async () => ({ auth: { apiKey: "bench", baseUrl: spec.mockUrl } }) } },
			models: [{ provider: "bench", id: "bench-model", name: "Bench Model", api: "openai-completions", baseUrl: spec.mockUrl, input: ["text", "image"], reasoning: false, contextWindow: 2_000_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			api: openAICompletionsApi(),
		}));
		const registry = durable.createRegistry();
		registry.install(createCodingTools());
		const cwd = join(DURABLE_ROOT, "bench-cwd");
		mkdirSync(cwd, { recursive: true });
		const harness = await durable.Harness.open(await openNodeSqliteStorage(spec.dbFile), { models, registry, env: ({ cwd: c }) => new NodeExecutionEnv({ cwd: c ?? cwd }) }, context);
		const root = await harness.root(context, { agent: { model: { provider: "bench", modelId: "bench-model" }, cwd } });
		harness.resume();
		before = Date.now();
		const task = await root.compact(undefined, context);
		const settledTask = await harness.waitForTask(task, context);
		compactMs = Date.now() - before;
		summaryInfo = { task: String(task), settled: String(settledTask?.state?.kind ?? ""), outcome: JSON.stringify(settledTask?.outcome ?? null).slice(0, 200) };
		await harness.close(context);
	}
	h.disable();
	const mu = process.memoryUsage();
	emit({
		type: "done",
		report: {
			side, compactMs, eldMaxMs: Math.round((h.max / 1e6 - 10) * 10) / 10, eldP99Ms: Math.round((h.percentile(99) / 1e6 - 10) * 10) / 10,
			rssMb: roundMb(mu.rss), peak: mem.peak(), summaryInfo, openMs: before > 0 ? before - t0 : null,
		},
	});
	mem.stop();
	process.exit(0);
} catch (error) {
	emit({ type: "fatal", error: String(error?.stack ?? error) });
	process.exit(1);
}
