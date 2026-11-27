/**
 * 串口控制台（ttyS0 上的 root shell）。**只做人工调试**，不是运行时协议：
 * 8250 UART 没有流控，整行灌进去会丢字符（P3-1 实测 "mount -t sysfs" → "moun  fssy"），
 * 所以这里逐 4 字节、每片 12ms 发送，并以「提示符再次出现」为结束判据。
 *
 *   node scripts/p3-desktop/serial.mjs exec "cat /var/log/Xorg.0.log | tail -30"
 *   node scripts/p3-desktop/serial.mjs tail 3000    # 只读现场输出
 */
import fs from "node:fs";
import net from "node:net";
import { SERIAL_PORT, STATE_FILE } from "./config.mjs";

const PROMPT = "~ # ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;
  const port = state?.serialPort ?? SERIAL_PORT;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    socket.on("data", (c) => (buf += c.toString("utf8")));
    socket.once("connect", () => resolve({ socket, text: () => buf }));
    socket.once("error", reject);
  });
}

async function waitFor(text, needle, ms, from = 0) {
  const t0 = Date.now();
  for (;;) {
    const idx = text().indexOf(needle, from);
    if (idx >= 0) return idx;
    if (Date.now() - t0 > ms) {
      throw new Error(`串口超时：没等到 ${JSON.stringify(needle)}；尾部 ${JSON.stringify(text().slice(-500))}`);
    }
    await sleep(100);
  }
}

const cmd = process.argv[2] ?? "tail";
const { socket, text } = await connect();

/** 逐字节、每片 15ms：8250 无流控时 4 字节/12ms 仍会偶发丢字符（实测 "cat /tmp/x.log" 丢成 "c/tmp/>|a3"） */
async function sendLine(line, perByteMs = 15) {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  for (const b of bytes) {
    socket.write(Buffer.from([b]));
    await sleep(perByteMs);
  }
}

/** 去掉 ANSI 控制序列与回显行，只留命令输出 */
function clean(raw, line) {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\[6n/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "" && l.trim() !== line.trim() && !/^~ #\s*$/.test(l))
    .join("\n");
}

async function runOnce(line, timeoutMs, perByteMs) {
  await sleep(600);
  const from = text().length;
  await sendLine(line, perByteMs);
  // 先确认回显整行都在：丢字符时 shell 收到的是一条别的命令，输出完全对不上，
  // 必须当场发现并重发，而不是等超时。
  await sleep(350);
  const echoed = clean(text().slice(from), "");
  if (!echoed.replace(/\s+/g, "").includes(line.replace(/\s+/g, ""))) return null;
  // 提示符要从「回显之后」找：每行提示符后面跟着 ESC[6n，从缓冲区尾部倒数 4 个字符
  // 会把起点落在转义序列里，永远匹配不上（实测重试 3 次全部假失败）。
  await waitFor(text, PROMPT, timeoutMs, from + line.length);
  return clean(text().slice(from), line);
}

if (cmd === "tail") {
  await sleep(Number(process.argv[3] ?? 3000));
  process.stdout.write(text());
  socket.destroy();
} else if (cmd === "exec") {
  const line = process.argv.slice(3).join(" ");
  const timeoutMs = Number(process.env.ORBITA_SERIAL_TIMEOUT ?? 60_000);
  let out = null;
  for (const perByteMs of [30, 70, 120]) {
    try {
      out = await runOnce(line, timeoutMs, perByteMs);
    } catch {
      out = null;
    }
    if (out !== null) break;
    socket.write(Buffer.from([0x03]));
    await sleep(500);
  }
  if (out === null) {
    console.error(`串口重试 3 次仍丢字符，放弃：${line}`);
    process.exit(3);
  }
  console.log(out.trim());
  socket.destroy();
} else {
  console.log("用法: serial.mjs exec <命令> | tail [ms]");
  socket.destroy();
  process.exit(2);
}
