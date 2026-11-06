// coding-agent 0.84.3 侧基准（orbita 现路径）：每轮按 orbita runtime 的真实形态重建——
// createAgentSessionServices + SessionManager.open(整份 pi 本子) + createAgentSessionFromServices
// + prompt + dispose。量：每轮 turnBegin→首个请求到达 mock（submitToReq）、事件循环阻塞、
// 内存、工具往返开销（driver 侧从 mock 日志算）。
// 用法（由 run-suite.mjs 驱动）：BENCH_SPEC=<json> CA_ROOT=<orbita-spike worktree> node bench-ca.mjs
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";
import { TURN_PROMPT, benchSpec, eldForTurn, emitter, idleMemory, memorySampler } from "./bench-lib.mjs";

const CA_ROOT = process.env.CA_ROOT;
if (!CA_ROOT) throw new Error("需要环境变量 CA_ROOT（含 pi-coding-agent 0.84.3 node_modules 的目录）");
const mod = (p) => import(pathToFileURL(resolvePkg(CA_ROOT, p)).href);

const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = await mod("@earendil-works/pi-coding-agent");

const spec = benchSpec();
const emit = emitter();
const mem = memorySampler();
const mode = spec.mode ?? "turns";

/** 一轮（orbita runtime 的无状态循环：open → prompt → dispose） */
async function runTurn(piFile, cwd, tag) {
	const endEld = eldForTurn();
	emit({ type: "turnBegin", tag, at: Date.now() });
	const services = await createAgentSessionServices({
		cwd,
		resourceLoaderOptions: { noSkills: true, extensionFactories: [] },
	});
	// 对齐 orbita 的覆盖：不重试、七件套内建工具（决定 system prompt 形状）
	services.settingsManager.applyOverrides({
		retry: { maxRetries: 0, baseDelayMs: 1 },
		defaultTools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
	});
	services.modelRuntime.registerProvider("bench", {
		apiKey: "bench",
		baseUrl: spec.mockUrl,
		api: "openai-completions",
		models: [{
			id: "bench-model", name: "Bench Model", api: "openai-completions",
			input: ["text", "image"], reasoning: false, contextWindow: 2_000_000, maxTokens: 32_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	});
	const model = services.modelRuntime.getModel("bench", "bench-model");
	if (!model) throw new Error("bench-model 注册失败");
	const sessionManager = SessionManager.open(piFile, undefined, cwd);
	const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
	// 记录本轮第一次 provider 调用时刻（包装不改行为，同 orbita cc-billing 的包法）
	let streamed = false;
	const inner = session.agent.streamFunction;
	session.agent.streamFunction = (m, c, o) => {
		if (!streamed) {
			streamed = true;
			emit({ type: "stream", tag, at: Date.now() });
		}
		return inner(m, c, o);
	};
	await session.prompt(TURN_PROMPT(tag), { expandPromptTemplates: false });
	await session.dispose();
	const eld = endEld();
	const mu = process.memoryUsage();
	emit({ type: "turnEnd", tag, at: Date.now(), rssMb: Math.round((mu.rss / 1048576) * 10) / 10, heapMb: Math.round((mu.heapUsed / 1048576) * 10) / 10, ...eld });
}

try {
	const cwd = await mkdtemp(join(tmpdir(), "bench-ca-"));
	// 注：orbita 生产里 modelRuntime 是进程级单例，pi 包不导出其工厂；每轮往新 services 上注册
	// 对测量面（本子重读/上下文构建/序列化）无影响，报告已注明口径
	if (mode === "turns") {
		emit({ type: "ready" });
		for (let i = 0; i < (spec.warmup ?? 1); i++) await runTurn(spec.piFile, cwd, `${spec.tagPrefix}_w${i}`);
		for (let i = 0; i < spec.turns; i++) await runTurn(spec.piFile, cwd, `${spec.tagPrefix}_t${i}`);
	} else {
		// 并发：同一进程里多条会话同时开轮（orbita 的 running 表按 sessionId 并发）
		emit({ type: "ready" });
		const waves = spec.waves ?? 3;
		for (let w = 0; w < waves; w++) {
			await Promise.all(spec.sessions.map((s, k) => runTurn(s.piFile, cwd, `${spec.tagPrefix}_w${w}_s${k}`)));
		}
	}
	emit({ type: "idle", ...(await idleMemory()) });
	emit({ type: "done", report: { side: "coding-agent", mode, peak: mem.peak() } });
	mem.stop();
	process.exit(0);
} catch (error) {
	emit({ type: "fatal", error: String(error?.stack ?? error) });
	process.exit(1);
}
