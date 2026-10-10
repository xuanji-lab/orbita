// bridge.test.mjs —— guest bridge 集成测试（在宿主机上直接跑，不需要沙箱）。
// 用法：node guest-bridge/bridge.test.mjs（或 bun guest-bridge/bridge.test.mjs）。
// 文件协议：宿主写 out/cmd/<名字>.req.json（tmp+rename）→ 桥执行 →
// 写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件）→ 删 req。
// 覆盖：build.mjs 编译出 exe；bridge.json 就绪通告；screenshot 命令全链
// （req 消失、resp 字段、JPEG 魔数与尺寸、长边 ≤ maxWidth）；未知命令 / 坏请求的 error 响应。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const buildScript = path.join(scriptDir, "build.mjs");
const exePath = path.join(scriptDir, "bin", "orbita-guest-bridge.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";

// 从 JPEG 字节流里解析图像尺寸（扫 SOF0..SOF15 标记段，跳过 C4/C8/CC）
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen <= 0) return null;
    i += 2 + segLen;
  }
  return null;
}

/** 宿主侧写命令：tmp + rename（协议的原子写纪律，与主进程实现同款） */
function writeRequest(cmdDir, name, body) {
  const tmp = path.join(cmdDir, name + ".tmp");
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, path.join(cmdDir, name + ".req.json"));
}

/** 轮询等响应文件出现 */
async function waitForFile(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

test("build.mjs 编译出 exe", { skip: !isWindows && "仅在 Windows 上运行" }, async () => {
  const r = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
  assert.equal(r.status, 0, `build.mjs 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(fs.existsSync(exePath), "bin/orbita-guest-bridge.exe 应生成");
});

test(
  "桥就绪通告 + screenshot 命令全链 + 错误命令",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-test-"));
    const cmdDir = path.join(outDir, "cmd");

    const bridge = spawn(exePath, ["--out-dir", outDir], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    try {
      // ---- 就绪通告 ----
      const infoPath = path.join(outDir, "bridge.json");
      assert.ok(await waitForFile(infoPath), `桥应在超时前写出 bridge.json。桥日志：\n${bridgeLog}`);
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      assert.equal(info.version, "0.1.0");
      assert.ok(Number.isInteger(info.pid) && info.pid > 0, "bridge.json 应带 pid");
      assert.ok(fs.existsSync(cmdDir), "cmd 目录应由桥创建");

      // ---- ping 命令（宿主就绪探针）----
      writeRequest(cmdDir, "cmd-000000", JSON.stringify({ seq: 0, command: "ping" }));
      const resp0Path = path.join(cmdDir, "cmd-000000.resp.json");
      assert.ok(await waitForFile(resp0Path), "ping 应有响应");
      assert.deepEqual(JSON.parse(fs.readFileSync(resp0Path, "utf8")), { ok: true });

      // ---- screenshot 命令全链 ----
      writeRequest(cmdDir, "cmd-000001", JSON.stringify({ seq: 1, command: "screenshot", maxWidth: 320 }));
      const respPath = path.join(cmdDir, "cmd-000001.resp.json");
      assert.ok(await waitForFile(respPath), `应收到响应。桥日志：\n${bridgeLog}`);
      const resp = JSON.parse(fs.readFileSync(respPath, "utf8"));
      assert.equal(resp.ok, true, "截图应成功（宿主机有桌面会话）");
      assert.ok(Number.isInteger(resp.nativeWidth) && resp.nativeWidth > 0);
      assert.ok(Number.isInteger(resp.nativeHeight) && resp.nativeHeight > 0);
      assert.ok(Math.max(resp.width, resp.height) <= 320, `长边应 ≤ 320，实际 ${resp.width}x${resp.height}`);
      assert.ok(!fs.existsSync(path.join(cmdDir, "cmd-000001.req.json")), "req 应由桥删掉");

      const jpg = fs.readFileSync(path.join(cmdDir, resp.jpeg));
      assert.equal(jpg[0], 0xff, "JPEG 魔数首字节 FFD8");
      assert.equal(jpg[1], 0xd8, "JPEG 魔数次字节 FFD8");
      const size = jpegSize(jpg);
      assert.deepEqual(size, { width: resp.width, height: resp.height }, "resp 尺寸应与 JPEG 实际一致");
      console.log(`    截图：原始 ${resp.nativeWidth}x${resp.nativeHeight} → ${resp.width}x${resp.height}，${jpg.length} 字节`);

      // ---- 缺省 maxWidth=1280 ----
      writeRequest(cmdDir, "cmd-000002", JSON.stringify({ seq: 2, command: "screenshot" }));
      const resp2Path = path.join(cmdDir, "cmd-000002.resp.json");
      assert.ok(await waitForFile(resp2Path));
      const resp2 = JSON.parse(fs.readFileSync(resp2Path, "utf8"));
      assert.equal(resp2.ok, true);
      assert.ok(Math.max(resp2.width, resp2.height) <= 1280, `缺省长边应 ≤ 1280，实际 ${resp2.width}x${resp2.height}`);

      // ---- 未知命令 → 人话 error ----
      writeRequest(cmdDir, "cmd-000003", JSON.stringify({ seq: 3, command: "rm-rf" }));
      const resp3Path = path.join(cmdDir, "cmd-000003.resp.json");
      assert.ok(await waitForFile(resp3Path));
      const resp3 = JSON.parse(fs.readFileSync(resp3Path, "utf8"));
      assert.equal(resp3.ok, false);
      assert.match(resp3.error, /未知命令/);

      // ---- 坏请求（缺 command）→ error，不弄死命令循环 ----
      writeRequest(cmdDir, "cmd-000004", JSON.stringify({ seq: 4 }));
      const resp4Path = path.join(cmdDir, "cmd-000004.resp.json");
      assert.ok(await waitForFile(resp4Path));
      const resp4 = JSON.parse(fs.readFileSync(resp4Path, "utf8"));
      assert.equal(resp4.ok, false);

      // 循环还活着：再发一个正常命令验证
      writeRequest(cmdDir, "cmd-000005", JSON.stringify({ seq: 5, command: "screenshot", maxWidth: 640 }));
      assert.ok(await waitForFile(path.join(cmdDir, "cmd-000005.resp.json")), "坏命令之后循环应继续工作");
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);
