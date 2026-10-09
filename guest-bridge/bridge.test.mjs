// bridge.test.mjs —— guest bridge 集成测试（在宿主机上直接跑，不需要沙箱）。
// 用法：node guest-bridge/bridge.test.mjs（或 bun guest-bridge/bridge.test.mjs）。
// 覆盖：build.mjs 编译出 exe；桥向 mock 宿主注册成功（含 404 后重试）；
//       /health 200；无 token / 错 token 401；未知路径 404；
//       /screenshot 返回 JPEG（魔数 FFD8）+ X-Native-* 响应头 + 长边 ≤ maxWidth。
// 截到的位图只在内存里校验，不写盘、不展示。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const buildScript = path.join(scriptDir, "build.mjs");
const exePath = path.join(scriptDir, "bin", "orbita-guest-bridge.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";
const AUTH = { authorization: "Bearer " };

// 从 JPEG 字节流里解析图像尺寸（扫 SOF0..SOF15 标记段，跳过 C4/C8/CC）
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen <= 0) return null;
    i += 2 + segLen;
  }
  return null;
}

test("build.mjs 编译出 exe", { skip: !isWindows && "仅在 Windows 上运行" }, async () => {
  const r = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
  assert.equal(r.status, 0, `build.mjs 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(fs.existsSync(exePath), "bin/orbita-guest-bridge.exe 应生成");
});

test(
  "桥注册成功 + health + 鉴权 + screenshot",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const token = crypto.randomBytes(16).toString("hex");

    // ---- mock 宿主 register 服务：第一次 404（验证重试），之后 200 ----
    const attempts = [];
    let bridgePort = 0;
    const mockHost = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        attempts.push({
          url: req.url,
          method: req.method,
          auth: req.headers.authorization,
          body,
        });
        if (attempts.length === 1) {
          res.writeHead(404);
          res.end("not yet");
          return;
        }
        const parsed = JSON.parse(body);
        bridgePort = parsed.port;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => mockHost.listen(0, "127.0.0.1", r));
    const hostPort = mockHost.address().port;

    // ---- 启动桥（--listen-port 0 让系统分配端口；--host-ip 127.0.0.1 跳过网关发现）----
    const bridge = spawn(
      exePath,
      [
        "--host-port",
        String(hostPort),
        "--listen-port",
        "0",
        "--token",
        token,
        "--host-ip",
        "127.0.0.1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    try {
      // 等注册成功（404 后 2 秒重试，留足余量）
      const deadline = Date.now() + 30_000;
      while (bridgePort === 0 && Date.now() < deadline) await sleep(100);
      assert.ok(bridgePort > 0, `桥应在超时前完成注册。桥日志：\n${bridgeLog}`);

      // 注册请求的协议校验
      assert.equal(attempts[0].url, "/register");
      assert.equal(attempts[0].method, "POST");
      assert.equal(attempts[0].auth, "Bearer " + token, "注册应带 Bearer token");
      assert.ok(attempts.length >= 2, "第一次被 404 拒绝后应重试");
      const ports = attempts.map((a) => JSON.parse(a.body).port);
      assert.ok(ports.every((p) => p === bridgePort && p > 0), "每次注册应上报同一个有效端口");
      console.log(`    桥监听端口（系统分配）：${bridgePort}，注册尝试 ${attempts.length} 次`);

      const base = `http://127.0.0.1:${bridgePort}`;

      // ---- 无 token → 401（鉴权优先于 404）----
      let r = await fetch(base + "/health");
      assert.equal(r.status, 401);
      r = await fetch(base + "/no-such-path");
      assert.equal(r.status, 401);

      // ---- 错 token → 401 ----
      r = await fetch(base + "/health", { headers: { authorization: "Bearer deadbeef" } });
      assert.equal(r.status, 401);

      // ---- /health 200 ----
      r = await fetch(base + "/health", { headers: { authorization: "Bearer " + token } });
      assert.equal(r.status, 200);
      const health = await r.json();
      assert.deepEqual(health, { ok: true, version: "0.1.0" });

      // ---- 未知路径（带 token）→ 404 ----
      r = await fetch(base + "/no-such-path", { headers: { authorization: "Bearer " + token } });
      assert.equal(r.status, 404);

      // ---- /screenshot?maxWidth=320：JPEG 魔数 + 响应头齐全 + 长边缩放 ----
      r = await fetch(base + "/screenshot?maxWidth=320", {
        headers: { authorization: "Bearer " + token },
      });
      assert.equal(r.status, 200, "截图应成功（宿主机有桌面会话）");
      assert.match(r.headers.get("content-type") || "", /^image\/jpeg/);
      const nativeW = Number(r.headers.get("x-native-width"));
      const nativeH = Number(r.headers.get("x-native-height"));
      assert.ok(Number.isInteger(nativeW) && nativeW > 0, "X-Native-Width 应为正整数");
      assert.ok(Number.isInteger(nativeH) && nativeH > 0, "X-Native-Height 应为正整数");
      const jpeg = Buffer.from(await r.arrayBuffer());
      assert.ok(jpeg.length > 4, "JPEG body 不应为空");
      assert.equal(jpeg[0], 0xff, "JPEG 魔数首字节 FFD8");
      assert.equal(jpeg[1], 0xd8, "JPEG 魔数次字节 FFD8");
      const size = jpegSize(jpeg);
      assert.ok(size, "应能从 JPEG 解析出尺寸");
      assert.ok(Math.max(size.width, size.height) <= 320, `长边应 ≤ 320，实际 ${size.width}x${size.height}`);
      console.log(`    截图：原始 ${nativeW}x${nativeH} → 输出 ${size.width}x${size.height}，${jpeg.length} 字节`);

      // ---- /screenshot 不带参数：缺省 maxWidth=1280 ----
      r = await fetch(base + "/screenshot", { headers: { authorization: "Bearer " + token } });
      assert.equal(r.status, 200);
      const jpeg2 = Buffer.from(await r.arrayBuffer());
      const size2 = jpegSize(jpeg2);
      assert.ok(size2, "应能解析缺省档截图尺寸");
      assert.ok(Math.max(size2.width, size2.height) <= 1280, `缺省长边应 ≤ 1280，实际 ${size2.width}x${size2.height}`);
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      await new Promise((r) => mockHost.close(r));
    }
  },
);
