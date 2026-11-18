/**
 * 造 P3 桌面镜像：宿主侧 apk 镜像代理 + 一次「ramdisk 里给真磁盘装 Alpine」的 QEMU 运行。
 *
 *   node scripts/p3-desktop/build-image.mjs [--force] [--mem 2048] [--smp 4]
 *
 * 前提：宿主能访问 dl-cdn.alpinelinux.org（guest 出不去外网，所以包在宿主下载/缓存，
 * guest 通过 slirp 网关 10.0.2.2 从宿主取）。QEMU 路径见 config.mjs。
 *
 * 为什么要代理而不是直接「宿主下载一堆 apk 再塞进 guest」：apk 的依赖求解、冲突处理、
 * post-install 脚本只有 Alpine 自己能跑对；把仓库地址指到宿主代理，guest 里的 apk 就是
 * 原生行为，宿主只负责转发 + 落缓存（同一批包只下一次）。
 *
 * 产物只写 ORBITA_P3_IMAGE_DIR（默认 %APPDATA%\orbita\p3-desktop），不写仓里。
 */
import { spawn, spawnSync } from "node:child_process";
import { startMirror } from "./apk-mirror.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  ALPINE_ARCH,
  ALPINE_BRANCH,
  CACHE_DIR,
  DISK,
  IMAGE_DIR,
  INITRD,
  KERNEL,
  MIRROR_PORT,
  QEMU,
  QEMU_IMG,
} from "./config.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const MEM = valueOf("--mem") ?? "2048";
const SMP = valueOf("--smp") ?? "4";
const DISK_SIZE = valueOf("--disk-size") ?? "8G";

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 串口驱动 */

/**
 * 8250 UART 没有流控：整行灌进去会丢字符（P3-1 实测）。所以逐 4 字节、每片 12ms 发送。
 * 结束判据是「再看到一次提示符 / 目标标记」，不是字符串匹配。
 */
function startVm() {
  const qemuArgs = [
    "-name",
    "orbita-p3-build",
    "-accel",
    "whpx",
    "-m",
    MEM,
    "-smp",
    SMP,
    "-nographic",
    "-no-reboot",
    "-kernel",
    KERNEL,
    "-initrd",
    INITRD,
    "-append",
    "console=ttyS0 rdinit=/init orbita.mode=build loglevel=4",
    "-drive",
    `file=${DISK},if=none,id=d0,cache=writeback,discard=unmap`,
    "-device",
    "virtio-blk-pci,drive=d0",
    "-netdev",
    "user,id=n0",
    "-device",
    "virtio-net-pci,netdev=n0",
  ];
  const child = spawn(QEMU, qemuArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiters = [];
  const startedAt = Date.now();
  const push = (s) => {
    buf += s;
    // 只把造盘进度打出来，内核日志太吵
    for (const line of s.split(/[\r\n]+/)) {
      if (/^(BUILD|ORBITA|BUILD_OK|BUILD_FAIL)/.test(line.trim())) console.log(line.trim());
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.any) {
        const hit = w.any.find((n) => buf.indexOf(n, w.from) >= 0);
        if (hit) {
          waiters.splice(i, 1);
          w.resolve(hit);
        }
        continue;
      }
      const idx = buf.indexOf(w.needle, w.from);
      if (idx >= 0) {
        w.from = idx + w.needle.length;
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(idx);
      }
    }
  };
  child.stdout.on("data", (c) => push(c.toString("utf8")));
  child.stderr.on("data", (c) => push(c.toString("utf8")));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const waitFor = (needle, ms, from = 0) => {
    const hit = buf.indexOf(needle, from);
    if (hit >= 0) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.needle === needle);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`超时 ${Math.round(ms / 1000)}s 等待 ${JSON.stringify(needle)}`));
      }, ms);
      waiters.push({ needle, from, resolve, timer });
    });
  };

  const waitForAny = (needles, ms, from) => {
    const found = needles
      .map((n) => ({ n, i: buf.indexOf(n, from) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i);
    if (found.length) return Promise.resolve(found[0].n);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const w of waiters.filter((x) => x.any === needles)) {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
        }
        reject(new Error(`超时 ${Math.round(ms / 1000)}s 等待 ${needles.join(" | ")}`));
      }, ms);
      waiters.push({ needle: null, from, any: needles, timer, resolve: (n) => { clearTimeout(timer); resolve(n); } });
    });
  };

  const typeLine = async (line) => {
    const bytes = Buffer.from(`${line}\n`, "utf8");
    for (let i = 0; i < bytes.length; i += 4) {
      child.stdin.write(bytes.subarray(i, i + 4));
      await sleep(12);
    }
  };

  return { child, exit, buf: () => buf, waitFor, waitForAny, typeLine, startedAt };
}

/* ------------------------------------------------------------------ 主流程 */

