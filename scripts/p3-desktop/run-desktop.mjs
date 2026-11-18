/**
 * 起/停桌面 VM，并量「冷启到桌面可见」。
 *
 *   node scripts/p3-desktop/run-desktop.mjs boot [--mem 2048] [--smp 4] [--timeout 180]
 *   node scripts/p3-desktop/run-desktop.mjs stop
 *   node scripts/p3-desktop/run-desktop.mjs status
 *
 * boot 是 detached 的：命令返回后 VM 继续跑，接着可以用
 *   - rfb.mjs（截图/点击/打字）
 *   - serve-novnc.mjs（浏览器里看这个桌面）
 * 接管。判「桌面可见」的标准不是「端口开了」，而是 VNC 帧缓冲里非黑像素 > 12%、
 * 颜色 > 40 种并连续两次稳定（纯黑 = X 没起来，纯色 = 只有根窗口）。
 */
import path from "node:path";
import { DESKTOP_RFB_PORT, IMAGE_DIR, SHOT_DIR } from "./config.mjs";
import { RfbClient } from "./rfb.mjs";
import { bootDetached, isAlive, readState, stopDetached } from "./vm.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "boot";
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};

if (cmd === "boot") {
  const state = await bootDetached({ mem: opt("--mem", "2048"), smp: opt("--smp", "4") });
  const timeoutMs = Number(opt("--timeout", "180")) * 1000;
  const t0 = Date.now();
  // 断线重连：guest 刚起来时 hostfwd 已在听、Xvnc 还没起来，连接会被关；
  // 整个等待期只要没看到桌面就重连，不把底层 socket 错误抛给调用方。
  const deadline = t0 + timeoutMs;
  let client = null;
  const samples = [];
  let desktop = null;
  let lastErr = null;
  while (Date.now() < deadline && !desktop) {
    if (!client) {
      try {
        client = await RfbClient.connectRetry({ port: DESKTOP_RFB_PORT, timeoutMs: 5000 });
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }
    try {
      desktop = await client.waitForDesktop({
        timeoutMs: Math.max(1000, deadline - Date.now()),
        reconnect: true,
        onSample: (s, ms) => samples.push({ ms, lit: +(s.litRatio * 100).toFixed(1), colors: s.colors }),
      });
    } catch (e) {
      lastErr = e;
      client.close();
      client = null;
    }
  }
  if (!desktop) throw new Error(`桌面没起来（${timeoutMs}ms）：${lastErr?.message ?? "未知"}`);
  const vncReadyMs = Date.now() - t0;
  const shot = path.join(SHOT_DIR, `01-desktop-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  client.screenshot(shot);
  const size = `${client.width}x${client.height}`;
  client.close();
  console.log(
    JSON.stringify(
      {
        pid: state.pid,
        rfbPort: DESKTOP_RFB_PORT,
        framebuffer: size,
        vncReadyMs,
        desktopVisibleMs: desktop.ms,
        desktopAtMs: vncReadyMs + desktop.ms,
        sampleCount: samples.length,
        firstSample: samples[0],
        screenshot: shot,
        imageDir: IMAGE_DIR,
      },
      null,
      2,
    ),
  );
} else if (cmd === "stop") {
  console.log(JSON.stringify(await stopDetached(), null, 2));
} else if (cmd === "status") {
  const state = readState();
  if (!state) {
    console.log(JSON.stringify({ running: false }));
  } else {
    console.log(JSON.stringify({ running: isAlive(state.pid), ...state }, null, 2));
  }
} else {
  console.log("用法: run-desktop.mjs boot|stop|status");
  process.exit(2);
}
