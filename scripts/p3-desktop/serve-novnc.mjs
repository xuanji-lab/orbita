/**
 * 浏览器里看桌面：noVNC 静态页 + websockify（WebSocket → 原生 RFB TCP）桥。
 *
 *   node scripts/p3-desktop/serve-novnc.mjs [--port 6080]
 *
 * 前端文件取自 npm 包装的 novnc（不装全局、不动系统）：
 *   <ORBITA_NOVNC_DIR>/node_modules/novnc    默认 <IMAGE_DIR>/novnc/node_modules/novnc
 * 没装的话先：
 *   cd <IMAGE_DIR>/novnc && npm init -y && npm install novnc ws
 *
 * 只绑 127.0.0.1：桌面画面里可能有关键信息，不往局域网暴露。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { IMAGE_DIR, DESKTOP_RFB_PORT, NOVNC_PORT } from "./config.mjs";
import { WebSocketServer } from "ws";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1] || NOVNC_PORT) || NOVNC_PORT;
/**
 * noVNC 根目录。**优先完整发行版**（`novnc-dist/noVNC-*`），因为：
 * - npm 上的 `novnc` 包只有库（core/vendor/lib），**没有 `vnc.html`/`vnc_lite.html`**；
 * - 完整版才带 app 层和入口页。
 * 2026-11-16 真机踩到的坑：用 `vnc.html`（完整 UI）时 `autoconnect=1` 不生效，页面停在
 * 欢迎界面（canvas 都没建，表现为「深色背景 + 两个小方块」）；同一个 URL 换成
 * `vnc_lite.html` 立刻连上并渲染出桌面。所以入口固定用 lite。
 */
function resolveNovncDir() {
  if (process.env.ORBITA_NOVNC_DIR) return process.env.ORBITA_NOVNC_DIR;
  const distRoot = path.join(IMAGE_DIR, "novnc-dist");
  if (fs.existsSync(distRoot)) {
    for (const name of fs.readdirSync(distRoot)) {
      const candidate = path.join(distRoot, name);
      if (fs.existsSync(path.join(candidate, "vnc_lite.html"))) return candidate;
    }
  }
  return path.join(IMAGE_DIR, "novnc", "node_modules", "novnc");
}
const NOVNC_DIR = resolveNovncDir();
const RFB_PORT = Number(process.env.ORBITA_P3_RFB_PORT ?? DESKTOP_RFB_PORT);

if (!fs.existsSync(path.join(NOVNC_DIR, "core", "rfb.js"))) {
  console.error(`找不到 noVNC：${NOVNC_DIR}\n先在 ${path.dirname(path.dirname(NOVNC_DIR))} 跑 npm init -y && npm install novnc ws，或用 ORBITA_NOVNC_DIR 指定。`);
  process.exit(2);
}

