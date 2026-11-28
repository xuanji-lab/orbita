/**
 * L3 桌面 VM 的启动/停止（QEMU + WHPX，直启内核）。**不 import electron，node --test 可直接跑。**
 *
 * 与 P3-2 的 scripts/p3-desktop/vm.mjs 是同一套命令行，但这里是生产路径（主进程用）：
 *  - 每个实例自己一份端口（桌面服务 + monitor），互不撞车——脚本那份写死 5919/5499/5498；
 *  - 不写全局 state 文件（那只够单实例），handle 由调用方持有；
 *  - 串口落到日志文件而不是 TCP 口：它是**人工调试**通道（8250 无流控会丢字符，见 vm.mjs），
 *    生产路径不需要再占一个端口。
 *
 * 为什么直启内核、不用引导器：镜像里就没有 /boot（P3-1 的决定），宿主拿 linux-virt 包里
 * 拆出来的 bzImage + 自己拼的 initramfs，init 里 mount /dev/vda 再 switch_root。
 *
 * 红线：停实例只按**自己 spawn 的 pid** 或 QEMU monitor 的 quit，绝不按进程名杀——
 * 同机可能还有用户自己的 QEMU / 别的实例。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { cuTexts } from "./ui-language.ts";

/** guest 里桌面服务监听的固定端口（desk-cgi.sh 那套；宿主侧端口每次现挑） */
export const GUEST_DESK_PORT = 8080;
/** guest 里 Xvnc 的 RFB 端口（指针输入走它；镜像的 orbita-xvnc 就是这么起的） */
export const GUEST_RFB_PORT = 5900;
/** 宿主端口池的下界。避开 5273（用户的 dev server）、5919/5420/5498/5499（P3-2 脚本那套） */
const HOST_PORT_BASE = 6200;
const HOST_PORT_SPAN = 200;

export interface QemuVmPaths {
  imageDir: string;
  qemuDir: string;
  qemu: string;
  disk: string;
  kernel: string;
  initrd: string;
}

/**
 * 产物路径。默认与 scripts/p3-desktop/config.mjs 同一个落点（%APPDATA%\orbita\p3-desktop），
 * 两个环境变量也可覆盖——镜像与 QEMU 二进制都在仓外，绝不进仓。
 */
export function qemuVmPaths(overrides: { imageDir?: string; qemuDir?: string } = {}): QemuVmPaths {
  const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  const imageDir = overrides.imageDir ?? process.env.ORBITA_P3_IMAGE_DIR ?? path.join(appData, "orbita", "p3-desktop");
  const qemuDir = overrides.qemuDir ?? process.env.ORBITA_P3_QEMU_DIR ?? path.join(imageDir, "qemu");
  return {
    imageDir,
    qemuDir,
    qemu: path.join(qemuDir, "root", "mingw64", "bin", "qemu-system-x86_64.exe"),
    disk: path.join(imageDir, "desktop.qcow2"),
    kernel: path.join(imageDir, "vmlinuz-virt"),
    initrd: path.join(imageDir, "initramfs-orbita.cpio.gz"),
  };
}

/** 缺哪个文件就说哪个：起不来时用户要能照着这句话去补（跑 build-image.mjs / build-ramdisk.mjs） */
export function missingQemuVmFiles(paths: QemuVmPaths): string[] {
  return [paths.qemu, paths.disk, paths.kernel, paths.initrd].filter((file) => !fs.existsSync(file));
}

export interface QemuVmPorts {
  /** 宿主回环端口 → guest 的 8080（桌面服务：截图 / 键盘 / shell） */
  desk: number;
  /** 宿主回环端口 → guest 的 QEMU monitor（只用来 quit） */
  monitor: number;
  /**
   * 宿主回环端口 → guest 的 5900（Xvnc 的 RFB）。**指针输入走它**：
   * XTEST 造的事件在 GTK 菜单上是二等公民，点不开菜单（理由见 qemu-rfb.ts 头注释）。
   */
  rfb: number;
}

export interface QemuVmOptions {
  paths: QemuVmPaths;
  /** 宿主侧端口。缺省现挑两个空闲的 */
  ports?: QemuVmPorts;
  /** guest 侧令牌：写进内核命令行（orbita_token=…），服务用它校验每个请求 */
  token?: string;
  memMiB?: number;
  smp?: number;
  name?: string;
  logDir?: string;
  /**
   * guest 能不能出网（设置 › 电脑使用 › 允许沙箱出网）。**必填**：这是隔离边界的一部分，
   * 不允许调用方漏填后默默用上网络的默认——启动路径必须显式表态。
   * false 时 `-netdev user` 加 `restrict=on`：guest 出不去外网，**但显式 hostfwd 不受影响**，
   * 桌面 HTTP（8080）与 RFB（5900）两条回环转发照通（见 qemuNetdevSpec）。
   */
  allowNetwork: boolean;
}

