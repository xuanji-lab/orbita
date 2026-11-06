// 压缩场景驱动：起 mock → 两侧各 compact() 一次/格 → 落 json。
// 用法：node run-compact.mjs --data <dir> --fixtures fb46e6be,8ee32d1b --runs 3 --label <名>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMock } from "./mock-llm.mjs";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : dflt;
};
const DATA = arg("data");
const OUT_DIR = process.env.OUT_DIR ?? join(DATA, "results");
const FIXTURES = arg("fixtures", "fb46e6be,8ee32d1b").split(",");
const RUNS = Number(arg("runs", 3));
const LABEL = arg("label", "compact");
const PORT = Number(arg("port", 5315));
const SUMMARY_MS = 2000;
mkdirSync(OUT_DIR, { recursive: true });

function run(side, spec) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "bench-compact.mjs"), side], {
			env: { ...process.env, BENCH_SPEC: JSON.stringify(spec) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buf = "";
		let err = "";
		child.stdout.on("data", (c) => (buf += c));
		child.stderr.on("data", (c) => (err += c));
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("compact 超时"));
		}, 10 * 60_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			let report = null;
			for (const line of buf.split("\n")) {
				if (line.startsWith("{")) {
					try {
						const ev = JSON.parse(line);
						if (ev.type === "done") report = ev.report;
						if (ev.type === "fatal") console.error(`  [${side}] FATAL ${ev.error.slice(0, 400)}`);
					} catch {}
				}
			}
			resolve({ report, code, stderr: err.slice(-2000) });
		});
		child.on("error", reject);
	});
}

const mock = await startMock({ port: PORT, toolFile: join(DATA, "tool-8k.txt"), summaryMs: SUMMARY_MS });
const results = { label: LABEL, cells: [] };
for (const fixture of FIXTURES) {
	for (let i = 0; i < RUNS; i++) {
		for (const side of ["ca", "du"]) {
			const spec = { mockUrl: `http://127.0.0.1:${PORT}/v1` };
			if (side === "ca") {
				const copy = join(DATA, "dbs", `${fixture}-cmp${i}.pi.jsonl`);
				writeFileSync(copy, readFileSync(join(DATA, "fixtures", fixture, "pi-session.jsonl")));
				spec.piFile = copy;
			} else {
				const src = join(DATA, "dbs", `${fixture}.sqlite`);
				const copy = join(DATA, "dbs", `${fixture}-cmp${i}.sqlite`);
				for (const suffix of ["", "-wal", "-shm"]) {
					const from = `${src}${suffix}`;
					if (existsSync(from)) writeFileSync(`${copy}${suffix}`, readFileSync(from));
				}
				spec.dbFile = copy;
			}
			const mark = mock.log.length;
			const t0 = Date.now();
			const { report, code, stderr } = await run(side, spec);
			const reqs = mock.log.slice(mark);
			const summaries = reqs.filter((q) => q.kind === "summary");
			// mock 的摘要路径固定睡 SUMMARY_MS；agent 侧耗时 = 总耗时 − 摘要数 × SUMMARY_MS
			const agentMs = report ? report.compactMs - summaries.length * SUMMARY_MS : null;
			results.cells.push({
				side, fixture, run: i, code, wallMs: Date.now() - t0,
				compactMs: report?.compactMs ?? null, agentMs,
				eldMaxMs: report?.eldMaxMs ?? null, eldP99Ms: report?.eldP99Ms ?? null,
				rssMb: report?.rssMb ?? null, peak: report?.peak ?? null,
				summaryCount: summaries.length, summaryMB: summaries[0] ? Math.round((summaries[0].bodyBytes / 1e6) * 100) / 100 : null,
				requestCount: reqs.length, summaryInfo: report?.summaryInfo ?? null,
				stderrTail: code !== 0 ? stderr.slice(-1200) : undefined,
			});
			console.log(`[${side} ${fixture} #${i}] code=${code} compact=${report?.compactMs ?? "?"}ms (agent侧≈${agentMs ?? "?"}ms) eldMax=${report?.eldMaxMs ?? "?"}ms summaries=${summaries.length}`);
			writeFileSync(join(OUT_DIR, `compact-${LABEL}.json`), JSON.stringify(results, null, 1));
		}
	}
}
await mock.close();
console.log("done");
