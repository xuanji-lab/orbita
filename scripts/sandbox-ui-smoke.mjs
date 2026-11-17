/**
 * 打包版 UI 冒烟（PR5）——在**一次性 Windows 沙箱**里验证「打包产物能起来并渲染」。
 *
 * 与 scripts/ui-smoke.mjs 的分工：那个用 CDP 验宿主上**开发版的行为**（点得开设置面、
 * 主入口在不在）；这个只回答一个问题——**同一份代码打出来的 exe，在一台干净的机器上
 * 能不能启动、能不能画出东西**（开发版跑得起来 ≠ 打包版跑得起来：缺 extraResources、
 * asar 路径、native 模块、VC++ 运行时，都只在打包版上现形）。
 * 它不验任何行为，断言只看屏幕像素。
 *
 * 为什么进沙箱：打包版要在「没有用户数据、没有登录态、没有用户桌面」的机器上验，
 * 而宿主上启动一份裸 exe 会弹真窗口、写真实 userData、抢焦点。沙箱是每次一次性的。
 *
 * 前置（缺哪条脚本会直接说，不猜）：
 *   1. 先出包：`bun run dist:win` → 产物在 `<repo 根>/dist/win-unpacked/orbita.exe`。
 *      产物目录可以不存在（沙箱照常起，但 UI 冒烟没东西可验，脚本会 exit 2）。
 *   2. 桥已编译：`bun run build:bridge`（产物 guest-bridge/bin/orbita-guest-bridge.exe）。
 *   3. Windows 沙箱已开启（设置里能看到 Windows Sandbox）。
 *
 * 用法（仓库根）：
 *   bun scripts/sandbox-ui-smoke.mjs
 *   node scripts/sandbox-ui-smoke.mjs --wait 15000 --shot ./tmp/sandbox-ui.jpg
 *
 * 参数（都能用环境变量给，便于 CI / 临时脚本）：
 *   --app-dir <宿主目录>       打包产物目录；缺省 <repo>/dist/win-unpacked（ORBITA_SMOKE_APP_DIR）
 *   --wait <毫秒>              启动后等多久再截图，缺省 10000（ORBITA_SMOKE_WAIT_MS）
 *   --shot <宿主文件路径>       截图的落盘位置；缺省 scripts/.sandbox-ui-smoke/<时间戳>.jpg。
 *                              指到别的目录时它必须已存在（脚本不替你造目录）——仓里不留产物
 *   --instance <名字>          userData 目录名；缺省 sandbox-ui-smoke-<时间戳>，
 *                              落在 %APPDATA% 下，每次一次性，跑完不删（留现场看）
 *   --no-shot                 不存截图（只要像素统计时用）
 *
 * 断言（像素统计，`screenshot-stats` 命令回数字，宿主不解图、没有基线图）：
 *   stdDev > 8        画面有内容（纯色屏的 stdDev 是 0）
 *   blackRatio < 0.95 不是全黑（黑屏 = Electron 起来了但 renderer 没画）
 *   whiteRatio < 0.95 不是全白（白屏 = renderer 崩了 / 加载失败）
 *
 * 退出码（照 scripts/cdp.mjs 的语义）：
 *   0 = 全过；1 = 断言失败（起来了但画面不对）；2 = 跑不下去（沙箱起不来 / 产物不在 / 桥不认命令 / 卡住）。
 *
 * 红线：这个脚本会起真沙箱窗口，并且**在宿主侧不碰任何别的进程**——沙箱进程按
 * 「启动前基线 → 现在」的差集认，杀仍按 PID（taskkill /T /F），绝不按镜像名杀。
 * 沙箱里的 exe 由 guest 桥的 kill 按它自己回的 pid 杀。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseSandboxProcesses } from "../src/main/computer-use/process-list.ts";
import { buildCloseSandboxWindowScript } from "../src/main/computer-use/close-window-script.ts";
import { COMPUTER_USE_GUEST_APP_EXE, SandboxController } from "../src/main/computer-use/sandbox.ts";
import { computerUseGuestCommands } from "../src/shared/computer-use.ts";

// ── 参数 ──────────────────────────────────────────────────────────────

function argValue(flag, envName, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  const fromEnv = envName === undefined ? undefined : process.env[envName];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback;
}

const repoRoot = resolve(import.meta.dirname, "..");
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");

const appDir = resolve(argValue("--app-dir", "ORBITA_SMOKE_APP_DIR", join(repoRoot, "dist", "win-unpacked")));
const waitMs = Number(argValue("--wait", "ORBITA_SMOKE_WAIT_MS", "10000"));
const instanceName = argValue("--instance", "ORBITA_SMOKE_INSTANCE", `sandbox-ui-smoke-${stamp}`);
const saveShot = !process.argv.includes("--no-shot");
const shotPath = resolve(
  argValue("--shot", "ORBITA_SMOKE_SHOT", join(repoRoot, "scripts", ".sandbox-ui-smoke", `${stamp}.jpg`)),
);

// ── 小工具（照 cdp.mjs：每步一行带耗时的进度，卡在哪一步一眼能看出来）──

let lastStep = "（尚未开始）";
const step = (name) => {
  lastStep = name;
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑不下去：报出卡在哪一步，exit 2（与 cdp.mjs 的看门狗同一语义） */
const bail = (message) => {
  console.error(`✖ ${message}（停在「${lastStep}」）`);
  process.exit(2);
};

