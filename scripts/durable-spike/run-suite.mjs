// 总驱动：起 mock → 逐格 spawn 被测进程（coding-agent 走 node；durable 走 Electron utility）
// → 从 mock 日志 + 行协议算每轮指标 → 落 json + 打表。
//
// 用法：
//   node run-suite.mjs --data <durable-spike-data> --runs 3 --turns 5 \
//     --fixtures 6df79261,fb46e6be,8ee32d1b --sides ca,du --label mac-spike2
// 环境变量：
//   CA_ROOT      orbita-spike worktree（pi-coding-agent 0.84.3 的 node_modules）
//   DURABLE_ROOT durable-lab-2（pi-durable 1.5.0）
//   ELECTRON_BIN Electron 可执行文件（默认从 CA_ROOT/node_modules/electron 解析）
//   OUT_DIR      结果目录（默认 <data>/results）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startMock } from "./mock-llm.mjs";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : dflt;
};

const DATA = arg("data");
const SCRIPTS = import.meta.dirname;
const CA_ROOT = process.env.CA_ROOT;
const DURABLE_ROOT = process.env.DURABLE_ROOT;
const OUT_DIR = process.env.OUT_DIR ?? join(DATA, "results");
const RUNS = Number(arg("runs", 3));
const TURNS = Number(arg("turns", 5));
const FIXTURES = arg("fixtures", "6df79261,fb46e6be,8ee32d1b").split(",");
const SIDES = arg("sides", "ca,du").split(",");
const LABEL = arg("label", "run");
const PORT = Number(arg("port", 5310));
if (!DATA || !CA_ROOT || !DURABLE_ROOT) {
	console.error("需要 --data 与环境变量 CA_ROOT / DURABLE_ROOT（见 RUN.md）");
	process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

function electronBin() {
	if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN;
	const marker = join(CA_ROOT, "node_modules", "electron", "path.txt");
	if (!existsSync(marker)) throw new Error("找不到 electron：设 ELECTRON_BIN");
	const rel = readFileSync(marker, "utf8").trim();
	// mac 的 path.txt 已是完整相对路径（Electron.app/Contents/MacOS/Electron）；win 是 electron.exe
	return join(CA_ROOT, "node_modules", "electron", "dist", rel);
}

// 8KB 工具文件（两侧 read 同一份；口径同 bench/perf 的「每次读 8KB」）
const TOOL_FILE = join(DATA, "tool-8k.txt");
if (!existsSync(TOOL_FILE)) {
	writeFileSync(TOOL_FILE, `${"x".repeat(99)}\n`.repeat(80));
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};
const p95 = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length === 0 ? null : s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const stats = (xs) => {
	const clean = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
	return clean.length === 0 ? null : { n: clean.length, med: median(clean), p95: p95(clean), min: clean[0] === undefined ? null : Math.min(...clean), max: Math.max(...clean) };
};

/** 跑一个被测进程，收集行协议事件与进程退出码 */
function runSide(side, spec, extraEnv) {
	return new Promise((resolve, reject) => {
		const isElectron = side === "du" || process.env.FORCE_ELECTRON === "1";
		const cmd = isElectron ? electronBin() : process.execPath;
		const args = isElectron
			? [join(SCRIPTS, side === "ca" ? "elab2-main.cjs" : "elab2-main.cjs")]
			: [join(SCRIPTS, side === "ca" ? "bench-ca.mjs" : "bench-du.mjs")];
		const env = {
			...process.env,
			BENCH_SPEC: JSON.stringify(spec),
			CA_ROOT,
			DURABLE_ROOT,
			...(isElectron ? { BENCH_UTILITY: join(SCRIPTS, side === "ca" ? "bench-ca.mjs" : "bench-du.mjs") } : {}),
			...extraEnv,
		};
		const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		const events = [];
		let stderr = "";
		let buf = "";
		const t0 = Date.now();
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("{")) {
					if (line) console.log(`  [${side}] ${line.slice(0, 200)}`);
					continue;
				}
				try {
					const ev = JSON.parse(line);
					events.push(ev);
					if (ev.type === "fatal") console.error(`  [${side}] FATAL ${ev.error.slice(0, 600)}`);
				} catch {
					console.log(`  [${side}] ${line.slice(0, 200)}`);
				}
			}
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${side} 超时`));
		}, 15 * 60_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ events, code, stderr: stderr.slice(-4000), wallMs: Date.now() - t0 });
		});
		child.on("error", reject);
	});
}

/** 从 mock 日志 + 行协议事件合成每轮指标 */
function turnMetrics(events, mockLog, runTag) {
	const begins = new Map(events.filter((e) => e.type === "turnBegin").map((e) => [e.tag, e]));
	const streams = new Map(events.filter((e) => e.type === "stream").map((e) => [e.tag, e]));
	const ends = new Map(events.filter((e) => e.type === "turnEnd").map((e) => [e.tag, e]));
	const byTag = new Map();
	for (const q of mockLog) if (q.tag) byTag.set(q.tag, [...(byTag.get(q.tag) ?? []), q]);
	const rows = [];
	for (const [tag, begin] of begins) {
		const reqs = (byTag.get(tag) ?? []).sort((a, b) => a.arrivedAt - b.arrivedAt);
		const stream = streams.get(tag);
		const end = ends.get(tag);
		const first = reqs.find((q) => q.kind === "tool" || q.kind === "text");
		const gaps = reqs.slice(1).map((q, i) => q.arrivedAt - reqs[i].doneAt);
		rows.push({
			runTag,
			tag,
			warmup: /_w\d+$/.test(tag),
			submitToReqMs: first ? first.arrivedAt - begin.at : null,
			reqMB: first ? Math.round((first.bodyBytes / 1e6) * 100) / 100 : null,
			reqMessages: first?.messages ?? null,
			preStreamMs: stream ? stream.at - begin.at : null,
			wireMs: first && stream ? first.arrivedAt - stream.at : null,
			toolGapMs: gaps.length > 0 ? Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length) : null,
			turnMs: end ? end.at - begin.at : null,
			rssMb: end?.rssMb ?? null,
			heapMb: end?.heapMb ?? null,
			eldMaxMs: end?.eldMaxMs ?? null,
			eldP99Ms: end?.eldP99Ms ?? null,
		});
	}
	return rows;
}

async function main() {
	const mock = await startMock({ port: PORT, toolFile: TOOL_FILE, summaryMs: 2000 });
	const mockUrl = `http://127.0.0.1:${PORT}/v1`;
	const results = { label: LABEL, startedAt: new Date().toISOString(), env: { node: process.version, runs: RUNS, turns: TURNS, mockUrl }, cells: [] };
	console.log(`mock 起在 ${mockUrl}；fixtures=${FIXTURES.join(",")} sides=${SIDES.join(",")} runs=${RUNS} turns=${TURNS}`);

	if (SCENARIO === "concurrency") {
		// 并发场景：2–3 个大会话在同一 agent 进程里同时开轮（每 wave 一轮，共 waves 个 wave）
		for (let run = 0; run < RUNS; run++) {
			for (const side of SIDES) {
				const tagPrefix = `${side[0]}conc${run}_${createHash("sha1").update(`${side}conc${run}${Date.now()}`).digest("hex").slice(0, 4)}`.replaceAll("-", "_");
				const sessions = FIXTURES.map((fixture) => ({ fixture }));
				const spec = { mode: "concurrency", waves: Number(arg("waves", 3)), mockUrl, tagPrefix, sessions: [] };
				for (const fixture of FIXTURES) {
					if (side === "du") {
						const src = join(DATA, "dbs", `${fixture}.sqlite`);
						const copy = join(DATA, "dbs", `${fixture}-conc${run}.sqlite`);
						for (const suffix of ["", "-wal", "-shm"]) {
							const from = `${src}${suffix}`;
							if (existsSync(from)) writeFileSync(`${copy}${suffix}`, readFileSync(from));
						}
						spec.sessions.push({ dbFile: copy });
					} else {
						const copy = join(DATA, "dbs", `${fixture}-conc${run}.pi.jsonl`);
						writeFileSync(copy, readFileSync(join(DATA, "fixtures", fixture, "pi-session.jsonl")));
						spec.sessions.push({ piFile: copy });
					}
				}
				const mark = mock.log.length;
				const t0 = Date.now();
				const { events, code, stderr } = await runSide(side, spec);
				const rows = turnMetrics(events, mock.log.slice(mark), tagPrefix);
				const idle = events.find((e) => e.type === "idle");
				const done = events.find((e) => e.type === "done");
				results.cells.push({ side, fixture: `conc×${FIXTURES.length}`, run, code, wallMs: Date.now() - t0, turns: rows, idle, peak: done?.report?.peak ?? null, stderrTail: code !== 0 ? stderr.slice(-1500) : undefined });
				const measured = rows.filter((r) => !r.warmup);
				const s = stats(measured.map((r) => r.submitToReqMs));
				const rss = stats(measured.map((r) => r.rssMb));
				console.log(`[${side} conc run${run}] code=${code} turns=${measured.length} submitToReq med=${s?.med ?? "?"}ms rss med=${rss?.med ?? "?"}MB (wall ${(Date.now() - t0) / 1000 | 0}s)`);
				writeFileSync(join(OUT_DIR, `suite-${LABEL}.json`), JSON.stringify(results, null, 1));
			}
		}
		await finish(results, mock, [`${FIXTURES.length}并发`]);
		return;
	}

	for (const fixture of FIXTURES) {
		for (let run = 0; run < RUNS; run++) {
			for (const side of SIDES) {
				const tagPrefix = `${side[0]}${fixture.slice(0, 2)}${run}_${createHash("sha1").update(`${side}${fixture}${run}${Date.now()}`).digest("hex").slice(0, 4)}`.replaceAll("-", "_");
				const spec = {
					mode: "turns",
					turns: TURNS,
					warmup: 1,
					mockUrl,
					tagPrefix,
					...(side === "ca" ? { piFile: join(DATA, "fixtures", fixture, "pi-session.jsonl") } : { dbFile: join(DATA, "dbs", `${fixture}.sqlite`) }),
				};
				// 两侧素材都逐 run 隔离：每轮会往会话里追加（pi 本子 / SQLite 都会写）
				if (side === "du") {
					const src = join(DATA, "dbs", `${fixture}.sqlite`);
					const copy = join(DATA, "dbs", `${fixture}-run${run}.sqlite`);
					for (const suffix of ["", "-wal", "-shm"]) {
						const from = `${src}${suffix}`;
						if (existsSync(from)) {
							writeFileSync(`${copy}${suffix}`, readFileSync(from));
						}
					}
					spec.dbFile = copy;
				} else {
					const copy = join(DATA, "dbs", `${fixture}-run${run}.pi.jsonl`);
					writeFileSync(copy, readFileSync(join(DATA, "fixtures", fixture, "pi-session.jsonl")));
					spec.piFile = copy;
				}
				const mark = mock.log.length;
				const t0 = Date.now();
				const { events, code, stderr } = await runSide(side, spec);
				const rows = turnMetrics(events, mock.log.slice(mark), tagPrefix);
				const idle = events.find((e) => e.type === "idle");
				const done = events.find((e) => e.type === "done");
				results.cells.push({
					side, fixture, run, code, wallMs: Date.now() - t0,
					turns: rows, idle, peak: done?.report?.peak ?? null,
					stderrTail: code !== 0 ? stderr.slice(-1500) : undefined,
				});
				const measured = rows.filter((r) => !r.warmup);
				const s = stats(measured.map((r) => r.submitToReqMs));
				const rss = stats(measured.map((r) => r.rssMb));
				console.log(
					`[${side} ${fixture} run${run}] code=${code} turns=${measured.length} submitToReq med=${s?.med ?? "?"}ms p95=${s?.p95 ?? "?"}ms rss med=${rss?.med ?? "?"}MB (wall ${(Date.now() - t0) / 1000 | 0}s)`,
				);
				writeFileSync(join(OUT_DIR, `suite-${LABEL}.json`), JSON.stringify(results, null, 1));
			}
		}
	}
	await finish(results, mock, FIXTURES);
}

async function finish(results, mock, fixtureKeys) {
	const SIDES2 = [...new Set(results.cells.map((c) => c.side))];
	// 汇总表
	const summary = [];
	for (const side of SIDES2) {
		for (const fixture of fixtureKeys) {
			const rows = results.cells.filter((c) => c.side === side && c.fixture === fixture && c.code === 0).flatMap((c) => c.turns.filter((r) => !r.warmup));
			if (rows.length === 0) continue;
			summary.push({
				side, fixture, n: rows.length,
				submitToReqMs: stats(rows.map((r) => r.submitToReqMs)),
				preStreamMs: stats(rows.map((r) => r.preStreamMs)),
				wireMs: stats(rows.map((r) => r.wireMs)),
				toolGapMs: stats(rows.map((r) => r.toolGapMs)),
				turnMs: stats(rows.map((r) => r.turnMs)),
				reqMB: stats(rows.map((r) => r.reqMB)),
				eldMaxMs: stats(rows.map((r) => r.eldMaxMs)),
				eldP99Ms: stats(rows.map((r) => r.eldP99Ms)),
				rssMb: stats(rows.map((r) => r.rssMb)),
				heapMb: stats(rows.map((r) => r.heapMb)),
			});
		}
	}
	results.summary = summary;
	writeFileSync(join(OUT_DIR, `suite-${LABEL}.json`), JSON.stringify(results, null, 1));
	for (const s of summary) {
		console.log(`${s.side} ${s.fixture}: submitToReq med/p95 = ${s.submitToReqMs?.med}/${s.submitToReqMs?.p95}ms  toolGap=${s.toolGapMs?.med}ms  eldMax=${s.eldMaxMs?.med}ms  rss=${s.rssMb?.med}MB  req=${s.reqMB?.med}MB`);
	}
	await mock.close();
}

const SCENARIO = arg("scenario", "turns");
await main();
