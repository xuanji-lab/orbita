/**
 * 宿主侧 Alpine 包镜像代理。
 *
 * 为什么需要：guest 出不去外网（这台机器的网络策略挡 DNS 与外部 TCP），但宿主能访问
 * dl-cdn.alpinelinux.org。把仓库地址指到 http://10.0.2.2:<port>/alpine/...，guest 里的
 * apk 就是原生行为（依赖求解、签名校验、post-install 脚本全在 guest 里跑），宿主只负责
 * 转发 + 落盘缓存（同一批包只下一次）。
 *
 *   node scripts/p3-desktop/apk-mirror.mjs            # 前台跑，Ctrl+C 停
 *   node scripts/p3-desktop/apk-mirror.mjs --detach   # 后台跑，打印 PID
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, MIRROR_PORT } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 跟随重定向的 GET（CDN 会跳镜像） */
function fetchFollow(url, depth = 0) {
  if (depth > 4) return Promise.reject(new Error("too many redirects"));
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchFollow(new URL(res.headers.location, url).toString(), depth + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * 起代理。除 /alpine/* 反向代理外还提供 /build/*，把本目录的脚本下发给 guest ——
 * 改脚本再跑不需要重启 VM，也不用把长脚本灌进 8250 串口（会丢字符）。
 */
export function startMirror({ port = MIRROR_PORT } = {}) {
  const stats = { hit: 0, miss: 0, failed: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/build/")) {
      const file = path.join(HERE, path.basename(url.pathname));
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("no such build file");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(file));
      return;
    }
    if (!url.pathname.startsWith("/alpine/")) {
      res.writeHead(404).end();
      return;
    }
    const cacheFile = path.join(CACHE_DIR, "mirror", url.pathname.replace(/^\/alpine\//, ""));
    if (fs.existsSync(cacheFile)) {
      stats.hit++;
      const body = fs.readFileSync(cacheFile);
      res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }
    try {
      const body = await fetchFollow(`https://dl-cdn.alpinelinux.org${url.pathname}`);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, cacheFile);
      stats.miss++;
      res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" });
      res.end(body);
    } catch (cause) {
      stats.failed++;
      console.error(`[mirror] ${url.pathname} → ${cause.message}`);
      res.writeHead(502).end("upstream failed");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, stats, close: () => new Promise((r) => server.close(r)) }));
  });
}

if (process.argv[1] && process.argv[1].replaceAll("\\", "/").endsWith("/apk-mirror.mjs")) {
  const { close } = await startMirror();
  console.log(`[mirror] 127.0.0.1:${MIRROR_PORT}（guest 侧 http://10.0.2.2:${MIRROR_PORT}），缓存 ${CACHE_DIR}/mirror`);
  if (!process.argv.includes("--detach")) {
    process.on("SIGINT", async () => {
      await close();
      process.exit(0);
    });
  }
}
