// Orbita 性能测量驱动：生产构建 + 假模型 + 真实长会话快照，按进程分开量「切会话 / 跑一轮 / 流式时打字 / 空闲」。
// Mac 与 Windows 同一份（平台差异都在本文件里，搜 IS_WIN）。用法见 scripts/bench/README.md：
//   node scripts/bench/bench.mjs --fixture <fixture-6df79261.zip> [--turns 10,30,60,100] [--runs 5] [--label mac] [--no-build]
//
// 不改应用代码，三个进程都从外面接：
// - renderer：--remote-debugging-port（CDP），页面里挂 longtask / event timing / rAF 观察器；
// - 主进程与 agent 进程：NODE_OPTIONS=--inspect=0，每个 Node 进程自己开一个 inspector（端口由系统给），
//   从启动日志的「Debugger listening on ws://…」读出来，再按 process.type 与 argv 里的 agent-runtime.js 认人；
// - CPU 秒用主进程 app.getAppMetrics() 的 cumulativeCPUUsage 求差（percentCPUUsage 在 Mac 上严重偏低，spike 实测）。
// 窗口必须一直看得见：被盖住 / 最小化时 rAF 不跑，帧数为 0 的那次会被标出来。脚本不去动窗口层级。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { step, watchdog } from "../cdp.mjs";
import { extractFixture, loadFixture, seedInstance, tickSizes } from "./fixture.mjs";
import { startMock } from "./mock-llm.mjs";
import { renderMarkdown, summarize } from "./report.mjs";

const IS_WIN = process.platform === "win32";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 参数 ——
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const FIXTURES = argv.flatMap((a, i) => (a === "--fixture" ? [argv[i + 1]] : []));
if (FIXTURES.length === 0) {
  console.error("用法：node scripts/bench/bench.mjs --fixture <zip 或目录> [--fixture …] [--ticks 6df79261=10,60;fb46e6be=pre4,end] [--runs 5] [--runs-big 3] [--compact-reps 3] [--actions switch,idle,turn,type,compact] [--label 名字] [--no-build]");
  process.exit(1);
}
// 每个素材跑哪些刻度：--ticks 里给了就听它，否则用素材 manifest 的 defaultTicks
const TICKS = Object.fromEntries((opt("ticks", "") || "").split(";").filter(Boolean).map((s) => { const [k, v] = s.split("="); return [k, v.split(",")]; }));
const RUNS = Number(opt("runs", 5));
// 大会话（会话文件 > 30 MB）每格的次数：一轮要十几秒，5 次 × 很多格在慢机器上太久
const RUNS_BIG = Number(opt("runs-big", 3));
// 压缩场景重复几次（每次一个新实例：压过一次的会话就不是同一个起点了）；0 = 不跑
const COMPACT_REPS = Number(opt("compact-reps", 3));
// 跑哪些动作：「switch,turn」对全部素材；「6df79261=switch,turn」只改这个素材，其余照默认全跑（可用 ; 写多个）
const ALL_ACTIONS = "switch,idle,turn,type,compact";
const ACTION_SPEC = opt("actions", ALL_ACTIONS);
const actionsFor = (fixture) => {
  if (!ACTION_SPEC.includes("=")) return new Set(ACTION_SPEC.split(","));
  const hit = ACTION_SPEC.split(";").map((s) => s.split("=")).find(([k]) => k === fixture);
  return new Set((hit?.[1] ?? ALL_ACTIONS).split(","));
};
const LABEL = opt("label", `${os.hostname()}`);
const WORK = resolve(opt("work", join(os.tmpdir(), "orbita-bench")));
const OUT = resolve(opt("out", join(REPO, "bench-results")));
watchdog(Number(opt("watchdog-min", 90)) * 60_000);

