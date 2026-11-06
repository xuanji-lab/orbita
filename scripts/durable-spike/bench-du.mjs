// durable 1.5.0 侧基准：常驻 Harness（open 一次）+ 每轮 root.submit。
// mock provider 用 pi-ai 1.5.0 的 createProvider + openAICompletionsApi 指到本地假模型；
// read 工具来自 createCodingTools（与 orbita 七件套里的 read 同源语义）。
// 用法（由 run-suite.mjs 驱动，Electron utility 进程或 node 直跑皆可）：
//   BENCH_SPEC=<json> DURABLE_ROOT=<durable-lab-2> node bench-du.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";
import { TURN_PROMPT, benchSpec, eldForTurn, emitter, idleMemory, memorySampler } from "./bench-lib.mjs";

const DURABLE_ROOT = process.env.DURABLE_ROOT;
if (!DURABLE_ROOT) throw new Error("需要环境变量 DURABLE_ROOT（pi-durable 1.5.0 的 lab 目录）");
const mod = (p) => import(pathToFileURL(resolvePkg(DURABLE_ROOT, p)).href);

const { BACKGROUND_CONTEXT } = await mod("@earendil-works/chord/context");
const { createModels, createProvider } = await mod("@earendil-works/pi-ai/models");
const { openAICompletionsApi } = await mod("@earendil-works/pi-ai/api/openai-completions.lazy");
const durable = await mod("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await mod("@earendil-works/pi-durable/storage/sqlite/node");
const { NodeExecutionEnv } = await mod("@earendil-works/pi-durable/env/node");
const { createCodingTools } = await mod("@earendil-works/pi-durable/tools");

const context = BACKGROUND_CONTEXT;
const spec = benchSpec();
const emit = emitter();
const mem = memorySampler();
const mode = spec.mode ?? "turns";

// —— 常驻部分：Harness / provider 包装（记录每次 stream 调用时刻）——
const models = createModels();
const api = openAICompletionsApi();
let firstStreamAt = 0; // 每轮重置；记本轮第一次 provider stream（lazyStream：首次调用即请求构建的起点）
const recordingApi = {
	stream: (m, c, o) => {
		if (firstStreamAt === 0) firstStreamAt = Date.now();
		return api.stream(m, c, o);
	},
	streamSimple: (m, c, o) => {
		if (firstStreamAt === 0) firstStreamAt = Date.now();
		return api.streamSimple(m, c, o);
	},
};
const provider = createProvider({
	id: "bench",
	name: "Bench Mock",
	baseUrl: spec.mockUrl,
	auth: { apiKey: { name: "bench", resolve: async () => ({ auth: { apiKey: "bench", baseUrl: spec.mockUrl } }) } },
	models: [{
		provider: "bench", id: "bench-model", name: "Bench Model", api: "openai-completions",
		baseUrl: spec.mockUrl,
		input: ["text", "image"], reasoning: false, contextWindow: 2_000_000, maxTokens: 32_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}],
	api: recordingApi,
});
models.setProvider(provider);

const registry = durable.createRegistry();
registry.install(createCodingTools());
const cwd = join(DURABLE_ROOT, "bench-cwd");
mkdirSync(cwd, { recursive: true });

async function openHarness(dbFile) {
	const harness = await durable.Harness.open(await openNodeSqliteStorage(dbFile), {
		models,
		registry,
		env: ({ cwd: c }) => new NodeExecutionEnv({ cwd: c ?? cwd }),
	}, context);
	const root = await harness.root(context, { agent: { model: { provider: "bench", modelId: "bench-model" }, cwd } });
	return { harness, root };
}

async function runTurn(root, tag) {
	const endEld = eldForTurn();
	emit({ type: "turnBegin", tag, at: Date.now() });
	firstStreamAt = 0;
	const settled = await (await root.submit({ type: "input", content: TURN_PROMPT(tag), requestId: tag }, context)).wait(context);
	if (settled.status !== "done") {
		const watch = await root.watch(context);
		const live = watch.value.docs?.["pi.live"] ?? {};
		emit({ type: "fatal", error: `settled=${settled.status} runFailure=${JSON.stringify(live.runFailure ?? null).slice(0, 600)} tools=${JSON.stringify((live.tools ?? []).map((s) => ({ name: s.name ?? s.call?.name, status: s.status, diagnostics: s.result?.diagnostics ?? s.diagnostics }))).slice(0, 800)}` });
		throw new Error(`settled=${settled.status}`);
	}
	if (firstStreamAt > 0) emit({ type: "stream", tag, at: firstStreamAt });
	const eld = endEld();
	const mu = process.memoryUsage();
	emit({
		type: "turnEnd", tag, at: Date.now(),
		rssMb: Math.round((mu.rss / 1048576) * 10) / 10, heapMb: Math.round((mu.heapUsed / 1048576) * 10) / 10, ...eld,
	});
}

try {
	if (mode === "turns") {
		const { harness, root } = await openHarness(spec.dbFile);
		harness.resume();
		emit({ type: "ready" });
		for (let i = 0; i < (spec.warmup ?? 1); i++) await runTurn(root, `${spec.tagPrefix}_w${i}`);
		for (let i = 0; i < spec.turns; i++) await runTurn(root, `${spec.tagPrefix}_t${i}`);
		await harness.close(context);
	} else {
		// 并发：一个 Harness、一个库一条会话，多库多会话同时开轮
		const opened = [];
		for (const s of spec.sessions) {
			const o = await openHarness(s.dbFile);
			o.harness.resume();
			opened.push(o);
		}
		emit({ type: "ready" });
		const waves = spec.waves ?? 3;
		for (let w = 0; w < waves; w++) {
			await Promise.all(opened.map((o, k) => runTurn(o.root, `${spec.tagPrefix}_w${w}_s${k}`)));
		}
		for (const o of opened) await o.harness.close(context);
	}
	emit({ type: "idle", ...(await idleMemory()) });
	emit({ type: "done", report: { side: "durable", mode, peak: mem.peak() } });
	mem.stop();
	process.exit(0);
} catch (error) {
	emit({ type: "fatal", error: String(error?.stack ?? error) });
	process.exit(1);
}
