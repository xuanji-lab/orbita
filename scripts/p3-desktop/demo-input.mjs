/**
 * 桌面「能点能打字」的最小验收脚本（要求 VM 已由 run-desktop.mjs boot 起来）。
 *
 *   node scripts/p3-desktop/demo-input.mjs [rfbPort]
 *
 * 走纯 RFB：点 Applications 菜单 → System → Xfce Terminal → 在终端里打字执行命令，
 * 每步落一张 PNG。坐标按 1280x800 + XFCE 4.20 默认面板量的（面板在顶栏左端）。
 *
 * 两个实测出来的坑，别改回去：
 *   1. 按压必须停够 200ms —— 90ms 的 press/release 在 Xvnc 下会被面板当成没发生；
 *   2. 每个点之前先落一个「附近」的移动 —— 连接后第一个绝对坐标 + 立刻按下会丢 enter。
 */
import path from "node:path";
import { DESKTOP_RFB_PORT, SHOT_DIR } from "./config.mjs";
import { RfbClient } from "./rfb.mjs";

const port = Number(process.argv[2] ?? DESKTOP_RFB_PORT);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = await RfbClient.connectRetry({ port, timeoutMs: 60_000 });
await client.update(false);
await sleep(500);
const steps = [];

async function capture(name) {
  await client.update(false);
  const file = path.join(SHOT_DIR, `${stamp}-${name}.png`);
  client.screenshot(file);
  steps.push({ step: name, file, size: `${client.width}x${client.height}` });
}

/** 带热身移动与长按压的点击 */
async function press(x, y, settleMs = 600) {
  // 热身必须落在「中立点」（桌面空白），不能是 x±60/y±40：菜单里那个位置常常是另一行，
  // 会把子菜单带走（实测点 System 时热身落到了 About Xfce 上）。
  client.pointer(640, 620, 0);
  await sleep(120);
  client.pointer(x, y, 0);
  await sleep(160);
  client.pointer(x, y, 1);
  await sleep(250);
  client.pointer(x, y, 0);
  await sleep(settleMs);
}

async function type(text) {
  for (const ch of text) {
    const sym = ch.codePointAt(0);
    client.key(sym, true);
    await sleep(25);
    client.key(sym, false);
    await sleep(25);
  }
}

async function enter(settleMs = 700) {
  client.key(0xff0d, true);
  await sleep(60);
  client.key(0xff0d, false);
  await sleep(settleMs);
}

await capture("01-desktop");

// 菜单是「开关」语义：上一轮留下的打开状态会让这一下变成「关闭」。先 Esc 清场，
// 点完再看菜单区域的颜色判断它到底开没开，没开就再点一次（最多 3 次）。
async function pixel(x, y) {
  const i = (y * client.width + x) * 4;
  return [client.fb[i + 2], client.fb[i + 1], client.fb[i]];
}
async function menuOpen() {
  await client.update(false);
  const [r, g, b] = await pixel(100, 100); // 菜单卡片区域：灰；桌面：青
  return Math.abs(b - r) < 24;
}
async function dismiss() {
  client.key(0xff1b, true);
  await sleep(50);
  client.key(0xff1b, false);
  await sleep(300);
  await press(640, 500, 300); // 点桌面空白，确保没有残余 grab
}

await dismiss();
for (let i = 0; i < 3 && !(await menuOpen()); i++) await press(60, 12);
await capture("02-applications-menu");
await press(52, 145);
await capture("03-system-submenu");
// System 子菜单：Thunar 在 y=145，Xfce Terminal 在 y=171（镜像里没有 xterm/uxterm 时如此）
await press(229, 171, 2200);
await capture("04-terminal-open");

// 焦点进终端窗口，然后打字
await press(400, 300, 400);
await type("echo ORBITA_P3_DESKTOP_OK");
await capture("05-typed");
await enter();
await capture("06-command-output");

// 中文字体：cat 构建时写好的 /root/cjk.txt（中文没法用 keysym 打，命令本身是 ASCII）
await type("cat /root/cjk.txt");
await enter();
await capture("07-chinese-font");

client.close();
console.log(JSON.stringify({ port, steps }, null, 2));