// —— 端口：只在 5300–5399（假模型）与 39300–39399（CDP）里挑；Windows 先躲开系统保留段（同 try-pr.ps1）——
function excludedRanges() {
  if (!IS_WIN) return [];
  const text = execFileSync("netsh", ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"], { encoding: "utf8" });
  return [...text.matchAll(/^\s*(\d+)\s+(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
}
const canBind = (port) => new Promise((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(port, "127.0.0.1", () => s.close(() => ok(true))); });
async function pickPort(from, to) {
  const ex = excludedRanges();
  for (let p = from; p <= to; p++) if (p !== 5273 && !ex.some(([a, b]) => p >= a && p <= b) && (await canBind(p))) return p;
  throw new Error(`${from}-${to} 内没有可用端口`);
}

// —— 机器身份证（全是只读查询）——
function sh(cmd, args) { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
const ps = (expr) => sh("powershell", ["-NoProfile", "-Command", expr]);
function machineInfo() {
  return {
    hostname: os.hostname(),
    model: IS_WIN ? ps("$c=Get-CimInstance Win32_ComputerSystem; \"$($c.Manufacturer) $($c.Model)\"") : sh("sysctl", ["-n", "hw.model"]),
    cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30),
    os: IS_WIN ? `${os.version()} ${os.release()}` : `macOS ${sh("sw_vers", ["-productVersion"])} (${os.release()})`,
    defender: IS_WIN ? ps("(Get-MpComputerStatus).RealTimeProtectionEnabled") : undefined,
    power: IS_WIN ? ps("powercfg /getactivescheme") : undefined,
  };
}

// —— 最小 CDP / inspector 客户端（每条命令都有时限；scripts/cdp.mjs 按 dev 端口认页面，生产包是 file:// 用不上）——
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error(`连不上 ${wsUrl}`)); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } };
  const send = (method, params = {}, ms = 30_000) => new Promise((ok, bad) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); bad(new Error(`${method} 超过 ${ms} ms 没回`)); }, ms);
    pending.set(i, (msg) => { clearTimeout(t); msg.error ? bad(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression, ms) => {
    if (process.env.BENCH_DEBUG) console.error(`[eval] ${expression.slice(0, 70).replace(/\s+/g, " ")}`);
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json();

// —— 起停 ——
function electronBinary() { return createRequire(join(REPO, "package.json"))("electron"); }
function launch({ userData, cdpPort, logFile }) {
  const env = { ...process.env, NODE_OPTIONS: "--inspect=0", ORBITA_AGENT_INSPECT: "1", ORBITA_INSPECT_FILE: join(userData, "agent-inspector.url") };
  delete env.ELECTRON_RENDERER_URL; // 从 dev 实例的终端里跑时会继承它；未打包的 electron . 会去连 dev server
  const child = spawn(electronBinary(), [REPO, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  const inspectors = [];
  let log = "";
  const onData = (d) => { const s = d.toString(); log += s; for (const m of s.matchAll(/Debugger listening on (ws:\/\/\S+)/g)) inspectors.push(m[1]); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", () => writeFileSync(logFile, log));
  return { child, inspectors, inspectFile: join(userData, "agent-inspector.url"), flushLog: () => writeFileSync(logFile, log) };
}
async function stop(child) {
  if (child.exitCode !== null) return;
  // 只按自己记下的 PID 停，不按进程名杀（AGENTS.md 陷阱史 #2）；Windows 要连子进程树一起
  if (IS_WIN) sh("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(200);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

// —— 探针脚本（注入，不改应用代码）——
const MAIN_PROBE = `(() => {
  const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
  const { app, BrowserWindow } = require('electron');
  const wc = BrowserWindow.getAllWindows().map(w => w.webContents).find(c => c.getURL().endsWith('index.html'));
  const b = globalThis.__bench = { h: monitorEventLoopDelay({ resolution: 10 }), rendererPid: wc.getOSProcessId(), samples: [] };
  b.sample = () => b.samples.push(app.getAppMetrics().map(x => ({ pid: x.pid, type: x.type, cum: x.cpu.cumulativeCPUUsage, ws: x.memory.workingSetSize })));
  b.begin = () => { b.samples = []; b.h.reset(); b.h.enable(); b.sample(); b.timer = setInterval(b.sample, 250); return 1; };
  b.end = () => { clearInterval(b.timer); b.sample(); b.h.disable(); return { samples: b.samples, eldP99: b.h.percentile(99) / 1e6 - 10, eldMax: b.h.max / 1e6 - 10, mainPid: process.pid, rendererPid: b.rendererPid }; };
  return b.rendererPid;
})()`;
const AGENT_PROBE = `(() => {
  const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
  const b = globalThis.__bench = { h: monitorEventLoopDelay({ resolution: 10 }), heap: 0 };
  b.begin = () => { b.h.reset(); b.h.enable(); b.heap = 0; b.timer = setInterval(() => { b.heap = Math.max(b.heap, process.memoryUsage().heapUsed); }, 200); return 1; };
  b.end = () => { clearInterval(b.timer); b.h.disable(); return { eldP99: b.h.percentile(99) / 1e6 - 10, eldMax: b.h.max / 1e6 - 10, heapPeak: b.heap }; };
  return process.pid;
})()`;
const RENDERER_PROBE = `(() => {
  const b = window.__bench = { long: [], ev: [], gaps: [], on: false, last: 0 };
  new PerformanceObserver((l) => { if (b.on) b.long.push(...l.getEntries().map(e => e.duration)); }).observe({ type: 'longtask' });
  new PerformanceObserver((l) => { if (b.on) b.ev.push(...l.getEntries().filter(e => e.interactionId > 0).map(e => [e.interactionId, e.duration])); }).observe({ type: 'event', durationThreshold: 16 });
  const tick = (t) => { if (!b.on) return; b.gaps.push(t - b.last); b.last = t; requestAnimationFrame(tick); };
  b.begin = () => { b.long = []; b.ev = []; b.gaps = []; b.on = true; b.last = performance.now(); requestAnimationFrame(tick); return 1; };
  b.end = () => { b.on = false; const g = b.gaps.slice(1).sort((x, y) => x - y);
    return { long: b.long, ev: b.ev, frames: g.length, p95: g[Math.floor(g.length * 0.95)] ?? null, over50: g.filter(x => x > 50).length, visible: document.visibilityState }; };
  return 1;
})()`;

/** 一个实例里的全部连接 + 每个动作前后的 begin / end */
async function attach(app, cdpPort) {
  step("等三个进程的调试口");
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    page = (await getJson(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => [])).find((t) => t.type === "page" && /\/index\.html$/.test(t.url));
  }
  if (!page) throw new Error("60 秒内没等到主窗口（CDP 上没有 index.html 页面）");
  const r = await connect(page.webSocketDebuggerUrl);
  const ready = async () => {
    for (let i = 0; i < 120; i++) {
      if (await r.evaluate(`document.body?.innerText.includes('bench-home') ?? false`).catch(() => false)) return;
      await sleep(500);
    }
    throw new Error("60 秒内侧栏没出现 bench-home");
  };
  // 等界面加载完再接 Node 进程：实测 agent 进程启动后 1 秒内就挂上 inspector 执行表达式，
  // 会报 Promise was collected、随后进程退出；等它加载完就没事（原因未查清，推断是打断了启动期）
  await ready();
  await sleep(3000);
  let main = null, agent = null;
  const seen = new Set();
  for (let i = 0; i < 60 && !(main && agent); i++) {
    for (const url of app.inspectors) {
      if (seen.has(url)) continue;
      seen.add(url);
      // 短命的 utility 进程（起来干完就退）问到一半会报 Promise was collected：跳过
      const c = await connect(url).catch(() => null);
      const who = await c?.evaluate(`JSON.stringify({ type: process.type, argv: process.argv.join(' ') })`, 5000).then(JSON.parse).catch((e) => { if (process.env.BENCH_DEBUG) console.error(`[inspector] ${url} 问不到：${e.message}`); return null; });
      if (!c || !who) { c?.close(); continue; }
      if (process.env.BENCH_DEBUG) console.error(`[inspector] ${url} ${who.type} ${who.argv.slice(-60)}`);
      if (who.type === "browser") main = c;
      else if (/agent-runtime\.js/.test(who.argv)) agent = c;
      else c.close();
    }
    if (!agent) {
      // agent 进程是懒启动（第一次真请求才 fork），测量里经 renderer 显式触发一次目录请求
      // （providerBuiltins → listBuiltins → ensure）；Windows 的 utilityProcess stderr 不保证
      // 进实例日志，同时轮询 runtime 自己写的 inspector URL 文件兜底。
      await r.evaluate(`window.orbita.provider.builtins().catch(() => {})`).catch(() => {});
      try {
        const u = readFileSync(app.inspectFile, "utf8").trim();
        if (u.startsWith("ws://") && !app.inspectors.includes(u)) app.inspectors.push(u);
      } catch {}
    }
    if (!(main && agent)) await sleep(500);
  }
  if (!main) throw new Error("没接上主进程 inspector（NODE_OPTIONS=--inspect=0 没生效？看实例日志）");
  if (!agent) throw new Error("没接上 agent 进程 inspector");
  // 密钥用本机 safeStorage 现加密（Mac 钥匙串 / Windows DPAPI），不借别的实例的密文。
  // renderer 启动时已按「没有密钥」缓存了 provider 列表（发不出消息），写完刷新一次页面
  await main.evaluate(`(() => { const { safeStorage, app } = require('electron'); const fs = require('node:fs');
    fs.writeFileSync(require('node:path').join(app.getPath('userData'), 'secrets.json'), JSON.stringify({ 'bench-key': safeStorage.encryptString('bench').toString('base64') })); return 1; })()`);
  await r.send("Page.reload");
  await sleep(1000);
  await ready();
  await sleep(1500);
  await r.send("Performance.enable");
  await r.send("Page.bringToFront");
  await r.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return { r, main, agent };
}

async function installProbes(c) {
  const rendererPid = await c.main.evaluate(MAIN_PROBE);
  const agentPid = await c.agent.evaluate(AGENT_PROBE);
  await c.r.evaluate(RENDERER_PROBE);
  return { rendererPid, agentPid };
}

async function begin(c) { await Promise.all([c.main.evaluate("__bench.begin()"), c.agent.evaluate("__bench.begin()"), c.r.evaluate("__bench.begin()")]); }

/** 收数：每个进程一组扁平指标（CPU 秒 = cumulativeCPUUsage 求差；工作集按 250 ms 采样取峰值） */
async function end(c, pids) {
  const [m, a, rr] = await Promise.all([c.main.evaluate("__bench.end()"), c.agent.evaluate("__bench.end()"), c.r.evaluate("__bench.end()")]);
  const heap = (await c.r.send("Performance.getMetrics")).metrics.find((x) => x.name === "JSHeapUsedSize").value;
  const first = m.samples[0], last = m.samples.at(-1);
  const proc = (match) => {
    const p0 = first.filter(match), p1 = last.filter(match);
    if (p1.length === 0) return { cpuS: null, wsPeakMB: null, wsMB: null };
    const cpuS = p1.reduce((s, p) => s + p.cum - (p0.find((q) => q.pid === p.pid)?.cum ?? p.cum), 0);
    const wsAt = (sample) => sample.filter(match).reduce((s, p) => s + p.ws, 0) / 1024;
    return { cpuS, wsPeakMB: Math.max(...m.samples.map(wsAt)), wsMB: wsAt(last) };
  };
  const flat = (prefix, o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${prefix}.${k}`, v]));
  const keys = [...new Map(rr.ev.map(([id, d]) => [id, d])).keys()];
  return {
    ...flat("main", { ...proc((p) => p.pid === m.mainPid), eldP99: m.eldP99, eldMax: m.eldMax }),
    ...flat("r", { ...proc((p) => p.pid === pids.rendererPid), longN: rr.long.length, longSum: rr.long.reduce((s, x) => s + x, 0), longMax: Math.max(0, ...rr.long), frames: rr.frames, p95: rr.p95, over50: rr.over50, heapMB: heap / 1e6 }),
    ...flat("agent", { ...proc((p) => p.pid === pids.agentPid), eldP99: a.eldP99, eldMax: a.eldMax, heapPeakMB: a.heapPeak / 1e6 }),
    ...flat("gpu", proc((p) => p.type === "GPU")),
    _events: rr.ev, _eventInteractions: keys.length, _visible: rr.visible,
  };
}

// —— 页面操作 ——
/** 侧栏里标题恰好是 title 的那一行，用真鼠标点（走完整输入管线）；点之前装好「何时静止」的观察器 */
async function clickRow(r, title) {
  const box = await r.evaluate(`(() => {
    const el = [...document.querySelectorAll('button,[role=button],a')].filter(e => e.textContent.trim() === ${JSON.stringify(title)}).pop();
    if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!box) throw new Error(`侧栏里找不到「${title}」`);
  await r.evaluate(`(() => { const s = window.__settle = { t0: 0, last: 0, n: 0 };
    s.mo = new MutationObserver(() => { s.last = performance.now(); s.n++; }); s.mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    addEventListener('mousedown', () => { s.t0 = performance.now(); }, { once: true, capture: true }); return 1; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await r.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  // 静止 = 点击后有过 DOM 变化，且 500 ms 内不再变；返回最后一次变化距点击多久。
  // 点的是已经打开的那行时 DOM 不会变：3 秒没变化就返回 null
  return r.evaluate(`new Promise((ok) => { const s = window.__settle; const t = performance.now(); const iv = setInterval(() => {
    const now = performance.now();
    if (s.n > 0 && now - s.last > 500) { clearInterval(iv); s.mo.disconnect(); ok(Math.round(s.last - (s.t0 || t))); }
    else if (s.n === 0 && now - t > 3000) { clearInterval(iv); s.mo.disconnect(); ok(null); } }, 50); })`, 60_000);
}

/** 输入框里写入提示词并回车。返回回车那一刻（Date.now，与假模型同钟）与首字上屏的 promise */
async function submit(r, prompt) {
  await r.evaluate(`document.querySelector('textarea.composer-input').focus()`);
  await r.send("Input.insertText", { text: prompt });
  const typed = await r.evaluate(`document.querySelector('textarea.composer-input').value`);
  if (!typed.includes("tokens=")) throw new Error(`输入框没收到文字：${typed}`);
  await r.evaluate(`(() => { const f = window.__first = {}; f.p = new Promise((ok) => { const mo = new MutationObserver((ms) => { for (const m of ms) {
    const txt = m.type === 'characterData' ? m.target.data : [...m.addedNodes].map(n => n.textContent).join('');
    if (/qzv/.test(txt ?? '')) { mo.disconnect(); ok(Date.now()); return; } } }); mo.observe(document.body, { childList: true, subtree: true, characterData: true }); }); return 1; })()`);
  const t0 = Date.now();
  await r.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await r.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  return { t0, first: () => r.evaluate("window.__first.p", 120_000) };
}

/** 等假模型把这一轮的正文流完（kind = text 的请求有了 doneAt） */
async function waitTurnDone(mock, t0) {
  for (let i = 0; i < 1800; i++) {
    const reqs = mock.log.filter((q) => q.arrivedAt >= t0 && q.hasTools);
    if (reqs.some((q) => q.kind === "text" && q.doneAt)) return reqs;
    await sleep(100);
  }
  throw new Error("3 分钟内这一轮没跑完");
}

const TURN_PROMPT = "bench turn tokens=300 rate=50 ttft=300 tool=2";
const TYPE_PROMPT = "bench type tokens=400 rate=50 ttft=300 tool=0";
const KEYS = "the quick brown fox jumps over a lazy dog ";

async function actionSwitch(c, pids, title) {
  await clickRow(c.r, "bench-home");
  await sleep(1000);
  await begin(c);
  const settleMs = await clickRow(c.r, title);
  await sleep(1000);
  return { settleMs, ...(await end(c, pids)) };
}

async function actionIdle(c, pids) {
  await begin(c);
  await sleep(8000);
  return end(c, pids);
}

async function actionTurn(c, pids, mock) {
  await begin(c);
  const { t0, first } = await submit(c.r, TURN_PROMPT);
  const tFirst = await first();
  const reqs = await waitTurnDone(mock, t0);
  await sleep(1500);
  const m = await end(c, pids);
  const gaps = reqs.slice(1).map((q, i) => q.arrivedAt - reqs[i].doneAt);
  return {
    enterToReqMs: reqs[0].arrivedAt - t0, reqMB: reqs[0].bodyBytes / 1e6, reqMessages: reqs[0].messages,
    toolGapMs: gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : null, firstTokenMs: tFirst - t0,
    // 应当恒为 0；非 0 说明这一轮意外触发了压缩（例如压缩后的预检又压了一次）
    summaryN: mock.log.filter((q) => q.arrivedAt >= t0 && q.kind === "summary").length, ...m,
  };
}

async function actionType(c, pids, mock) {
  await begin(c);
  const { t0, first } = await submit(c.r, TYPE_PROMPT);
  await first();
  // 只统计打字这段的交互：丢掉前面回车那一下
  await c.r.evaluate(`(() => { window.__bench.ev = []; document.querySelector('textarea.composer-input').focus(); return 1; })()`);
  for (const ch of KEYS) {
    const code = ch === " " ? "Space" : `Key${ch.toUpperCase()}`;
    await c.r.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await c.r.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await sleep(100);
  }
  await waitTurnDone(mock, t0);
  await sleep(1000);
  const m = await end(c, pids);
  // 核对按键真的落进了输入框（没落进去的话下面的延迟是空转）
  const typedChars = await c.r.evaluate(`document.querySelector('textarea.composer-input').value.length`);
  // 清空输入框（React 受控组件：走原生 setter + input 事件）
  await c.r.evaluate(`(() => { const el = document.querySelector('textarea.composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  // event timing 只上报 ≥16 ms 的事件：没上报的按键记 16（即「不超过一帧」）
  const per = new Map();
  for (const [id, d] of m._events) per.set(id, Math.max(per.get(id) ?? 0, d));
  const lat = [...per.values()];
  while (lat.length < KEYS.length) lat.push(16); // 一个按键（keydown + keyup）是一次交互
  lat.sort((a, b) => a - b);
  if (typedChars < KEYS.length) throw new Error(`只有 ${typedChars}/${KEYS.length} 个字符落进输入框`);
  return { typedChars, keyP95: lat[Math.floor(lat.length * 0.95)], keyMax: lat.at(-1), keyOver50: lat.filter((x) => x > 50).length, ...m };
}

const COMPACT_PROMPT = "bench compact tokens=300 rate=50 ttft=300 tool=2 ctx=1700000";

/** 会话文件从 offset 起新增的内容里有没有压缩界碑（只读新增部分：不为探测去整读 145 MB） */
function newMarker(file, offset) {
  const size = statSync(file).size;
  if (size <= offset) return false;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString("utf8").includes('"role":"compacted"');
  } finally {
    closeSync(fd);
  }
}

/**
 * 触发一次自动压缩：这一轮的正文回复报 ctx=1700000，超过 200 万窗口的 80%，pi 在轮末压缩。
 * 量这一整段（回车 → 界碑落盘 + 1.5 s）的各进程数，再拆出压缩本身的几段时间。
 */
async function actionCompact(c, pids, mock, sessionFile) {
  const offset = statSync(sessionFile).size;
  await begin(c);
  const { t0, first } = await submit(c.r, COMPACT_PROMPT);
  const tFirst = await first();
  const reqs = await waitTurnDone(mock, t0);
  const textDone = reqs.find((q) => q.kind === "text").doneAt;
  let markerAt = null;
  for (let i = 0; i < 1800 && markerAt === null; i++) {
    if (newMarker(sessionFile, offset)) markerAt = Date.now();
    else await sleep(100);
  }
  if (markerAt === null) throw new Error("3 分钟内没等到压缩界碑落盘（压缩没触发或失败，看实例日志）");
  await sleep(1500);
  const m = await end(c, pids);
  const sums = mock.log.filter((q) => q.arrivedAt >= t0 && q.kind === "summary");
  return {
    enterToReqMs: reqs[0].arrivedAt - t0, firstTokenMs: tFirst - t0,
    compactTotalMs: markerAt - textDone,
    summaryPrepMs: sums[0] ? sums[0].arrivedAt - textDone : null,
    summaryN: sums.length, summaryMB: sums.reduce((s, q) => s + q.bodyBytes, 0) / 1e6,
    summaryDoneToMarkerMs: sums.at(-1)?.doneAt ? markerAt - sums.at(-1).doneAt : null,
    ...m,
  };
}

/**
 * 打开会话时的量：session:load 回来的尾窗多大（条数 / 字节 / 耗时，从 renderer 调同一个 IPC），
 * 界面渲染了多少 DOM；以及在主进程、agent 进程里各自同步读 + 逐行 JSON.parse 一遍自己那份会话文件
 * 的耗时——这是「每轮整份重读」的下界模拟（不是 pi / store 的原函数，量的是同进程、同文件的读与解析）。
 */
async function loadProbe(c, sessionId, sessionFile, piFile) {
  const win = [];
  for (let i = 0; i < 3; i++) {
    win.push(await c.r.evaluate(`(async () => { const t = performance.now(); const w = await window.orbita.session.load(${JSON.stringify(sessionId)}); const ms = performance.now() - t;
      return { ms, records: w.transcript.length, total: w.window.total, hasMore: w.window.hasMore, compactionsBefore: w.window.compactionsBefore,
        compactedInWindow: w.transcript.filter(r => r.role === 'compacted').length, bytes: JSON.stringify(w.transcript).length }; })()`, 120_000));
    await sleep(500);
  }
  const dom = await c.r.evaluate(`({ nodes: document.getElementsByTagName('*').length, userBubbles: document.querySelectorAll('.user-msg-time').length })`);
  const readParse = (file) => `(() => { const fs = process.getBuiltinModule('node:fs'); const t0 = performance.now(); const s = fs.readFileSync(${JSON.stringify(file)}, 'utf8');
    const t1 = performance.now(); let n = 0; for (const l of s.split('\\n')) if (l) { JSON.parse(l); n++; } const t2 = performance.now(); return { readMs: t1 - t0, parseMs: t2 - t1, lines: n }; })()`;
  const agentRP = [], mainRP = [];
  for (let i = 0; i < 3; i++) {
    agentRP.push(await c.agent.evaluate(readParse(piFile), 120_000));
    mainRP.push(await c.main.evaluate(readParse(sessionFile), 120_000));
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  return {
    loadIpcMs: med(win.map((w) => w.ms)), windowRecords: win[0].records, totalRecords: win[0].total, windowMB: win[0].bytes / 1e6,
    hasMore: win[0].hasMore, compactionsBeforeWindow: win[0].compactionsBefore, compactedInWindow: win[0].compactedInWindow,
    domNodes: dom.nodes, userBubbles: dom.userBubbles,
    agentReadMs: med(agentRP.map((x) => x.readMs)), agentParseMs: med(agentRP.map((x) => x.parseMs)),
    mainReadMs: med(mainRP.map((x) => x.readMs)), mainParseMs: med(mainRP.map((x) => x.parseMs)),
  };
}

const runs = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push(await fn()); return out; };

/** 铺 + 起一个实例，接上三个进程、装好探针，并冷打开一次目标会话 */
async function startInstance(fixtureDir, spec, ctx, logName) {
  const userData = join(WORK, "orbita-bench"); // 目录名决定工作区根：~/Orbita-bench（data-dirs.ts）
  if (existsSync(userData) && !existsSync(join(userData, ".orbita-bench"))) throw new Error(`${userData} 不是测量脚本建的，不删`);
  rmSync(userData, { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, ".orbita-bench"), "");
  // 素材每格现读：大素材不常驻驱动的内存
  const seeded = seedInstance({ fx: loadFixture(fixtureDir), userData, ws: join(WORK, "ws"), mockPort: ctx.mockPort, spec });
  const sizes = tickSizes(userData, seeded.sessionId);
  const sessionFile = join(userData, "sessions", `${seeded.sessionId}.jsonl`);
  const piFile = JSON.parse(readFileSync(join(userData, "sessions", `${seeded.sessionId}.meta.json`), "utf8")).piSessionFile;
  const app = launch({ userData, cdpPort: ctx.cdpPort, logFile: join(ctx.outDir, `instance-${logName}.log`) });
  try {
    const c = await attach(app, ctx.cdpPort);
    ctx.machine.display ??= await c.main.evaluate(`(() => { const d = require('electron').screen.getPrimaryDisplay(); return { scaleFactor: d.scaleFactor, width: d.size.width, height: d.size.height, hz: d.displayFrequency }; })()`);
    ctx.machine.onBattery ??= await c.main.evaluate(`require('electron').powerMonitor.isOnBatteryPower()`);
    ctx.electron ??= await c.main.evaluate("process.versions.electron");
    const pids = await installProbes(c);
    await clickRow(c.r, "bench-home");
    await sleep(1000);
    const coldOpen = await actionSwitch(c, pids, seeded.title);
    delete coldOpen._events;
    return { app, c, pids, seeded, sizes, sessionFile, piFile, coldOpen };
  } catch (error) {
    error.app = app;
    throw error;
  }
}

function finish(actions, warnings) {
  for (const [name, a] of Object.entries(actions)) {
    for (const run of a.runs) {
      if (run._visible !== "visible" || run["r.frames"] === 0) warnings.push(`${name}：有一次窗口不可见或 0 帧（visibility=${run._visible}），帧相关的数不可信`);
      delete run._events;
    }
    if (a.warmup) delete a.warmup._events;
    a.summary = summarize(a.runs);
  }
}

// —— 一个刻度：铺实例 → 起 → 量 → 停；压缩场景每次另起新实例 ——
async function runTick(fixtureDir, fixtureName, spec, ctx) {
  const ACTIONS = actionsFor(fixtureName);
  const tick = { fixture: fixtureName, spec, actions: {}, warnings: [] };
  const name = `${fixtureName}-${spec}`;
  const fail = async (inst, error, what) => {
    console.error(`✖ ${name} ${what}失败：${error.stack ?? error}`);
    tick.warnings.push(`${what}失败：${error.message}`);
    const shot = await inst?.c?.r.send("Page.captureScreenshot", { format: "png" }, 10_000).catch(() => null);
    if (shot) writeFileSync(join(ctx.outDir, `fail-${name}-${what}.png`), Buffer.from(shot.data, "base64"));
  };
  const main = ["switch", "idle", "turn", "type"].some((a) => ACTIONS.has(a));
  let inst = null;
  if (main) {
    try {
      step(`${name}：铺素材、起实例、冷打开`);
      inst = await startInstance(fixtureDir, spec, ctx, name);
      Object.assign(tick, { label: inst.seeded.label, turns: inst.seeded.turns, compactions: inst.seeded.compactions, sizes: inst.sizes, coldOpen: inst.coldOpen });
      const n = inst.sizes.sessionBytes > 30e6 ? Math.min(RUNS, RUNS_BIG) : RUNS;
      tick.runs = n;
      step(`${name}：${inst.seeded.turns} 轮、${inst.seeded.compactions} 次压缩，会话 ${(inst.sizes.sessionBytes / 1e6).toFixed(1)} MB / pi ${(inst.sizes.piBytes / 1e6).toFixed(1)} MB；冷打开 ${inst.coldOpen.settleMs} ms；每格 ${n} 次`);
      const { c, pids, seeded } = inst;
      await sleep(1500);
      tick.load = await loadProbe(c, seeded.sessionId, inst.sessionFile, inst.piFile);
      await sleep(2000);
      if (ACTIONS.has("switch")) tick.actions.switch = { runs: await runs(n, () => actionSwitch(c, pids, seeded.title)) };
      if (ACTIONS.has("idle")) { await sleep(2000); tick.actions.idle = { runs: [await actionIdle(c, pids)] }; }
      if (ACTIONS.has("turn")) { step(`${name}：跑一轮 ×${n + 1}`); tick.actions.turn = { warmup: await actionTurn(c, pids, ctx.mock), runs: await runs(n, () => actionTurn(c, pids, ctx.mock)) }; }
      if (ACTIONS.has("type")) { step(`${name}：流式时打字 ×${n + 1}`); tick.actions.type = { warmup: await actionType(c, pids, ctx.mock), runs: await runs(n, () => actionType(c, pids, ctx.mock)) }; }
    } catch (error) {
      await fail(inst, error, "常规动作");
      inst ??= { app: error.app };
    } finally {
      for (const x of [inst?.c?.r, inst?.c?.main, inst?.c?.agent]) x?.close();
      if (inst?.app) { await stop(inst.app.child); inst.app.flushLog(); }
    }
  }
  if (ACTIONS.has("compact") && COMPACT_REPS > 0) {
    const reps = { compactPre: [], compact: [], compactPost1: [], compactPost2: [], compactPost3: [] };
    for (let k = 1; k <= COMPACT_REPS; k++) {
      let ci = null;
      try {
        step(`${name}：压缩场景 第 ${k}/${COMPACT_REPS} 次（新实例：预热一轮 → 压缩前一轮 → 压缩 → 压缩后三轮）`);
        ci = await startInstance(fixtureDir, spec, ctx, `${name}-compact${k}`);
        if (!tick.sizes) Object.assign(tick, { label: ci.seeded.label, turns: ci.seeded.turns, compactions: ci.seeded.compactions, sizes: ci.sizes, coldOpen: ci.coldOpen });
        const { c, pids } = ci;
        await sleep(1500);
        await actionTurn(c, pids, ctx.mock); // 预热：这个实例第一轮带着 agent 冷启动
        reps.compactPre.push(await actionTurn(c, pids, ctx.mock));
        reps.compact.push(await actionCompact(c, pids, ctx.mock, ci.sessionFile));
        reps.compactPost1.push(await actionTurn(c, pids, ctx.mock));
        reps.compactPost2.push(await actionTurn(c, pids, ctx.mock));
        reps.compactPost3.push(await actionTurn(c, pids, ctx.mock));
      } catch (error) {
        await fail(ci, error, `压缩场景第 ${k} 次`);
        ci ??= { app: error.app };
      } finally {
        for (const x of [ci?.c?.r, ci?.c?.main, ci?.c?.agent]) x?.close();
        if (ci?.app) { await stop(ci.app.child); ci.app.flushLog(); }
      }
    }
    for (const [k, v] of Object.entries(reps)) if (v.length > 0) tick.actions[k] = { runs: v };
  }
  finish(tick.actions, tick.warnings);
  return tick;
}

// —— 主流程 ——
const outDir = join(OUT, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(outDir, { recursive: true });
mkdirSync(WORK, { recursive: true });
if (!argv.includes("--no-build")) {
  step("生产构建（electron-vite build）");
  execFileSync(process.execPath, [join(REPO, "node_modules/electron-vite/bin/electron-vite.js"), "build"], { cwd: REPO, stdio: "inherit" });
}
if (!existsSync(join(REPO, "out/main/index.js"))) throw new Error("out/ 里没有生产构建，先去掉 --no-build 跑一次");
const fixtures = FIXTURES.map((f) => {
  const dir = statSync(f).isDirectory() ? f : extractFixture(f, join(WORK, `fixture-${basename(f, ".zip")}`));
  const manifestRaw = readFileSync(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestRaw);
  return { dir, name: manifest.fixture, sha256: createHash("sha256").update(manifestRaw).digest("hex"), ticks: TICKS[manifest.fixture] ?? manifest.defaultTicks ?? ["10", "30", "60", "100"] };
});
const toolFile = join(WORK, "ws", "bench-tool-8kb.txt");
mkdirSync(dirname(toolFile), { recursive: true });
writeFileSync(toolFile, `${"x".repeat(63)}\n`.repeat(128));
// Windows 上 winnat（Hyper-V/WSL）每次开机在低位段随机保留整段端口，2026-11-05 一台 G14 实测
// 5305-5404 全保留，把 19 口的 5381-5399 整段吞掉，跳完保留段后无端口可用。动态段每次开机重摇，
// 固定换新段只是挪概率；pickPort 本就先跳保留段再逐口试绑，加宽扫描让它自愈。端口号不在测量
// 路径上，与 Mac 基线（旧段）的数据可直接并排比较。
const mockPort = await pickPort(5300, 5799);
const cdpPort = await pickPort(39300, 39999);
const mock = await startMock({ port: mockPort, toolFile });
step(`假模型 127.0.0.1:${mockPort}，CDP ${cdpPort}，结果 → ${outDir}`);
const ctx = { mock, mockPort, cdpPort, outDir, machine: machineInfo() };
const result = {
  schema: 2, label: LABEL, startedAt: new Date().toISOString(), machine: ctx.machine,
  build: { type: "生产构建（electron-vite build，electron . 加载 out/，React 生产模式）", commit: sh("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]), dirty: (sh("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=no"]) ?? "") !== "", electron: null },
  fixtures: fixtures.map(({ name, sha256, ticks }) => ({ name, sha256, ticks })),
  config: { runs: RUNS, runsBig: RUNS_BIG, compactReps: COMPACT_REPS, actions: ACTION_SPEC, turnPrompt: TURN_PROMPT, typePrompt: TYPE_PROMPT, compactPrompt: COMPACT_PROMPT, keys: KEYS.length, platform: process.platform },
  ticks: [],
};
for (const f of fixtures) {
  for (const spec of f.ticks) {
    result.ticks.push(await runTick(f.dir, f.name, spec, ctx));
    result.build.electron = ctx.electron ?? null;
    result.finishedAt = new Date().toISOString();
    writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, "result.md"), renderMarkdown(result));
  }
}
mock.close();
step(`完成 → ${join(outDir, "result.md")}`);
process.exit(0);
