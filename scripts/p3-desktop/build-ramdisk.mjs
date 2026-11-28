/**
 * 造 initramfs + 取内核：把 Alpine minirootfs、linux-virt 的 /lib/modules、直启 init 拼成
 * 一个 cpio.gz，同时从同一个 linux-virt apk 里拆出 bzImage。
 *
 * 全程在内存里转码：Windows 上解不出符号链接与设备节点，解包到磁盘再打包会掉条目
 * （Alpine 3.22 的 /bin、/lib 都是符号链接）。
 *
 *   node scripts/p3-desktop/build-ramdisk.mjs
 *
 * 产物：<IMAGE_DIR>/initramfs-orbita.cpio.gz、<IMAGE_DIR>/vmlinuz-virt
 * 依赖：宿主能访问 dl-cdn.alpinelinux.org（guest 出不去外网，这一步必须在宿主做）。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ALPINE_ARCH, ALPINE_BRANCH, ALPINE_RELEASE, CACHE_DIR, CDN, IMAGE_DIR, INITRD, KERNEL } from "./config.mjs";

const S_IF = { dir: 0o040000, reg: 0o100000, lnk: 0o120000, chr: 0o020000, blk: 0o060000, fifo: 0o010000 };

/** tar 头里这个 type 对应什么 */
const TAR_KIND = { "0": "reg", "\0": "reg", 1: "hard", 2: "lnk", 3: "chr", 4: "blk", 5: "dir", 6: "fifo" };

function readBase256(b) {
  let v = 0;
  for (let i = 1; i < b.length; i++) v = v * 256 + b[i];
  return v;
}

/**
 * 解 tar。APK 文件是「签名 tar + control tar + data tar」三段 gzip 成员拼起来的，
 * 一次 gunzip 得到的是三个首尾相接、各自 512 对齐的 tar；所以遇到全零块不能当结束，
 * 只跳过它继续（真正的结束是文件尾）。
 */
function parseTar(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  let longLink = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      off += 512;
      continue;
    }
    const str = (a, b) => h.toString("utf8", a, b).replace(/\0.*$/s, "");
    const oct = (a, b) => parseInt(h.toString("utf8", a, b).replace(/\0.*$/s, "").trim() || "0", 8);
    const size = h[124] & 0x80 ? readBase256(h.subarray(124, 136)) : oct(124, 136);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    const name = (prefix ? `${prefix}/` : "") + str(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "K") {
      longLink = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x" || type === "g") continue;
    const realName = (longName ?? name).replace(/^\.\//, "").replace(/\/$/, "");
    const realLink = longLink ?? str(157, 257);
    longName = null;
    longLink = null;
    if (!realName) continue;
    const kind = TAR_KIND[type] ?? "reg";
    out.push({
      name: realName,
      kind,
      mode: oct(100, 108) & 0o7777,
      mtime: oct(136, 148),
      data: kind === "reg" ? Buffer.from(body) : Buffer.alloc(0),
      link: kind === "lnk" ? realLink : "",
      hardTarget: kind === "hard" ? realName : null,
    });
    if (kind === "hard") out[out.length - 1].hardTarget = realLink.replace(/^\.\//, "");
  }
  return out;
}

/** 写 newc cpio。nlink 一律 1：照抄源里的 nlink>1 会让内核等另一个 hardlink 条目，
 *  结果整段条目解不出来（P3-1 实测 /lib/modules 整棵消失且无报错）。 */
function writeCpio(entries) {
  const chunks = [];
  let ino = 1;
  const byName = new Map();
  const have = new Set(entries.map((e) => e.name));
  const withParents = [];
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!have.has(dir)) {
        have.add(dir);
        withParents.push({ name: dir, kind: "dir", mode: 0o755, mtime: 0, data: Buffer.alloc(0), link: "" });
      }
    }
    withParents.push(e);
  }
  for (const e of withParents) {
    let data = e.data ?? Buffer.alloc(0);
    let nlink = 1;
    if (e.kind === "hard") {
      const target = byName.get(e.hardTarget);
      if (!target) continue;
      data = target.data;
      nlink = 2;
    }
    const mode =
      (e.kind === "dir" ? S_IF.dir : e.kind === "lnk" ? S_IF.lnk : e.kind === "chr" ? S_IF.chr : e.kind === "blk" ? S_IF.blk : e.kind === "fifo" ? S_IF.fifo : S_IF.reg) |
      e.mode;
    const payload =
      e.kind === "lnk" ? Buffer.from(e.link ?? "", "utf8") : e.kind === "reg" || e.kind === "hard" ? data : Buffer.alloc(0);
    const nameBuf = Buffer.from(`${e.name}\0`, "utf8");
    const header = Buffer.alloc(110);
    const fields = [ino++, mode, 0, 0, nlink, Math.round(e.mtime ?? 0), payload.length, 0, 0, 0, 0, nameBuf.length, 0];
    header.write("070701", 0, "ascii");
    fields.forEach((v, i) => header.write(v.toString(16).padStart(8, "0"), 6 + i * 8, "ascii"));
    chunks.push(header, nameBuf);
    const pad1 = (4 - ((110 + nameBuf.length) % 4)) % 4;
    if (pad1) chunks.push(Buffer.alloc(pad1));
    if (payload.length > 0) {
      chunks.push(payload);
      const pad2 = (4 - (payload.length % 4)) % 4;
      if (pad2) chunks.push(Buffer.alloc(pad2));
    }
    if (e.kind === "reg" || e.kind === "hard") byName.set(e.name, { data: payload });
  }
  const tail = Buffer.from("TRAILER!!!\0", "utf8");
  const tailHeader = Buffer.alloc(110);
  tailHeader.write("070701", 0, "ascii");
  tailHeader.write(tail.length.toString(16).padStart(8, "0"), 6 + 11 * 8, "ascii");
  chunks.push(tailHeader, tail);
  const tailPad = (4 - ((110 + tail.length) % 4)) % 4;
  if (tailPad) chunks.push(Buffer.alloc(tailPad));
  return Buffer.concat(chunks);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return dest;
    } catch (cause) {
      if (attempt === 4) throw new Error(`下载失败 ${url}: ${cause.message}`);
      await sleep(1500 * attempt);
    }
  }
  return dest;
}