export interface QemuVmHandle {
  pid: number;
  ports: QemuVmPorts;
  token: string;
  /** QEMU 自己的 stdout/stderr（起不来时第一现场） */
  qemuLog: string;
  /** guest 串口（root shell 的输出都在这里） */
  serialLog: string;
  args: readonly string[];
  spawnedAt: number;
}

/** 端口被占时 QEMU 只丢一句 "Failed to find an available port"，而且在绑了一部分端口之后才退；这里先自己看 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** 从端口池里挑三个连续可用的空闲端口（本机回环） */
export async function pickFreePorts(): Promise<QemuVmPorts> {
  for (let port = HOST_PORT_BASE; port + 2 < HOST_PORT_BASE + HOST_PORT_SPAN; port += 3) {
    // 三个都要空闲；并行探测，省掉逐个数的心跳等待
    const [a, b, c] = await Promise.all([portFree(port), portFree(port + 1), portFree(port + 2)]);
    if (a && b && c) return { desk: port, monitor: port + 1, rfb: port + 2 };
  }
  throw new Error(cuTexts().qemuNoFreePorts(`${HOST_PORT_BASE}..${HOST_PORT_BASE + HOST_PORT_SPAN}`));
}

/**
 * 加速器串。本车道只有 WHPX（Windows）这一档，QEMU 二进制也是 x86_64 的（见 qemuVmPaths）。
 *
 * `kernel-irqchip=off` 只在 **x86_64 + WHPX** 时追加，别处一律原样返回：
 *  - 来由：microsoft/quicksand 记录过「WHPX 内核态 irqchip + guest 的 noapic 会丢设备中断，
 *    之后的 mount -t cifs 会卡死」。我们的内核命令行（见下面的 -append）**没有 noapic**，
 *    所以那条不能照抄，只按本机实测取舍（2026-11-22，同一台机器各跑 2 次，产品路径 start()）：
 *      · 不开：qemu stderr 每次启动 1 行 `whpx: injection failed, MSI (...) lost (c0350005)`，
 *        start 8.3 s / 18.5 s（第一次含宿主文件缓存冷启动）；
 *      · 开：该行 0 行（连 `WHPX: setting APIC emulation mode` 也不再打，因为 APIC 不再跑在
 *        hypervisor 里），start 8.3 s / 7.8 s，截图均成（1280×800 PNG）；
 *      · 且 start 里 waitForDesk 要经 virtio-net 回环 ping 通 8080，所以开这个参数后 guest
 *        网络/virtio 中断仍然能用，不是「能开机但半死」。
 *    噪声少了且桌面照常可用 ⇒ 保留（若哪天实测噪声不降或有副作用，就删掉这行并在本节写数字）。
 *  - 其它 arch / accel（HVF、arm64 的 qemu-system-aarch64）没有同一套 irqchip 语义，
 *    盲目加属性只会让命令行更难读、起不来时更难查。
 */
export function qemuAccelSpec(arch: string, accel: string): string {
  return arch === "x64" && accel === "whpx" ? `${accel},kernel-irqchip=off` : accel;
}

/**
 * `-netdev` 的 user 网络串。**断开出网只靠一个参数，且不能弄丢转发**：
 *   restrict=on   QEMU 文档：「isolate guest from the rest of the network」——guest 只能
 *                 访问被显式转发的端口，DNS / 外网一概不通；
 *   两个 hostfwd   桌面服务（8080）与 Xvnc（5900）的回环转发。它们是**显式**的，
 *                 restrict 不作用于它们（restrict 管的是隐式的出站 / 入站），所以断开出网后
 *                 像素操作与截图照常。丢一个 hostfwd 就等于把整个桌面通道掐了。
 * 参数顺序：restrict 放在 hostfwd 前，只是为了让日志里一眼看到它。
 */
export function qemuNetdevSpec(ports: QemuVmPorts, allowNetwork: boolean): string {
  const hostfwd =
    `hostfwd=tcp:127.0.0.1:${ports.desk}-:${GUEST_DESK_PORT},` +
    `hostfwd=tcp:127.0.0.1:${ports.rfb}-:${GUEST_RFB_PORT}`;
  return allowNetwork ? `user,id=n0,${hostfwd}` : `user,id=n0,restrict=on,${hostfwd}`;
}

