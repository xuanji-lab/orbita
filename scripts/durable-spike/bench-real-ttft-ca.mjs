// 真实模型 TTFT：coding-agent 0.84.3 侧。变体：
//   bare —— systemPromptOverride 置空 + defaultTools:[]（裸载荷）
//   full —— 默认（系统提示 ~2.6k token + pi 默认四件套工具，= 第一轮 bench-real-coding-agent 的配置）
// 用法：ZHIPU_KEY=<file> node bench-real-ttft-ca.mjs <bare|full>
// 输出一行 JSON：{variant, ttftAnyMs, ttftTextMs, totalMs, inTokens}
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";

const CA_ROOT = process.env.CA_ROOT;
const mod = (p) => import(pathToFileURL(resolvePkg(CA_ROOT, p)).href);
const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = await mod("@earendil-works/pi-coding-agent");

const variant = process.argv[2] ?? "full";
const KEY = readFileSync(process.env.ZHIPU_KEY, "utf8").trim();
const PROMPT = "用一句话说明 SQLite 的 WAL 模式是什么。";

if (variant === "nobeta") {
	// 变体 nobeta：ca-full 载荷，但出门前剥掉 anthropic-beta 头（检验头假设）
	const origFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
		if (url.includes("bigmodel")) {
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			if (headers.has("anthropic-beta")) {
				betaStripped = true;
				headers.delete("anthropic-beta");
				return origFetch(url, { ...init, headers, method: init?.method ?? (input instanceof Request ? input.method : "GET"), body: init?.body ?? (input instanceof Request ? input.body : undefined) });
			}
		}
		return origFetch(input, init);
	};
}

const cwd = await mkdtemp(join(tmpdir(), "ttft-ca-"));
const services = await createAgentSessionServices({
	cwd,
	resourceLoaderOptions: {
		noSkills: true,
		extensionFactories: variant === "bare"
			? [{
				name: "ttft-bare",
				hidden: true,
				factory: (pi) => {
					// 强制空系统提示：覆盖 resourceLoader 拼接的全部基底（含 append 段）
					pi.on("before_agent_start", () => ({ systemPrompt: "" }));
				},
				}]
			: [],
	},
});
services.settingsManager.applyOverrides({ retry: { maxRetries: 0, baseDelayMs: 1 } });
if (variant === "bare") services.settingsManager.applyOverrides({ defaultTools: [] });
services.modelRuntime.registerProvider("zhipu-coding", {
	name: "Zhipu Coding",
	baseUrl: "https://open.bigmodel.cn/api/anthropic",
	apiKey: KEY,
	api: "anthropic-messages",
	models: [{
		id: "glm-5.3-flash", name: "glm-5.3-flash", api: "anthropic-messages",
		reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 8192,
	}],
});
const resolved = services.modelRuntime.getModel("zhipu-coding", "glm-5.3-flash");
const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: resolved });

let ttftAny = -1;
let ttftText = -1;
let systemChars = 0;
let betaStripped = false;
const t0 = performance.now();
session.subscribe((event) => {
	if (event.type === "agent_start" || event.type === "turn_start") systemChars = session.systemPrompt?.length ?? 0;
	if ((event.type === "message_update" || event.type === "message_end") && event.message?.role === "assistant") {
		for (const block of event.message.content ?? []) {
			const body = block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : "";
			if (body !== "") {
				if (ttftAny < 0) ttftAny = performance.now() - t0;
				if (block.type === "text" && ttftText < 0) ttftText = performance.now() - t0;
			}
		}
	}
});
await session.prompt(PROMPT, { expandPromptTemplates: false });
const total = performance.now() - t0;
const stats = session.getSessionStats();
console.log(JSON.stringify({ side: "ca", variant, ttftAnyMs: Math.round(ttftAny), ttftTextMs: Math.round(ttftText), totalMs: Math.round(total), inTokens: stats.tokens.input, systemChars, betaStripped, out: stats.tokens.output }));
await session.dispose();
process.exit(0);
