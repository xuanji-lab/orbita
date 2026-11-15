/**
 * 桌面 VM 的起停（P3-2 的 ① 产物跑起来那一步）。
 *
 * 直启：宿主上的 bzImage + 我们拼的 initramfs → init 里 modprobe virtio_blk/ext4 →
 * mount /dev/vda → switch_root 到 guest 的 /sbin/init（OpenRC）。没有引导器、没有
 * guest 侧 initramfs，镜像里也就没有 /boot 这一份重复的内核。
 *
 * 三个回环口，全部绑 127.0.0.1：
 *   - VNC      5919  ← QEMU 自带，noVNC 与 RFB 取证都连这里
 *   - serial   5499  ← 人工/调试口（ttyS0 上的 root shell），不是运行时协议
 *   - monitor  5498  ← QEMU HMP，用来干净退出（quit）
 * USB tablet 提供**绝对坐标**指针，VNC 的 PointerEvent 才能落到正确位置。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  CONSOLE_VNC_DISPLAY,
  CONSOLE_VNC_PORT,
  DESKTOP_RFB_PORT,
  DISK,
  GUEST_RFB_PORT,
  IMAGE_DIR,
  INITRD,
  KERNEL,
  LOG_DIR,
  MONITOR_PORT,
  QEMU,
  SCREEN_H,
  SCREEN_W,
  SERIAL_PORT,
  SHOT_DIR,
  STATE_FILE,
} from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function portInUse(port, host = "127.0.0.1") {
  try {
    await waitPort(port, 500, host);
    return true;
  } catch {
    return false;
  }
}

export function waitPort(port, timeoutMs = 30_000, host = "127.0.0.1") {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host, port });
      s.once("connect", () => {
        s.destroy();
        resolve(Date.now() - t0);
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) reject(new Error(`等待 127.0.0.1:${port} 超时`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** 起一台桌面 VM（detached：node 退出后 VM 继续跑，便于下一步用 VNC/浏览器接管） */
export async function bootDetached({ mem = "2048", smp = "4", name = "orbita-p3-desktop" } = {}) {
  for (const f of [QEMU, KERNEL, INITRD, DISK]) {
    if (!fs.existsSync(f)) throw new Error(`缺文件 ${f}（先跑 build-ramdisk.mjs / build-image.mjs）`);
  }
  const prev = readState();
  if (prev && isAlive(prev.pid)) throw new Error(`已经有一台在跑（pid ${prev.pid}），先 stop`);
  // 端口被占时 QEMU 只会丢一句 "Failed to find an available port: Bad file descriptor"，
  // 而且它是在已经绑了一部分端口之后才退，排查很费时；这里先自己看清楚是谁占着。
  for (const port of [CONSOLE_VNC_PORT, DESKTOP_RFB_PORT, SERIAL_PORT, MONITOR_PORT]) {
    if (await portInUse(port)) throw new Error(`端口 ${port} 已被占用（netstat -ano 看 PID；别按名字杀，按 PID）`);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const qemuLog = path.join(LOG_DIR, `qemu-${stamp}.log`);
  const serialLog = path.join(LOG_DIR, `serial-${stamp}.log`);
  const fd = fs.openSync(qemuLog, "a");

  const args = [
    "-name",
    name,
    "-accel",
    "whpx",
    "-m",
    mem,
    "-smp",
    smp,
    "-display",
    "none",
    // 不加 -no-reboot：guest 里 reboot 是正常操作，加了这个开关 QEMU 会直接退出
    // （实测：guest 执行 reboot → QEMU 进程消失，VNC/serial 全断）。
    "-kernel",
    KERNEL,
    "-initrd",
    INITRD,
    "-append",
    `console=ttyS0,115200 root=/dev/vda rootfstype=ext4 rw loglevel=4`,
    "-drive",
    `file=${DISK},if=none,id=d0,cache=writeback,discard=unmap`,
    "-device",
    "virtio-blk-pci,drive=d0",
    "-netdev",
    // 桌面 RFB 从 guest 的 Xvnc(5900) 转出来；只绑宿主回环
    `user,id=n0,hostfwd=tcp:127.0.0.1:${DESKTOP_RFB_PORT}-:${GUEST_RFB_PORT}`,
    "-device",
    "virtio-net-pci,netdev=n0",
    // 桌面渲染在 guest 的 Xvnc 里，QEMU 这边只要一个普通 VGA 给文本 console 用；
    // 指针/键盘由 Xvnc 的 RFB 直接处理，不再需要 usb-tablet。
    "-vga",
    "std",
    "-vnc",
    `127.0.0.1:${CONSOLE_VNC_DISPLAY}`,
    "-serial",
    `tcp:127.0.0.1:${SERIAL_PORT},server,nowait`,
    "-monitor",
    `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
  ];

  const t0 = Date.now();
  const child = spawn(QEMU, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  const state = {
    pid: child.pid,
    startedAt: new Date(t0).toISOString(),
    consoleVncPort: CONSOLE_VNC_PORT,
    desktopRfbPort: DESKTOP_RFB_PORT,
    serialPort: SERIAL_PORT,
    monitorPort: MONITOR_PORT,
    qemuLog,
    serialLog,
    cmdline: args.join(" "),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // 不在这里探活 VNC：QEMU 的 VNC 是单客户端模型，探活连接会把监听关一次，
  // 调用方随后那条真连接就会 ECONNREFUSED。谁要连谁自己带重试地连。
  return { ...state, spawnMs: Date.now() - t0 };
}

/** 通过 QEMU monitor 退出（quit = 立刻断电式退出；guest 侧 ext4 有日志，能自愈） */
export async function stopDetached() {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
    return { stopped: false, reason: "没有在跑的实例" };
  }
  const res = await sendMonitor("quit\n").catch((e) => ({ error: String(e.message) }));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isAlive(state.pid)) await sleep(150);
  const alive = isAlive(state.pid);
  if (alive) {
    process.kill(state.pid);
    await sleep(500);
  }
  fs.rmSync(STATE_FILE, { force: true });
  return { stopped: true, pid: state.pid, forced: alive, monitor: res };
}

/** 与 QEMU HMP 说一句话，返回全部回显 */
export function sendMonitor(text, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port: MONITOR_PORT });
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("monitor 超时"));
    }, timeoutMs);
    s.on("connect", () => {
      s.write(text);
      setTimeout(() => {
        clearTimeout(timer);
        s.destroy();
        resolve(buf.trim());
      }, 300);
    });
    s.on("data", (c) => {
      buf += c.toString("utf8");
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export { IMAGE_DIR, SCREEN_H, SCREEN_W };
