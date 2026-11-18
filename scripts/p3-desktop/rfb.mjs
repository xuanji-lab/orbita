/**
 * 最小 RFB（VNC）客户端。P3-2 的两条判据都靠它取证：
 *   ① 能看到桌面 —— 把 QEMU `-vnc` 的帧缓冲抓成 PNG；
 *   ② 能点能打字 —— 发 PointerEvent / KeyEvent，再抓一张看结果。
 *
 * 只实现 raw 编码（环回上够用、且不会被编码器差异干扰判读）。请求 pixel format
 * 32bpp / 24 深度 / 真彩 / 小端 / R16 G8 B0，读到 4 字节小端整数直接取通道。
 *
 *   node scripts/p3-desktop/rfb.mjs shot <port> <out.png>
 *   node scripts/p3-desktop/rfb.mjs watch <port>        # 等到桌面可见，打印耗时
 */
import fs from "node:fs";
import net from "node:net";
import { encodePng } from "./png.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RfbClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.width = 0;
    this.height = 0;
    this.name = "";
    this.fb = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    });
    socket.on("close", () => {
      for (const w of this.waiters.splice(0)) w.reject(new Error("VNC 连接已关闭"));
    });
    socket.on("error", (e) => {
      for (const w of this.waiters.splice(0)) w.reject(e);
    });
  }

  pump() {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (this.buf.length >= w.need) {
        const out = this.buf.subarray(0, w.need);
        this.buf = this.buf.subarray(w.need);
        this.waiters.splice(i, 1);
        i--;
        w.resolve(out);
      }
    }
  }

  read(need) {
    if (this.buf.length >= need) {
      const out = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`RFB 读超时（要 ${need} 字节，只有 ${this.buf.length}）`));
      }, 15000);
      this.waiters.push({ need, resolve, reject, timer });
    });
  }

  send(bytes) {
    this.socket.write(bytes);
  }

  /**
   * QEMU 的 VNC 同一时刻只服务一个客户端：连上之后监听 socket 会被关掉，客户端断开的
   * 那一瞬新连接会 ECONNREFUSED。所以这里必须重试，不能先探活再连（探活本身就会把
   * 监听关一次，实测随后必失败）。
   */
  static async connectRetry({ host = "127.0.0.1", port, timeoutMs = 60_000, onWait }) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        return await RfbClient.connect({ host, port, timeoutMs: 5000 });
      } catch (e) {
        last = e;
        onWait?.(e.message, Date.now() - t0);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(`连不上 VNC 127.0.0.1:${port}（${Math.round(timeoutMs / 1000)}s）：${last?.message}`);
  }

  static async connect({ host = "127.0.0.1", port, timeoutMs = 15000 }) {
    const socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`连接 VNC ${host}:${port} 超时`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const client = new RfbClient(socket);
    try {
      await client.handshake();
    } catch (cause) {
      client.close();
      throw cause;
    }
    return client;
  }

  async handshake() {
    const version = (await this.read(12)).toString("ascii");
    if (!version.startsWith("RFB ")) throw new Error(`不是 RFB 服务：${JSON.stringify(version)}`);
    this.serverVersion = version.trim();
    const minor = Number(version.slice(8, 11));
    this.send(Buffer.from("RFB 003.008\n", "ascii"));

    const nsec = (await this.read(1))[0];
    if (nsec === 0) {
      const len = (await this.read(4)).readUInt32BE(0);
      throw new Error(`服务器拒绝：${(await this.read(len)).toString("utf8")}`);
    }
    const types = [...(await this.read(nsec))];
    if (!types.includes(1)) throw new Error(`只支持 None 认证，服务器给的是 ${types.join(",")}`);
    this.send(Buffer.from([1]));
    if (minor >= 8) {
      const result = (await this.read(4)).readUInt32BE(0);
      if (result !== 0) {
        const len = (await this.read(4)).readUInt32BE(0);
        throw new Error(`认证失败：${(await this.read(len)).toString("utf8")}`);
      }
    }
    this.send(Buffer.from([1])); // shared

    const head = await this.read(24);
    this.width = head.readUInt16BE(0);
    this.height = head.readUInt16BE(2);
    const nameLen = head.readUInt32BE(20);
    this.name = (await this.read(nameLen)).toString("utf8");
    this.fb = Buffer.alloc(this.width * this.height * 4);

    // SetPixelFormat: 32bpp / 24 深度 / 真彩 / 小端 / R16 G8 B0
    // SetPixelFormat: type(1)+pad(3)+16 字节 pixel-format。注意 r/g/b max 各占 **2 字节**，
    // 少写一个字节会整体错位，TigerVNC 直接拒收："Invalid pixel format"（实测）。
    const setPf = Buffer.alloc(20);
    setPf[0] = 0; // SetPixelFormat
    setPf[4] = 32; // bits-per-pixel
    setPf[5] = 24; // depth
    setPf[6] = 0; // big-endian
    setPf[7] = 1; // true colour
    setPf.writeUInt16BE(255, 8); // red max
    setPf.writeUInt16BE(255, 10); // green max
    setPf.writeUInt16BE(255, 12); // blue max
    setPf[14] = 16; // red shift
    setPf[15] = 8; // green shift
    setPf[16] = 0; // blue shift
    this.send(setPf);
    // SetEncodings: type(1) + padding(2 字节) + count(2) —— 等等，RFC 是
    // type(1)+padding(1)+count(2)+count*4，总数 4+4n 字节；多写/少写都会让 QEMU 把后面的
    // 字节当成下一条客户端消息，整条流错位（实测卡死）。
    // 登记两个编码：raw(0) 与 DesktopSize(-223)。**必须**登记 -223，否则 guest 改分辨率
    // 时服务器只按键序发新尺寸的帧，客户端还按旧尺寸组帧 —— 画面全错位，看起来像
    // 「花屏 / 永远停在 BIOS 启动画面」（实测踩到）。
    const encodings = Buffer.alloc(4 + 2 * 4);
    encodings[0] = 2;
    encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(0, 4);
    encodings.writeInt32BE(-223, 8);
    this.send(encodings);
  }

  /** 请求一帧并读一个 FramebufferUpdate；incremental=false 时服务器会重发脏区 */
  async update(incremental = false, depth = 0) {
    const req = Buffer.alloc(10);
    req[0] = 3;
    req[1] = incremental ? 1 : 0;
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(0, 4);
    req.writeUInt16BE(this.width, 6);
    req.writeUInt16BE(this.height, 8);
    this.send(req);
    for (;;) {
      const type = (await this.read(1))[0];
      if (type === 0) {
        const pad = await this.read(1);
        void pad;
        const nrects = (await this.read(2)).readUInt16BE(0);
        let resized = false;
        for (let i = 0; i < nrects; i++) {
          const r = await this.read(12);
          const x = r.readUInt16BE(0);
          const y = r.readUInt16BE(2);
          const w = r.readUInt16BE(4);
          const h = r.readUInt16BE(6);
          const enc = r.readInt32BE(8);
          if (enc === 0) {
            const data = await this.read(w * h * 4);
            for (let row = 0; row < h; row++) {
              const dy = y + row;
              if (dy < 0 || dy >= this.height) continue;
              const dstOff = (dy * this.width + x) * 4;
              const srcOff = row * w * 4;
              data.copy(this.fb, dstOff, srcOff, srcOff + w * 4);
            }
          } else if (enc === -223) {
            // DesktopSize：guest 改分辨率。旧帧作废，立刻补一帧全量，否则后续 blit 全错位。
            this.width = w;
            this.height = h;
            this.fb = Buffer.alloc(w * h * 4);
            resized = true;
          } else if (enc === 1) {
            throw new Error("收到 CopyRect 但没请求编码 1");
          } else {
            throw new Error(`不支持的编码 ${enc}`);
          }
        }
        if (resized && depth < 3) return this.update(false, depth + 1);
        return nrects;
      }
      if (type === 1) {
        const h = await this.read(4);
        const n = h.readUInt16BE(2);
        await this.read(n * 6);
        continue;
      }
      if (type === 2) continue;
      if (type === 3) {
        const l = await this.read(7);
        await this.read(l.readUInt32BE(3));
        continue;
      }
      throw new Error(`未知服务器消息 ${type}`);
    }
  }

  /** 帧缓冲里「非近黑」像素占比 + 颜色种类，用来判「画面里真有东西」 */
  stats() {
    let lit = 0;
    const colors = new Set();
    const step = 4;
    for (let i = 0; i < this.fb.length; i += 4 * step) {
      const b = this.fb[i];
      const g = this.fb[i + 1];
      const r = this.fb[i + 2];
      if (r > 12 || g > 12 || b > 12) lit++;
      if (colors.size < 4000) colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
    }
    const total = Math.floor(this.fb.length / (4 * step));
    return { litRatio: lit / total, colors: colors.size };
  }

  /**
   * 等到「桌面真的画出来了」：非黑像素 > 12% 且颜色够杂，并连续两次稳定。
   * 纯黑（没起 X）、纯色（只起了根窗口）都会被这条挡掉。
   *
   * 断线要能自愈：guest 刚启动时 slirp 的 hostfwd 已经接受 TCP，但 guest 里的 Xvnc 还没
   * 在听，连接会被直接关掉；hostfwd 在 guest 重启时也会断，所以这里遇错就重连，不向外抛。
   */
  async waitForDesktop({ timeoutMs = 120_000, pollMs = 400, onSample, reconnect = true } = {}) {
    const t0 = Date.now();
    let last = null;
    let stable = 0;
    while (Date.now() - t0 < timeoutMs) {
      try {
        await this.update(false);
      } catch (cause) {
        if (!reconnect) throw cause;
        await sleep(400);
        continue;
      }
      const s = this.stats();
      onSample?.(s, Date.now() - t0);
      if (s.litRatio > 0.12 && s.colors > 40) {
        stable = last && Math.abs(last.litRatio - s.litRatio) < 0.02 && Math.abs(last.colors - s.colors) < 20 ? stable + 1 : 0;
        if (stable >= 1) return { ms: Date.now() - t0, ...s };
      } else {
        stable = 0;
      }
      last = s;
      await sleep(pollMs);
    }
    throw new Error(`等待桌面超时；最后一次采样 ${JSON.stringify(this.stats())}`);
  }

  screenshot(file) {
    // VNC 给的是 BGRX（小端 0x00RRGGBB），PNG 要 R,G,B,A —— 而且 alpha 必须写 255：
    // 全零帧的 alpha=0 会让图片透明，看起来像「白屏」，把「根本没有画面」误读成「白底」。
    const rgba = Buffer.alloc(this.width * this.height * 4);
    for (let i = 0; i < this.fb.length; i += 4) {
      rgba[i] = this.fb[i + 2];
      rgba[i + 1] = this.fb[i + 1];
      rgba[i + 2] = this.fb[i];
      rgba[i + 3] = 255;
    }
    const png = encodePng(this.width, this.height, rgba);
    fs.writeFileSync(file, png);
    return { file, width: this.width, height: this.height, bytes: png.length };
  }

  pointer(x, y, mask = 0) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.send(b);
  }

  key(keysym, down) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.send(b);
  }

  /**
   * 点击。按压必须**停够 200ms**：Xvnc 下 90ms 的 press/release 会被面板当成没发生
   * （实测同样坐标、同一条连接，短按压菜单不开，长按压稳定打开）。
   */
  async click(x, y, { settleMs = 250 } = {}) {
    // 先落一个「附近」的移动：Xvnc 对「连接后的第一个绝对坐标 + 立刻按下」会丢 enter/position，
    // 菜单根本不弹（实测：同一条连接里先走一步再点就稳定生效）。
    this.pointer(Math.min(x + 60, this.width - 1), Math.min(y + 40, this.height - 1), 0);
    await sleep(120);
    this.pointer(x, y, 0);
    await sleep(140);
    this.pointer(x, y, 1);
    await sleep(200);
    this.pointer(x, y, 0);
    await sleep(settleMs);
  }

  async moveTo(x, y) {
    this.pointer(x, y, 0);
    await sleep(60);
  }

  /** 只支持可直接用 keysym 表达的可打印 ASCII 与回车/退格 */
  async typeText(text, { perCharMs = 45 } = {}) {
    for (const ch of text) {
      let sym = ch.codePointAt(0);
      if (ch === "\n") sym = 0xff0d;
      else if (ch === "\t") sym = 0xff09;
      if (sym < 0x20 || sym > 0x7e) throw new Error(`typeText 只接受可打印 ASCII，收到 ${JSON.stringify(ch)}`);
      this.key(sym, true);
      await sleep(perCharMs / 2);
      this.key(sym, false);
      await sleep(perCharMs / 2);
    }
  }

  close() {
    this.socket.destroy();
  }
}