function ensureRamdisk() {
  if (fs.existsSync(KERNEL) && fs.existsSync(INITRD)) return;
  console.log("[build] 没有内核/initramfs，先跑 build-ramdisk.mjs");
  const r = spawnSync(process.execPath, [path.join(HERE, "build-ramdisk.mjs")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("build-ramdisk 失败");
}

/** 宿主 initramfs 里的模块版本 = 缓存里那份 linux-virt apk 的版本；guest 必须装同一个版本，
 *  否则模块 vermagic 不匹配，Xorg 一启动就死在找不到 virtio_gpu。 */
function kernelPkgVersion() {
  const apk = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => /^linux-virt-.*\.apk$/.test(f))
    .sort()
    .pop();
  if (!apk) throw new Error("缓存里没有 linux-virt apk，先跑 build-ramdisk.mjs");
  return apk.replace(/^linux-virt-/, "").replace(/\.apk$/, "");
}

function makeDisk() {
  if (fs.existsSync(DISK) && !FORCE) return fs.statSync(DISK).size;
  if (fs.existsSync(DISK)) fs.rmSync(DISK);
  const r = spawnSync(QEMU_IMG, ["create", "-f", "qcow2", DISK, DISK_SIZE], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`qemu-img create 失败: ${r.stderr ?? r.stdout}`);
  return fs.statSync(DISK).size;
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const exe of [QEMU, QEMU_IMG]) {
    if (!fs.existsSync(exe)) throw new Error(`找不到 ${exe}（用 ORBITA_P3_QEMU_DIR 指到 QEMU 解压根）`);
  }
  ensureRamdisk();
  const kver = kernelPkgVersion();
  console.log(`[build] 镜像盘 ${DISK}（${DISK_SIZE}），linux-virt=${kver}`);

  const mirror = await startMirror();
  console.log(`[build] apk 镜像代理 127.0.0.1:${MIRROR_PORT}（guest 侧 http://10.0.2.2:${MIRROR_PORT}）`);
  const diskBytes0 = makeDisk();
  console.log(`[build] 起始磁盘 ${(diskBytes0 / 1048576).toFixed(1)}MiB`);

  const t0 = Date.now();
  const vm = startVm();
  const logs = [];
  const record = setInterval(() => {
    if (vm.buf().length > logs[logs.length - 1]?.length) logs.push(vm.buf());
  }, 5000);

  try {
    await vm.waitFor("ORBITA_BUILD_SHELL_READY", 120_000);
    console.log(`[build] ramdisk shell 就绪 ${Date.now() - t0}ms`);

    const bootstrap = [
      "modprobe virtio_net",
      "ip link set eth0 up",
      "udhcpc -i eth0 -q -n -t 5 -s /usr/share/udhcpc/default.script >/dev/null 2>&1; echo NET_RC=$?",
      "modprobe virtio_blk",
      "modprobe ext4",
      "ls /dev/vd* 2>&1 | head -2",
      `wget -q -O /tmp/s.sh http://10.0.2.2:${MIRROR_PORT}/build/guest-setup.sh && echo GOT_SCRIPT || echo WGET_FAILED`,
    ];
    for (const line of bootstrap) {
      await vm.typeLine(line);
      if (line.startsWith("udhcpc")) await vm.waitFor("NET_RC=", 60_000, Math.max(0, vm.buf().length - 4096));
      else if (line.startsWith("wget")) await vm.waitFor("GOT_SCRIPT", 60_000, Math.max(0, vm.buf().length - 4096));
      else await sleep(400);
    }

    await vm.typeLine(`sh /tmp/s.sh ${MIRROR_PORT} ${kver}`);
    console.log("[build] 开始装包（这一步会拉 XFCE/Chromium/字体，几分钟）");
    // 两个标记一起等：只看 BUILD_OK 的话，脚本一旦提前 fail，这里会空转到整体超时
    const deadline = Date.now() + 45 * 60_000;
    for (;;) {
      const from = Math.max(0, vm.buf().length - 4096);
      const hit = await vm
        .waitForAny(["BUILD_OK", "BUILD_FAIL"], Math.min(120_000, Math.max(1000, deadline - Date.now())), from)
        .catch(() => null);
      if (hit) break;
      if (Date.now() > deadline) throw new Error("造盘总超时（45 分钟）");
    }
    if (vm.buf().includes("BUILD_FAIL")) throw new Error("guest 侧 BUILD_FAIL，见串口尾部");
    console.log(`[build] BUILD_OK 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (cause) {
    const tail = vm.buf().slice(-4000);
    console.error(`[build] 失败：${cause.message}`);
    console.error("---- 串口尾部 ----");
    console.error(tail);
    throw cause;
  } finally {
    clearInterval(record);
    try {
      vm.child.stdin.write("poweroff -f\n");
    } catch {
      /* 已退出 */
    }
    const exited = await Promise.race([vm.exit, sleep(20_000).then(() => null)]);
    if (!exited) vm.child.kill();
    await mirror.close();
  }

  const bytes = fs.statSync(DISK).size;
  console.log(
    JSON.stringify(
      {
        disk: DISK,
        diskMiB: +(bytes / 1048576).toFixed(1),
        budgetMiB: 1126,
        withinBudget: bytes <= 1126 * 1048576,
        linuxVirt: kver,
        mirrorCache: mirror.stats,
      },
      null,
      2,
    ),
  );
}

await main();
