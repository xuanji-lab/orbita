/**
 * P3 桌面 VM 的路径与端口约定。所有脚本只从这里取路径，别在别处硬编码。
 *
 * 产物（内核、initramfs、qcow2 镜像、apk 缓存）一律在仓外：
 * 默认 %APPDATA%\orbita\p3-desktop，可用 ORBITA_P3_IMAGE_DIR 改。
 * QEMU 用解压版（不带安装器、不改 PATH），路径必须用 ORBITA_P3_QEMU_DIR 指到解压根
 * （即含 root\mingw64\bin\qemu-system-x86_64.exe 的那一层）。
 */
import path from "node:path";

const APPDATA = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");

/** 所有产物与缓存的根目录（仓外） */
export const IMAGE_DIR = process.env.ORBITA_P3_IMAGE_DIR ?? path.join(APPDATA, "orbita", "p3-desktop");
/** MSYS2 解压包根：<此目录>/root/mingw64/bin/qemu-system-x86_64.exe */
export const QEMU_DIR = process.env.ORBITA_P3_QEMU_DIR ?? path.join(IMAGE_DIR, "qemu");
export const QEMU = path.join(QEMU_DIR, "root", "mingw64", "bin", "qemu-system-x86_64.exe");
export const QEMU_IMG = path.join(QEMU_DIR, "root", "mingw64", "bin", "qemu-img.exe");

/** 桌面系统的磁盘（ext4 on 整盘，无分区表；overlay 快照以后另建） */
export const DISK = path.join(IMAGE_DIR, "desktop.qcow2");
/** 直启内核与 initramfs（都从 linux-virt apk 里拆出来，保证与 guest 的 /lib/modules 同版本） */
export const KERNEL = path.join(IMAGE_DIR, "vmlinuz-virt");
export const INITRD = path.join(IMAGE_DIR, "initramfs-orbita.cpio.gz");
/** 下载缓存（apk 包、minirootfs、APKINDEX） */
export const CACHE_DIR = path.join(IMAGE_DIR, "cache");

/** Alpine 版本。改这里等于换整个镜像基线，别只改一半 */
export const ALPINE_RELEASE = "3.22.8";
export const ALPINE_BRANCH = "v3.22";
export const ALPINE_ARCH = "x86_64";
export const CDN = "https://dl-cdn.alpinelinux.org/alpine";

/** 宿主侧 apk 镜像代理端口（guest 用 slirp 的 10.0.2.2 访问宿主回环） */
export const MIRROR_PORT = Number(process.env.ORBITA_P3_MIRROR_PORT ?? 5420);
/**
 * 桌面画面走 guest 内的 Xvnc（X 渲染到内存 + RFB），宿主拿到的是**宿主端口**：
 * QEMU `-netdev user,hostfwd=tcp:127.0.0.1:5919-:5900` 把 guest 的 5900 映过来。
 * 不走 QEMU 的 `-vnc` 呈现桌面：QEMU 10/Windows 下那个 VNC 只给 VGA 文本 console，
 * guest 的图形 console 帧根本不出现（详见 xvnc-setup.sh 头注释）。
 */
export const DESKTOP_RFB_PORT = Number(process.env.ORBITA_P3_RFB_PORT ?? 5919);
export const GUEST_RFB_PORT = 5900;
/** QEMU 自带 VNC 只留作「看 guest 的文本 console」的备用口 */
export const CONSOLE_VNC_DISPLAY = Number(process.env.ORBITA_P3_CONSOLE_VNC_DISPLAY ?? 18);
export const CONSOLE_VNC_PORT = 5900 + CONSOLE_VNC_DISPLAY;
/** noVNC 的 HTTP/WS 端口 */
export const NOVNC_PORT = Number(process.env.ORBITA_P3_NOVNC_PORT ?? 6080);

/** 桌面分辨率：QEMU 的 EDID 首选模式，Xorg modesetting 会直接采这个 */
export const SCREEN_W = 1280;
export const SCREEN_H = 800;

export const GUEST = {
  /** 直启根设备：整盘 ext4，没有分区表 */
  root: "/dev/vda",
  /** guest 里看到的宿主（slirp 固定网关） */
  host: "10.0.2.2",
};

/** 桌面实例的控制面：串口（人工/调试）与 QEMU monitor 都绑回环 */
export const SERIAL_PORT = Number(process.env.ORBITA_P3_SERIAL_PORT ?? 5499);
export const MONITOR_PORT = Number(process.env.ORBITA_P3_MONITOR_PORT ?? 5498);
/** 运行态文件（pid/端口/日志路径），由 run-desktop.mjs 写、其它脚本读 */
export const STATE_FILE = path.join(IMAGE_DIR, "desktop-state.json");
export const LOG_DIR = path.join(IMAGE_DIR, "logs");
export const SHOT_DIR = path.join(IMAGE_DIR, "shots");
