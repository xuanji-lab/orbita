// TTFT 根因（第一步）：记录两侧实际发出的首个请求（headers + 完整 body），逐字段 diff。
// 起一个记录型 mock：收下请求 → 立即回一个极小的 SSE 完成（不睡不流，量不到模型侧），
// 每个请求把 headers 与 body 落盘。两侧各跑一轮（6df79261·end，同素材同 mock）。
// 用法：node capture-requests.mjs <ca|du> <fixtureDir> <outDir>
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [side, fixtureDir, outDir] = process.argv.slice(2);
if (!side || !fixtureDir || !outDir) {
	console.error("用法：node capture-requests.mjs <ca|du> <fixtureDir> <outDir>");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const PORT = 5390;

const requests = [];
const server = createServer((req, res) => {
	const parts = [];
	req.on("data", (c) => parts.push(c));
	req.on("end", () => {
		const body = Buffer.concat(parts);
		requests.push({ url: req.url, headers: req.headers, bodyBytes: body.length, bodyText: body.toString("utf8") });
		if (!req.url.includes("chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "bench-model" }] }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "b", object: "chat.completion.chunk", created: 0, model: "bench-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "b", object: "chat.completion.chunk", created: 0, model: "bench-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "b", object: "chat.completion.chunk", created: 0, model: "bench-model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const SCRIPTS = import.meta.dirname;
const env = {
	...process.env,
	CA_ROOT: process.env.CA_ROOT,
	DURABLE_ROOT: process.env.DURABLE_ROOT,
	BENCH_SPEC: JSON.stringify({
		mode: "turns", turns: 1, warmup: 0,
		mockUrl: `http://127.0.0.1:${PORT}/v1`,
		tagPrefix: "cap",
		...(side === "ca" ? { piFile: join(process.env.DATA, "dbs", "cap.pi.jsonl") } : { dbFile: join(process.env.DATA, "dbs", "cap.sqlite") }),
	}),
};
if (side === "ca") {
	const copy = join(process.env.DATA, "dbs", "cap.pi.jsonl");
	writeFileSync(copy, readFileSync(join(fixtureDir, "pi-session.jsonl")));
}
if (side === "du") {
	// 同一份历史：用 6df79261 迁移库的干净副本，保证 body 与 ca 侧同历史可 diff
	const src = join(process.env.DATA, "dbs", "6df79261.sqlite");
	const copy = join(process.env.DATA, "dbs", "cap.sqlite");
	for (const suffix of ["", "-wal", "-shm"]) {
		const from = `${src}${suffix}`;
		if (existsSync(from)) writeFileSync(`${copy}${suffix}`, readFileSync(from));
	}
}

const script = join(SCRIPTS, side === "ca" ? "bench-ca.mjs" : "bench-du.mjs");
const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (c) => (out += c));
child.stderr.on("data", (c) => (out += c));
await new Promise((resolve) => child.on("exit", resolve));

// 汇总：URL、headers（去掉 date 类噪音）、body 的结构化摘要 + 原文
const summary = requests.map((r, i) => {
	let parsed = null;
	try {
		parsed = JSON.parse(r.bodyText);
	} catch {}
	return {
		index: i,
		url: r.url,
		bodyBytes: r.bodyBytes,
		headers: { ...r.headers, date: undefined, "accept-encoding": undefined },
		bodyShape: parsed
			? {
					model: parsed.model,
					stream: parsed.stream,
					paramKeys: Object.keys(parsed).sort(),
					messageCount: parsed.messages?.length,
					messageRoles: parsed.messages?.map((m) => m.role),
					systemChars: JSON.stringify(parsed.messages?.find((m) => m.role === "system" || m.role === "developer") ?? null).length,
					toolCount: parsed.tools?.length,
					toolNames: parsed.tools?.map((t) => t.function?.name ?? t.name),
					toolsChars: JSON.stringify(parsed.tools ?? null).length,
					otherParams: Object.fromEntries(Object.entries(parsed).filter(([k]) => !["model", "stream", "messages", "tools"].includes(k))),
				}
			: null,
	};
});
writeFileSync(join(outDir, `capture-${side}.json`), JSON.stringify({ stdout: out.slice(-3000), summary }, null, 1));
for (const [i, r] of requests.entries()) {
	writeFileSync(join(outDir, `capture-${side}-req${i}-body.json`), r.bodyText);
}
console.log(`[${side}] ${requests.length} 个请求已落盘 → ${outDir}`);
console.log(JSON.stringify(summary.map((s) => ({ i: s.index, url: s.url, mb: (s.bodyBytes / 1e6).toFixed(2), msgs: s.bodyShape?.messageCount, tools: s.bodyShape?.toolNames ?? [] })), null, 1));
server.close();
process.exit(0);
