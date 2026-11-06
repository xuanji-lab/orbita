// 真实模型 TTFT 驱动：四变体（ca-bare / du-bare / du-full / ca-full）交错 N 轮，每次新进程。
// 用法：CA_ROOT=… DURABLE_ROOT=… ZHIPU_KEY=<keyfile> node run-real-ttft.mjs [N] [out.json]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const N = Number(process.argv[2] ?? 4);
const OUT = process.argv[3] ?? join(process.env.DATA ?? ".", "real-ttft.json");
const SCRIPTS = import.meta.dirname;
const VARIANTS = ["ca:bare", "du:bare", "du:barebeta", "ca:full", "ca:nobeta", "du:full"];

function once(variant) {
	const [side, mode] = variant.split(":");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(SCRIPTS, `bench-real-ttft-${side}.mjs`), mode], {
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${variant} 超时`)); }, 120_000);
		child.on("exit", () => {
			clearTimeout(timer);
			let parsed = null;
			for (const line of out.split("\n")) {
				if (line.startsWith("{")) {
					try { parsed = JSON.parse(line); } catch {}
				}
			}
			resolve({ variant, ok: parsed !== null, result: parsed, stderr: err.slice(-500) });
		});
		child.on("error", reject);
	});
}

const rows = [];
for (let i = 0; i < N; i++) {
	for (const v of VARIANTS) {
		const r = await once(v);
		rows.push(r);
		console.log(`#${i + 1} ${r.variant}: ${r.ok ? JSON.stringify(r.result) : `FAIL ${r.stderr.slice(0, 200)}`}`);
		writeFileSync(OUT, JSON.stringify({ n: N, rows }, null, 1));
	}
}
const med = (xs) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const v of VARIANTS) {
	const rs = rows.filter((r) => r.variant === v && r.ok).map((r) => r.result);
	const any = rs.map((r) => r.ttftAnyMs ?? r.firstEventMs);
	console.log(`${v}: 首事件中位=${med(any)}ms (n=${rs.length})  total中位=${med(rs.map((r) => r.totalMs))}ms`);
}