/** 最小前端页：npm 包的 novnc 只带库（core/ vendor/ lib/），不带 vnc.html */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbita 桌面</title>
<style>
  html,body{margin:0;height:100%;background:#0f1416;color:#9fb0b8;font:13px/1.4 system-ui,sans-serif}
  #screen{width:100vw;height:100vh}
  #hud{position:fixed;left:8px;bottom:6px;opacity:.55;pointer-events:none}
</style>
</head>
<body>
<div id="screen"></div>
<div id="hud">connecting…</div>
<script>
// 隐藏/后台标签页里 requestAnimationFrame 会被节流甚至完全不触发，noVNC 的绘制队列
// 因此永远不刷 —— 画布停在初始化时的白底（实测：connected、帧也收到了，就是没有像素）。
// 用定时器兜底，让不可见的标签页也能把画面画出来。
(function () {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
})();
</script>
<script type="module">
import RFB from "./core/rfb.js";
const hud = document.getElementById("hud");
const proto = location.protocol === "https:" ? "wss" : "ws";
// noVNC 1.2.0 的构造签名是 (target, touchInput, urlOrChannel, options)：
// 少传 touchInput 会把 URL 当成触摸/键盘层吃掉（报 "Must specify URL"）；
// 传 null 又会在 Keyboard 构造里崩（它要把一个隐藏 input 挂到该元素上）。
// 完整发行版的 vnc.html 是 (screen, screen, url)：第二参必须是元素。
const screen = document.getElementById("screen");
const url = proto + "://" + location.host + "/websockify";
const rfb = new RFB(screen, screen, url);
rfb.scaleViewport = true;
rfb.addEventListener("connect", () => { hud.textContent = url; });
rfb.addEventListener("disconnect", (e) => {
  console.log("RFB disconnect", JSON.stringify(e.detail));
  hud.textContent = "disconnected: " + JSON.stringify(e.detail);
});
rfb.addEventListener("connect", () => console.log("RFB connected"));
window.__rfb = rfb;
</script>
</body>
</html>`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // **入口用 vnc_lite 而不是 vnc**：完整 UI（vnc.html）在本机实测 autoconnect 不生效，
  // 停在欢迎页且不建 canvas；lite 版同样的参数一次就通（2026-11-16 真机验证）。
  const distVnc = path.join(NOVNC_DIR, "vnc_lite.html");
  if ((url.pathname === "/" || url.pathname === "/index.html") && fs.existsSync(distVnc)) {
    res.writeHead(302, { location: "/vnc_lite.html?autoconnect=1&resize=scale&path=websockify" }).end();
    return;
  }
  if (!fs.existsSync(distVnc) && (url.pathname === "/" || url.pathname === "/vnc.html" || url.pathname === "/vnc_lite.html" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
    return;
  }
  // npm 包的 novnc 只发布 core/ vendor/ lib/，但 core/input/keyboard.js 里 import 了
  // "../../app/ui.js"（完整发行版才有）。它只用到 UI.rfb.translateShortcuts，给个最小
  // stub 就能让模块图连上；不补这个，页永远停在 "connecting…"。
  if (url.pathname === "/app/ui.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end("export default { rfb: null };\n");
    return;
  }
  const file = path.join(NOVNC_DIR, path.normalize(url.pathname).replace(/^([/\\])+/, ""));
  if (!file.startsWith(NOVNC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });

/**
 * 只放行 TigerVNC 的 Xvnc 认的客户端消息类型：
 * 0 SetPixelFormat / 2 SetEncodings / 3 FBUR / 4 Key / 5 Pointer / 6 CutText / 251 SetDesktopSize。
 * noVNC 1.2 会无条件声明并发送 Fence(248) / EnableContinuousUpdates(150)；Xvnc 收到 150 就
 * "Closing: Unknown message type" 断连（实测）。做法是在 SetEncodings 里就把 -312/-313
 * 剔掉（见下），服务器便不会发 Fence，这些消息也就不会再出现。
 *
 * **必须先分帧**：浏览器把多条 RFB 消息塞进一个 WS 帧（实测一次 461 字节里含 3 条），
 * 只看首字节会把 SetEncodings 之类整条丢错，客户端停在 "connecting…"。
 */
const ALLOWED_TYPES = new Set([0, 2, 3, 4, 5, 6, 251]);

/** 返回 offset 处一条完整客户端消息的字节数；0 = 数据还不够，-1 = 认不出来 */
function clientMessageLength(b, off) {
  const avail = b.length - off;
  const need = (n) => (avail >= n ? n : 0);
  switch (b[off]) {
    case 0: return need(20); // SetPixelFormat
    case 2: { if (avail < 4) return 0; const len = 4 + b.readUInt16BE(off + 2) * 4; return avail >= len ? len : 0; } // SetEncodings
    case 3: return need(10); // FramebufferUpdateRequest
    case 4: return need(8); // KeyEvent
    case 5: return need(6); // PointerEvent
    case 6: { if (avail < 8) return 0; const len = 8 + b.readUInt32BE(off + 4); return avail >= len ? len : 0; } // ClientCutText
    case 150: return need(10); // EnableContinuousUpdates
    case 248: { if (avail < 9) return 0; const len = 9 + b[off + 8]; return avail >= len ? len : 0; } // Fence
    case 251: { if (avail < 8) return 0; const len = 8 + b[off + 6] * 16; return avail >= len ? len : 0; } // SetDesktopSize
    case 252: return need(5); // 实测 noVNC 发的 5 字节扩展
    case 181: {
      // noVNC 1.2 的 WebRTC/UDP 升级请求：type + u16 长度 + SDP 文本。
      // Xvnc 不认它（"Unknown message type" 直接断连），必须整条吃掉。
      if (avail < 3) return 0;
      const len = 3 + ((b[off + 1] << 8) | b[off + 2]);
      return avail >= len ? len : 0;
    }
    default: return -1;
  }
}

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/websockify")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const tcp = net.connect({ host: "127.0.0.1", port: RFB_PORT });
    tcp.on("data", (buf) => {
      if (process.env.ORBITA_NOVNC_DEBUG) console.error(`[tcp→ws] ${buf.length}B type=${buf[0]}${buf[0] === 0 && buf.length < 120 ? " hex=" + buf.toString("hex").slice(0, 80) : ""}`);
      if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    });

    // 前 12 字节是 RFB 版本串（RFB 003.008 + 换行），不是消息，原样放行
    let preamble = 0;
    let pending = Buffer.alloc(0);
    ws.on("message", (raw) => {
      let data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (preamble < 12) {
        const take = Math.min(12 - preamble, data.length);
        tcp.write(data.subarray(0, take));
        preamble += take;
        data = data.subarray(take);
      }
      if (process.env.ORBITA_NOVNC_DEBUG) console.error(`[ws→tcp raw] ${data.length}B type=${data[0]}`);
      pending = Buffer.concat([pending, data]);
      for (;;) {
        if (!pending.length) return;
        const len = clientMessageLength(pending, 0);
        if (len === 0) return;
        if (len < 0) {
          // 认不出的类型：整块原样转发，交给服务器自己判（别自己造协议）
          tcp.write(pending);
          pending = Buffer.alloc(0);
          return;
        }
        const msg = pending.subarray(0, len);
        pending = pending.subarray(len);
        const type = msg[0];

        // SetEncodings 一律收敛成 raw(0) + DesktopSize(-223)——和本仓 rfb.mjs 用的同一组，
        // 已验证能稳定拿到整帧。原因有两条实测：
        //   1) noVNC 声明的 Fence(-312)/ContinuousUpdates(-313) 让 Xvnc 发 ServerFence 等回执，
        //      并对 EnableContinuousUpdates 报 "Unknown message type" 直接断连；
        //   2) 声明 Tight(7) 等编码后，Xvnc 回的更新里只有 VMware LED(-258) 之类伪编码矩形，
        //      一个像素都不带（62B 的「更新」），noVNC 画布因此永远是空的。
        // 环回上 raw 的带宽完全够用（1280x800 一帧 4MB，后面都是增量脏区）。
        if (type === 2) {
          const rewritten = Buffer.alloc(12);
          rewritten[0] = 2;
          rewritten.writeUInt16BE(2, 2);
          rewritten.writeInt32BE(0, 4);
          rewritten.writeInt32BE(-223, 8);
          tcp.write(rewritten);
          if (process.env.ORBITA_NOVNC_DEBUG) console.error("[ws→tcp] SetEncodings → raw+DesktopSize");
          continue;
        }
        if (ALLOWED_TYPES.has(type)) {
          if (process.env.ORBITA_NOVNC_DEBUG) {
            const extra = type === 2 ? " encs=" + Array.from({ length: msg.readUInt16BE(2) }, (_, i) => msg.readInt32BE(4 + i * 4)).join(",") : type === 3 ? ` inc=${msg[1]} ${msg.readUInt16BE(6)}x${msg.readUInt16BE(8)}` : type === 0 ? " pf=" + msg.toString("hex") : type === 2 ? ` encs=${msg.readUInt16BE(2)}` : "";
            console.error(`[ws→tcp] 转发 type=${type} len=${len}${extra}`);
          }
          tcp.write(msg);
        } else if (process.env.ORBITA_NOVNC_DEBUG) {
          console.error(`[ws→tcp] 丢弃 type=${type} len=${len}`);
        }
      }
    });

    ws.on("close", () => { if (process.env.ORBITA_NOVNC_DEBUG) console.error("[ws] closed by browser"); tcp.destroy(); });
    tcp.on("close", () => { if (process.env.ORBITA_NOVNC_DEBUG) console.error("[tcp] closed by server");
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
    });
    tcp.on("error", (e) => {
      console.error(`[novnc] RFB 桥接失败：${e.message}`);
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify(
      {
        url: `http://127.0.0.1:${port}/`,
        rfbTarget: `127.0.0.1:${RFB_PORT}`,
        novnc: NOVNC_DIR,
        pid: process.pid,
      },
      null,
      2,
    ),
  );
});