/* ------------------------------------------------ CLI（取证用，不参与运行时） */

/** 命令行入口：argv = [node, script, cmd, port, arg, out] */
const isCli = process.argv[1] ? process.argv[1].replaceAll("\\", "/").endsWith("/rfb.mjs") : false;
if (isCli) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const port = Number(argv[1]);
  const arg = argv[2];
  const out = argv[3];
  const shotOut = out ?? "shot.png";
  if (cmd === "shot") {
    const c = await RfbClient.connect({ port });
    await c.update(false);
    console.log(JSON.stringify({ ...c.screenshot(arg ?? "shot.png"), size: `${c.width}x${c.height}`, server: c.serverVersion, name: c.name }));
    c.close();
  } else if (cmd === "click") {
    const c = await RfbClient.connect({ port });
    await c.update(false);
    await c.click(Number(arg), Number(out));
    await c.update(false);
    console.log(JSON.stringify(c.screenshot(argv[4] ?? "click.png")));
    c.close();
  } else if (cmd === "type") {
    const c = await RfbClient.connect({ port });
    await c.typeText(arg);
    await c.update(false);
    console.log(JSON.stringify(c.screenshot(shotOut)));
    c.close();
  } else if (cmd === "key") {
    const named = { return: 0xff0d, tab: 0xff09, esc: 0xff1b, ctrl: 0xffe3, alt: 0xffe9, shift: 0xffe1, space: 0x20 };
    const c = await RfbClient.connect({ port });
    const keys = arg.split("+").map((k) => (k.length === 1 ? k.toUpperCase().codePointAt(0) : named[k.toLowerCase()]));
    for (const k of keys) c.key(k, true);
    await new Promise((r) => setTimeout(r, 60));
    for (const k of [...keys].reverse()) c.key(k, false);
    await new Promise((r) => setTimeout(r, 150));
    await c.update(false);
    console.log(JSON.stringify(c.screenshot(shotOut)));
    c.close();
  } else if (cmd === "watch") {
    const c = await RfbClient.connect({ port });
    const r = await c.waitForDesktop({
      onSample: (st, ms) => console.log(`[${ms}ms] lit=${(st.litRatio * 100).toFixed(1)}% colors=${st.colors}`),
    });
    console.log(JSON.stringify({ desktopVisibleMs: r.ms, size: `${c.width}x${c.height}` }));
    c.close();
  } else {
    console.log("用法: rfb.mjs shot|watch|click|type|key <port> [arg] [out.png]");
    process.exit(2);
  }
}