/** 从 APKINDEX 里取 main 仓库的包版本号与文件名 */
async function resolveMainPackage(name) {
  const idxPath = path.join(CACHE_DIR, `main-${ALPINE_ARCH}-APKINDEX.tar.gz`);
  await download(`${CDN}/${ALPINE_BRANCH}/main/${ALPINE_ARCH}/APKINDEX.tar.gz`, idxPath);
  const text = zlib.gunzipSync(fs.readFileSync(idxPath)).toString("utf8");
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("P:")) cur = { name: line.slice(2) };
    else if (cur && line.startsWith("V:")) cur.version = line.slice(2);
    else if (cur && line.startsWith("S:")) cur.size = +line.slice(2);
    else if (cur && line === "" && cur.version && cur.name === name) {
      return { version: cur.version, file: `${name}-${cur.version}.apk`, size: cur.size };
    }
  }
  throw new Error(`APKINDEX 里找不到 ${name}`);
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const miniUrl = `${CDN}/${ALPINE_BRANCH}/releases/${ALPINE_ARCH}/alpine-minirootfs-${ALPINE_RELEASE}-${ALPINE_ARCH}.tar.gz`;
  const miniPath = path.join(CACHE_DIR, `alpine-minirootfs-${ALPINE_RELEASE}-${ALPINE_ARCH}.tar.gz`);
  console.log(`[ramdisk] minirootfs ← ${miniUrl}`);
  await download(miniUrl, miniPath);

  const kv = await resolveMainPackage("linux-virt");
  const apkPath = path.join(CACHE_DIR, kv.file);
  console.log(`[ramdisk] linux-virt ${kv.version} ← ${CDN}/${ALPINE_BRANCH}/main/${ALPINE_ARCH}/${kv.file}`);
  await download(`${CDN}/${ALPINE_BRANCH}/main/${ALPINE_ARCH}/${kv.file}`, apkPath);

  const base = parseTar(zlib.gunzipSync(fs.readFileSync(miniPath)));
  const apk = parseTar(zlib.gunzipSync(fs.readFileSync(apkPath)));

  const kernelEntry = apk.find((e) => e.name === "boot/vmlinuz-virt");
  if (!kernelEntry) throw new Error("linux-virt apk 里没有 boot/vmlinuz-virt");
  const modDirEntry = apk.find((e) => /^lib\/modules\/[^/]+$/.test(e.name));
  if (!modDirEntry) throw new Error("linux-virt apk 里没有 lib/modules/<ver>");
  const modVer = modDirEntry.name.split("/")[2];
  console.log(`[ramdisk] kernel release = ${modVer}, bzImage ${(kernelEntry.data.length / 1048576).toFixed(1)}MiB`);

  // 整棵 /lib/modules 都带上：45MiB、压缩后十几 MiB，换来「modprobe 直接可用」——
  // 比在造盘阶段维护一份模块依赖清单省事，也不会漏掉 jbd2 这种 ext4 的隐式依赖。
  const mods = apk.filter((e) => e.name === "lib/modules" || e.name.startsWith("lib/modules/"));
  const initScript = fs.readFileSync(new URL("./ramdisk-init.sh", import.meta.url), "utf8");
  const extra = [
    { name: "init", kind: "reg", mode: 0o755, mtime: 0, data: Buffer.from(initScript), link: "" },
    // 直启时内核要用 /dev/console；devtmpfs 挂上后已经有了，这里不造节点
  ];

  const seen = new Set();
  const merged = [];
  for (const e of [...base, ...mods, ...extra]) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    merged.push(e);
  }

  const cpio = writeCpio(merged);
  const gz = zlib.gzipSync(cpio, { level: 6 });
  fs.writeFileSync(INITRD, gz);
  fs.writeFileSync(KERNEL, kernelEntry.data);

  console.log(
    JSON.stringify(
      {
        kernel: { path: KERNEL, bytes: kernelEntry.data.length },
        initramfs: { path: INITRD, bytes: gz.length },
        entries: merged.length,
        modules: mods.length,
        modVer,
      },
      null,
      2,
    ),
  );
}

await main();
