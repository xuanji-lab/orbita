// 两侧 bench 共用：stdout 行协议、内存采样、事件循环延迟（ELD）、提示词。
//
// 协议（driver 与被测进程之间，stdout 每行一个 JSON）：
//   {type:"ready"}                                            被测进程初始化完（不含会话打开）
//   {type:"turnBegin", tag, at}                               一轮开始（= agent 进程收到本轮命令）
//   {type:"stream", tag, at}                                  本轮第一次调 provider stream（发请求构建完成前）
//   {type:"turnEnd", tag, at, rssMb, heapMb, eldMaxMs, eldP99Ms} 一轮 settled + dispose 完成
//   {type:"idle", rssMb, heapMb}                              显式 GC 后的驻留
//   {type:"done", report}                                     全部完成，随后 exit 0
// driver 用 mock 的请求日志（同机 Date.now 同钟）按 tag 对齐算：
//   submitToReq = 该 tag 首个请求 arrivedAt - turnBegin.at
//   toolGap     = 相邻请求 arrivedAt[i+1] - doneAt[i]（本轮内）
//   preStream   = stream.at - turnBegin.at；wireMs = arrivedAt - stream.at
import { monitorEventLoopDelay } from "node:perf_hooks";

export const TURN_PROMPT = (tag) => `bench turn tokens=300 rate=50 ttft=300 tool=2 bench-session=${tag}`;

export function emitter(write = process.stdout.write.bind(process.stdout)) {
	return (obj) => write(`${JSON.stringify(obj)}\n`);
}

/** 每 250ms 采样一次 rss/heap（口径对齐 bench/perf 的 app.getAppMetrics 工作集采样） */
export function memorySampler() {
	let peakRss = 0;
	let peakHeap = 0;
	const timer = setInterval(() => {
		const mu = process.memoryUsage();
		if (mu.rss > peakRss) peakRss = mu.rss;
		if (mu.heapUsed > peakHeap) peakHeap = mu.heapUsed;
	}, 250);
	timer.unref?.();
	return {
		peak: () => ({ rssMb: roundMb(peakRss), heapMb: roundMb(peakHeap) }),
		stop: () => clearInterval(timer),
	};
}

/** 每轮一个直方图：enable 于 turnBegin、disable 于 turnEnd（减掉 10ms 分辨率，同 bench/perf） */
export function eldForTurn() {
	const h = monitorEventLoopDelay({ resolution: 10 });
	h.enable();
	return () => {
		h.disable();
		const out = { eldMaxMs: Math.round((h.max / 1e6 - 10) * 10) / 10, eldP99Ms: Math.round((h.percentile(99) / 1e6 - 10) * 10) / 10 };
		h.reset();
		return out;
	};
}

export const roundMb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** 显式 GC 后的驻留内存（没开 --expose-gc 时尽力：等两拍让 GC 收尾） */
export async function idleMemory() {
	if (typeof globalThis.gc === "function") {
		globalThis.gc();
		await new Promise((r) => setTimeout(r, 800));
		globalThis.gc();
		await new Promise((r) => setTimeout(r, 400));
	}
	const mu = process.memoryUsage();
	return { rssMb: roundMb(mu.rss), heapMb: roundMb(mu.heapUsed) };
}

export function benchSpec() {
	const raw = process.env.BENCH_SPEC;
	if (!raw) throw new Error("需要环境变量 BENCH_SPEC（JSON）");
	return JSON.parse(raw);
}