/**
 * 沙箱已经起来之后才失败的情况抛出它：**必须先关沙箱再退出**——
 * 直接 process.exit 会把沙箱窗口与 VM（几 GB）留在宿主上，下一次跑就撞上「会话太多」。
 * finally 里统一收尾，然后按它决定 exit 2。
 */
class AbortError extends Error {}

// ── 依赖注入：与 src/main/index.ts 的接法同源（杀树 / 观测 / 关窗脚本）──────

const killTreeByPid = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  // /T 整棵树、/F 免确认；异步火力覆盖，与主进程同款
  const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  taskkill.on("error", () => {});
};

/** 只读观测（tasklist）。杀仍走 killTreeByPid——不按镜像名杀。 */
const listSandboxProcesses = () => {
  const listed = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
  return parseSandboxProcesses(listed.stdout);
};

/** 关沙箱窗口（关窗 + 替用户按确认框的 Ok）。强杀会把 VM 留给宿主，见 sandbox.ts 的注释。 */
const closeSandboxWindow = (pid) => {
  spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildCloseSandboxWindowScript(pid)],
    { stdio: "ignore", windowsHide: true, timeout: 20_000 },
  );
};

// ── 前置检查（缺东西时说清楚，别让沙箱白起一轮）──────────────────────────

if (process.platform !== "win32") bail("Windows 沙箱只在 Windows 上可用");
const bridgeDir = join(repoRoot, "guest-bridge", "bin");
if (!existsSync(join(bridgeDir, "orbita-guest-bridge.exe"))) {
  bail(`guest 桥不在（${join(bridgeDir, "orbita-guest-bridge.exe")}）——先跑 bun run build:bridge`);
}
if (!Number.isFinite(waitMs) || waitMs <= 0) bail(`--wait 需要正整数毫秒，收到 ${String(process.argv[process.argv.indexOf("--wait") + 1])}`);
if (!existsSync(appDir)) {
  // 产物不在是可预期的开发态：先出包。**别起沙箱**——白起一轮还要等 1~2 分钟
  lastStep = "前置检查";
  bail(
    `没有打包产物：${appDir}\n  先在仓库根跑 bun run dist:win（出 dist/win-unpacked），` +
      `或用 --app-dir 指到已有的产物目录`,
  );
}

const exeOnHost = join(appDir, "orbita.exe");
if (!existsSync(exeOnHost)) {
  console.warn(`⚠ ${appDir} 里没有 orbita.exe——沙箱起来后 launch 会失败并报出 guest 侧路径`);
}

// ── 起沙箱 ────────────────────────────────────────────────────────────

// userData 目录每次一次性（沙箱本身也是一次性的）：与用户的 %APPDATA%\orbita-dev 无关
const computerUseDir = join(process.env.APPDATA ?? tmpdir(), instanceName, "computer-use");
mkdirSync(computerUseDir, { recursive: true });

const sandbox = new SandboxController({
  computerUseDir,
  bridgeDir,
  sandboxExePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe"),
  appDir,
  spawnSandbox: (wsbPath) => spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe"), [wsbPath], { stdio: "ignore" }),
  killTreeByPid,
  listSandboxProcesses,
  closeSandboxWindow,
  log: (message) => console.log(`    [sandbox] ${message}`),
});

let launchPid = null;
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✖"} ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failed = true;
};

