// Windows 专项探针（Mac 上也能跑，作对照）：
//  1. durable NodeExecutionEnv 选中了哪个 shell
//  2. bash 命令超时 / 中止后，有没有残留的 sleep 子进程（pi 0.84.3 在 Windows 上会留 Git Bash 的 sleep.exe）
//  3. 路径换算：Git Bash 风格 /c/... 、正反斜杠、~、file:// 被换成什么
// 用法：DURABLE_ROOT=<durable-lab-2> node win-probe.mjs [输出 json 路径]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";

const DURABLE_ROOT = process.env.DURABLE_ROOT;
if (!DURABLE_ROOT) throw new Error("需要环境变量 DURABLE_ROOT");
const mod = (p) => import(pathToFileURL(resolvePkg(DURABLE_ROOT, p)).href);
const { BACKGROUND_CONTEXT, withAbortSignal } = await mod("@earendil-works/chord/context");
const { NodeExecutionEnv } = await mod("@earendil-works/pi-durable/env/node");

const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前机器上名为 sleep 的进程个数（Windows 看 sleep.exe） */
function countSleep() {
	if (isWin) {
		const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq sleep.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
		return out.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith('"sleep.exe"')).length;
	}
	const out = execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" });
	return out.split("\n").filter((l) => l.trim().endsWith("sleep")).length;
}

const env = new NodeExecutionEnv({ cwd: tmpdir() });
const result = { platform: process.platform, node: process.version, electron: process.versions.electron ?? null, cases: {} };

// 1. shell
{
	let stdout = "";
	const r = await env.exec("echo \"shell=$0\"; uname -s 2>/dev/null || echo no-uname", { onOutput: (text) => { stdout += text; } }, BACKGROUND_CONTEXT);
	result.shell = r.ok ? { exitCode: r.value.exitCode, stdout: stdout.trim() } : { error: String(r.error?.message ?? r.error) };
}

async function residueCase(name, run) {
	const before = countSleep();
	const t0 = Date.now();
	const r = await run();
	const returnedMs = Date.now() - t0;
	await sleep(3000);
	const after = countSleep();
	result.cases[name] = {
		returnedMs,
		ok: r.ok,
		error: r.ok ? null : `${r.error?.code ?? ""} ${r.error?.message ?? ""}`.trim(),
		sleepBefore: before,
		sleepAfter3s: after,
		residue: after - before,
	};
	console.log(name, JSON.stringify(result.cases[name]));
}

// 2a. 超时：前台 sleep
await residueCase("timeout-fg", () => env.exec("sleep 30; echo done", { timeout: 2 }, BACKGROUND_CONTEXT));
// 2b. 超时：后台子进程 + wait（更像真实的 dev server / 并行命令）
await residueCase("timeout-bg-wait", () => env.exec("sleep 31 & sleep 32 & wait", { timeout: 2 }, BACKGROUND_CONTEXT));
// 2c. 用户中止（abort）
await residueCase("abort", () => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(new Error("bench abort")), 2000);
	return env.exec("sleep 33; echo done", undefined, withAbortSignal(ac.signal, BACKGROUND_CONTEXT));
});

// 3. 路径换算
const home = homedir();
const drive = isWin ? home.slice(0, 2) : "";
const samples = isWin
	? [`${home}\\Desktop`, home.replaceAll("\\", "/") + "/Desktop", `/${drive[0].toLowerCase()}${home.slice(2).replaceAll("\\", "/")}/Desktop`, "~/Desktop", "~\\Desktop", "sub\\dir", "sub/dir", pathToFileURL(`${home}\\Desktop`).href, "/tmp/x"]
	: [`${home}/Desktop`, "~/Desktop", "sub/dir", pathToFileURL(`${home}/Desktop`).href, "/tmp/x"];
result.paths = [];
for (const p of samples) {
	const r = await env.absolutePath(p, BACKGROUND_CONTEXT);
	result.paths.push({ input: p, output: r.ok ? r.value : `ERR ${r.error?.message}` });
}
console.log(JSON.stringify(result.paths, null, 1));

await env.cleanup(BACKGROUND_CONTEXT);
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ shell: result.shell, residue: Object.fromEntries(Object.entries(result.cases).map(([k, v]) => [k, v.residue])) }));