/** 拼命令行要的输入（与 QemuVmOptions 同源，加上已解析好的串口日志路径与令牌） */
export interface QemuVmArgsInput {
  paths: QemuVmPaths;
  ports: QemuVmPorts;
  token: string;
  allowNetwork: boolean;
  name?: string;
  memMiB?: number;
  smp?: number;
  serialLog: string;
}

/**
 * 整条 QEMU 命令行。抽成纯函数是为了能断言参数：开机要真实镜像与 QEMU 二进制，
 * 单测跑不起；而 `-netdev` 里的 restrict / hostfwd 是「断网后桌面通道还在」的唯二证据。
 */
export function qemuVmArgs(input: QemuVmArgsInput): string[] {
  const { paths, ports, token } = input;
  return [
    "-name",
    input.name ?? "orbita-l3",
    "-accel",
    qemuAccelSpec(process.arch, "whpx"),
    "-m",
    String(input.memMiB ?? 2048),
    "-smp",
    String(input.smp ?? 2),
    "-display",
    "none",
    "-kernel",
    paths.kernel,
    "-initrd",
    paths.initrd,
    // orbita_token= 由 guest 的 desk-service.sh 从 /proc/cmdline 读出来当请求令牌
    "-append",
    `console=ttyS0,115200 root=/dev/vda rootfstype=ext4 rw loglevel=3 orbita_token=${token}`,
    "-drive",
    `file=${paths.disk},if=none,id=d0,cache=writeback,discard=unmap`,
    "-device",
    "virtio-blk-pci,drive=d0",
    "-netdev",
    qemuNetdevSpec(ports, input.allowNetwork),
    "-device",
    "virtio-net-pci,netdev=n0",
    "-vga",
    "std",
    "-serial",
    `file:${input.serialLog}`,
    "-monitor",
    `tcp:127.0.0.1:${ports.monitor},server,nowait`,
  ];
}

/**
 * 起一台桌面 VM（detached：本进程退出后 VM 继续跑，靠 handle 里的 pid / monitor 端口收）。 */
export function bootQemuVm(options: QemuVmOptions & { ports: QemuVmPorts }): QemuVmHandle {
  const { paths, ports } = options;
  const missing = missingQemuVmFiles(paths);
  if (missing.length > 0) {
    throw new Error(cuTexts().qemuVmFilesMissing(missing.join("、")));
  }
  const token = options.token ?? randomBytes(16).toString("hex");
  const logDir = options.logDir ?? path.join(paths.imageDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const qemuLog = path.join(logDir, `qemu-${stamp}.log`);
  const serialLog = path.join(logDir, `serial-${stamp}.log`);
  const fd = fs.openSync(qemuLog, "a");

  // 命令行整段在 qemuVmArgs 里拼（纯函数可断言）；这里只算好它要的输入
  const args = qemuVmArgs({ ...options, token, serialLog });

  const child = spawn(paths.qemu, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);
  if (child.pid === undefined) throw new Error(cuTexts().qemuSpawnNoPid);
  return { pid: child.pid, ports, token, qemuLog, serialLog, args, spawnedAt: Date.now() };
}

export function vmAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 与 QEMU HMP 说一句（只用于 quit）。连不上 = monitor 端口没在听（VM 已经没了） */
export function qemuMonitor(port: number, text: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(cuTexts().qemuMonitorTimeout));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(text);
      // HMP 没有命令结束标记；等一小会儿把回显收全就断开
      setTimeout(() => {
        clearTimeout(timer);
        socket.destroy();
        resolve(buffer);
      }, 300);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

/**
 * 停一台实例：先请 guest 自己 quit（HMP 的 quit = 立刻断电式退出，ext4 有日志能自愈；
 * live savevm/loadvm 在 WHPX 下不可用，所以本来也没有「优雅关机」这一档），
 * 等 15s 还不走就按 **自己的 pid** 补一刀。 */
export async function stopQemuVm(handle: QemuVmHandle, waitMs = 15_000): Promise<{ stopped: boolean; forced: boolean }> {
  if (!vmAlive(handle.pid)) return { stopped: false, forced: false };
  await qemuMonitor(handle.ports.monitor, "quit\n").catch(() => undefined);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && vmAlive(handle.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const alive = vmAlive(handle.pid);
  if (alive) {
    try {
      process.kill(handle.pid);
    } catch {
      // 已经退了
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { stopped: true, forced: alive };
}