step(`起沙箱（产物 ${appDir}）`);
const started = await sandbox.start();
if (!started.ok) {
  // 起不来是「跑不下去」而不是「断言失败」：exit 2 让人知道要先看能力 / 产物
  bail(`沙箱没有起来：${started.error}`);
}

/**
 * 沙箱起来之后的失败一律抛 AbortError：finally 里先 kill + 关沙箱，再 exit 2。
 * 直接 process.exit 会把窗口与 VM 留给宿主（几 GB，攒多了连新沙箱都起不来）。
 */
let aborted = null;
try {
  step("launch 打包版");
  const launched = await sandbox.guestCommandReply(computerUseGuestCommands.launch, {
    path: COMPUTER_USE_GUEST_APP_EXE,
  });
  if (!launched.ok) throw new AbortError(`launch 失败：${launched.error}`);
  const pid = launched.resp.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new AbortError(`launch 回执里没有有效 pid：${JSON.stringify(launched.resp)}`);
  }
  launchPid = pid;
  console.log(`    pid ${pid}（沙箱内）；等 ${waitMs}ms 让它画完`);

  step(`等 ${waitMs}ms`);
  await sleep(waitMs);

  step("像素统计");
  const stats = await sandbox.guestCommandReply(computerUseGuestCommands.screenshotStats, { maxWidth: 640 });
  if (!stats.ok) throw new AbortError(`screenshot-stats 失败：${stats.error}`);
  const { width, height, stdDev, blackRatio, whiteRatio, distinctColors } = stats.resp;
  const round = (value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);
  console.log(
    `    ${String(width)}x${String(height)} stdDev=${String(round(stdDev))} ` +
      `black=${String(round(blackRatio))} white=${String(round(whiteRatio))} colors=${String(distinctColors)}`,
  );
  check("画面有内容（stdDev > 8）", typeof stdDev === "number" && stdDev > 8, `stdDev=${String(round(stdDev))}`);
  check(
    "不是全黑（blackRatio < 0.95）",
    typeof blackRatio === "number" && blackRatio < 0.95,
    `blackRatio=${String(round(blackRatio))}`,
  );
  check(
    "不是全白（whiteRatio < 0.95）",
    typeof whiteRatio === "number" && whiteRatio < 0.95,
    `whiteRatio=${String(round(whiteRatio))}`,
  );

  if (saveShot) {
    step("存截图");
    const shot = await sandbox.screenshot(1280);
    if (!shot.ok) {
      // 截图存不下来不该让「渲染了没有」这个结论变成假的：统计已经跑过，这里只警告
      console.warn(`⚠ 截图没存下来：${shot.error}`);
    } else {
      mkdirSync(resolve(shotPath, ".."), { recursive: true });
      writeFileSync(shotPath, Buffer.from(shot.jpegBase64, "base64"));
      console.log(`    截图 → ${shotPath}`);
    }
  }
} catch (error) {
  if (!(error instanceof AbortError)) throw error;
  aborted = error.message;
} finally {
  // 收尾无论成败都走：先按 guest 回的 pid 杀沙箱里的 exe 进程树，再关沙箱
  if (launchPid !== null) {
    step(`kill 沙箱里的打包版（pid ${launchPid}）`);
    const killed = await sandbox.guestCommandReply(computerUseGuestCommands.kill, { pid: launchPid });
    if (!killed.ok) console.warn(`⚠ kill 失败（沙箱销毁会带走它）：${killed.error}`);
    else console.log("    已终止");
  }
  step("关沙箱");
  const stopped = await sandbox.stop();
  if (!stopped.ok) console.warn(`⚠ 关沙箱失败：${stopped.error}`);
  if (sandbox.status().state !== "off") {
    console.warn(`⚠ 沙箱状态为 ${sandbox.status().state}——任务管理器里若见 vmwp / WindowsSandboxRemoteSession，按 PID 手动结束`);
  }
}

if (aborted !== null) {
  console.error(`✖ ${aborted}（停在「${lastStep}」）`);
} else {
  console.log(failed ? "\n✖ 打包版 UI 冒烟未通过" : "\n✓ 打包版 UI 冒烟通过（渲染了，不是黑屏 / 白屏）");
}
// 现场留给人看：日志与 bridge.log 在 computerUseDir 下，不删
console.log(`  现场：${computerUseDir}`);
if (existsSync(join(computerUseDir, "out", "bridge.log"))) {
  console.log(`  桥日志：${join(computerUseDir, "out", "bridge.log")}`);
}
process.exit(aborted !== null ? 2 : failed ? 1 : 0);
