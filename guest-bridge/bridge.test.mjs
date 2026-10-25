// bridge.test.mjs —— guest bridge 集成测试（在宿主机上直接跑，不需要沙箱）。
// 用法：node guest-bridge/bridge.test.mjs（或 bun guest-bridge/bridge.test.mjs）。
// 文件协议：宿主写 out/cmd/<名字>.req.json（tmp+rename）→ 桥执行 →
// 写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件）→ 删 req。
// 覆盖：build.mjs 编译出 exe；bridge.json 就绪通告；screenshot 命令全链
// （req 消失、resp 字段、JPEG 魔数与尺寸、长边 ≤ maxWidth）；未知命令 / 坏请求的 error 响应；
// 输入命令（click / type / key / scroll）的参数校验与键名→VK 映射；
// 轮询的序号直探与全量对齐（跳号 / 迟到 / 半截）。
//
// ⚠ **红线**：输入命令在宿主上跑就是劫持用户真实的鼠标键盘。所以这个文件里所有
// click / type / key / scroll 请求一律带 `dryRun: true`（桥只解析不注入），并且
// 第一个探针用的是「就算 dryRun 被忽略也没有任何副作用」的空文本 type——
// 探针回执不带 dryRun 就当场失败，后面一条都不发。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

/**
 * 收尾：按 `<out>/worker/<会话>/worker.json` 里记下的 pid 逐个清掉 worker。
 *
 * 为什么测试也要做：桥被 kill 之后，worker 是它的子进程——正常情况下 worker 会在 ~2s 内
 * 发现父进程没了就自己退（WorkerHost.cs 的 ParentGone），但测试进程不该赌那 2 秒，
 * 而且残留的 worker 会去轮询一个已被删掉的临时目录。**只杀 worker.json 里的 pid**（仓规）。
 */
function killLeftoverWorkers(outDir) {
  let names;
  try {
    names = fs.readdirSync(path.join(outDir, "worker"));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(outDir, "worker", name, "worker.json"), "utf8"));
      if (Number.isInteger(info.pid) && info.pid > 0) {
        spawnSync("taskkill", ["/PID", String(info.pid), "/T", "/F"], { windowsHide: true });
      }
    } catch {
      // 桥已经把它撤掉了（worker.json 不在了）：没有可杀的
    }
  }
}

test("build.mjs 编译出 exe", { skip: !isWindows && "仅在 Windows 上运行" }, async () => {
  const r = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
  assert.equal(r.status, 0, `build.mjs 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(fs.existsSync(exePath), "bin/orbita-guest-bridge.exe 应生成");
});

test(
  "JSON 取值器 selftest：Chromium 的 /json/version spaced 写法与转义都要吃",
  { skip: !isWindows && "仅在 Windows 上运行" },
  () => {
    // 这段测的是真机验收抓到的第一个 bug：/json/version 是 `"key": "value"`（冒号后有空格），
    // 旧取值器只认紧凑写法，cdp-start 拿不到 webSocketDebuggerUrl。selftest 还覆盖
    // 转义序列（引号 / 反斜杠 / 换行 / \uXXXX）——cdp-observe / cdp-extract 的正文缺尾巴就是它。
    // 纯函数用例，不需要沙箱、不碰桌面。
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-json"], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 20, `用例数应 >= 20，实际 ${parsed.cases}`);
    assert.equal(parsed.failures, undefined, "ok 时不该有 failures");
  },
);

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
      assert.equal(info.version, "0.8.0");
      assert.ok(Number.isInteger(info.pid) && info.pid > 0, "bridge.json 应带 pid");
      // 0.8.0 起通告 TCP 通道（宿主优先走它）：端口由系统分配、令牌 32 位十六进制
      assert.ok(Number.isInteger(info.port) && info.port > 0, "bridge.json 应带 TCP 端口");
      assert.match(info.token, /^[0-9a-f]{32}$/, "令牌应是 32 位十六进制");
      assert.ok(Array.isArray(info.ipv4), "bridge.json 应带 ipv4 数组");
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

      // 启动行必须报出枚举周期与计量阈值：父会话读实验日志时，靠这一行确认跑的是哪一档
      assert.match(bridgeLog, /对齐枚举周期：每 16 轮/, `启动行应报出枚举周期。桥日志：\n${bridgeLog}`);
      assert.match(bridgeLog, /耗时日志阈值 500ms/, "启动行应报出计量阈值");
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);

// ── TCP 命令通道（0.8.0）：宿主主动连进 guest，一条连接复用到底 ──────────────
//
// 真机的理由：文件协议每一跳 2.9–7.5 秒，TCP 只有毫秒级。这里在宿主机上起真桥、
// 用 127.0.0.1 走真行协议，验「握手 → 命令 → 截图内联 → 断线重连」，同时确认文件协议
// （回退通道）与 TCP 并存、一条行为都没退化。

/** 极小的行协议客户端（与宿主 bridge-client.ts 的 TCP 侧同一套语义） */
function openTcpClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    const waiters = [];
    const inbox = [];
    const deliver = (line) => {
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line !== "") deliver(line);
      }
    });
    socket.on("error", reject);
    socket.once("connect", () => {
      resolve({
        socket,
        send: (line) => socket.write(line + "\n"),
        next: (timeoutMs = 5000) =>
          new Promise((res, rej) => {
            if (inbox.length > 0) {
              res(inbox.shift());
              return;
            }
            const timer = setTimeout(() => rej(new Error("等回执超时")), timeoutMs);
            waiters.push((message) => {
              clearTimeout(timer);
              res(message);
            });
          }),
        close: () => socket.destroy(),
      });
    });
  });
}

test(
  "TCP 通道：握手 / 命令 / 截图内联 / 断线重连，且与文件协议并存",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-tcp-test-"));
    const cmdDir = path.join(outDir, "cmd");
    const bridge = spawn(exePath, ["--out-dir", outDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    try {
      const infoPath = path.join(outDir, "bridge.json");
      assert.ok(await waitForFile(infoPath), `桥应写出 bridge.json。桥日志：
${bridgeLog}`);
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));

      // ---- 错误令牌：被拒，且收不到任何命令回执 ----
      const wrong = await openTcpClient(info.port);
      wrong.send(JSON.stringify({ t: "hello", token: "0".repeat(32) }));
      const rejected = await wrong.next();
      assert.equal(rejected.t, "hello-fail", "错令牌应回 hello-fail");
      wrong.close();

      // ---- 正确令牌：握手 + ping ----
      const client = await openTcpClient(info.port);
      client.send(JSON.stringify({ t: "hello", token: info.token }));
      assert.deepEqual(await client.next(), { t: "hello-ok" }, "正确令牌应握手成功");
      client.send(JSON.stringify({ id: 1, command: "ping", fields: {} }));
      const pong = await client.next();
      assert.equal(pong.id, 1);
      assert.deepEqual(pong.resp, { ok: true });

      // ---- 截图：JPEG 内联在回执里，映射目录里不留产物 ----
      client.send(JSON.stringify({ id: 2, command: "screenshot", fields: { maxWidth: 320 } }));
      const shot = await client.next();
      assert.equal(shot.resp.ok, true, "TCP 截图应成功（宿主机有桌面会话）");
      assert.ok(typeof shot.jpegBase64 === "string" && shot.jpegBase64.length > 100, "回执应内联 jpegBase64");
      const jpeg = Buffer.from(shot.jpegBase64, "base64");
      assert.equal(jpeg[0], 0xff, "内联 JPEG 魔数首字节");
      assert.equal(jpeg[1], 0xd8, "内联 JPEG 魔数次字节");
      const size = jpegSize(jpeg);
      assert.deepEqual(size, { width: shot.resp.width, height: shot.resp.height }, "内联 JPEG 尺寸应与 resp 一致");
      assert.ok(!fs.existsSync(path.join(cmdDir, shot.resp.jpeg)), "TCP 路径读完应删掉那张 jpg");

      // ---- 两条命令不读回执就连发：按 id 对号、都成功 ----
      client.send(JSON.stringify({ id: 3, command: "ping", fields: {} }));
      client.send(JSON.stringify({ id: 4, command: "ping", fields: {} }));
      assert.equal((await client.next()).id, 3);
      assert.equal((await client.next()).id, 4);

      // ---- 文件协议（回退通道）在同一进程里照旧工作 ----
      writeRequest(cmdDir, "cmd-000001", JSON.stringify({ seq: 1, command: "ping" }));
      const fileResp = path.join(cmdDir, "cmd-000001.resp.json");
      assert.ok(await waitForFile(fileResp), `文件协议应与 TCP 并存。桥日志：
${bridgeLog}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(fileResp, "utf8")), { ok: true });

      // ---- 断开之后监听仍在：重连 + 握手 + 命令 ----
      client.close();
      const again = await openTcpClient(info.port);
      again.send(JSON.stringify({ t: "hello", token: info.token }));
      assert.deepEqual(await again.next(), { t: "hello-ok" }, "断开重连应握手成功");
      again.send(JSON.stringify({ id: 1, command: "ping", fields: {} }));
      assert.deepEqual((await again.next()).resp, { ok: true });
      again.close();

      // 日志里不许出现令牌真值（它会被贴进 PR / 截图）
      assert.ok(!bridgeLog.includes(info.token), "bridge.log 里不许出现令牌真值");
      assert.match(bridgeLog, /TCP 通道已监听：0\.0\.0\.0:\d+/, "启动时应报出监听端口");
      assert.match(bridgeLog, /TCP 握手成功/, "握手结果应有一行日志");
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      killLeftoverWorkers(outDir);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);

// ── 输入命令（全部 dryRun：只验解析与校验，绝不注入）───────────────────────

test(
  "输入命令 dryRun：键名→VK、坐标/文本解析与参数校验；不注入任何事件",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-input-test-"));
    const cmdDir = path.join(outDir, "cmd");

    const bridge = spawn(exePath, ["--out-dir", outDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    let seq = 0;
    /** 发一个请求并等回执（req 名字带序号，桥按名字排序处理） */
    const ask = async (body) => {
      seq += 1;
      const name = "cmd-" + String(seq).padStart(6, "0");
      writeRequest(cmdDir, name, JSON.stringify({ seq, ...body }));
      const respPath = path.join(cmdDir, name + ".resp.json");
      assert.ok(await waitForFile(respPath), `应收到响应。桥日志：\n${bridgeLog}`);
      return JSON.parse(fs.readFileSync(respPath, "utf8"));
    };

    try {
      assert.ok(await waitForFile(path.join(outDir, "bridge.json")), "桥应就绪");

      // ---- 探针：dryRun 缝真的生效（空文本 type，就算被忽略也是零事件）----
      const probe = await ask({ command: "type", text: "", dryRun: true });
      assert.equal(probe.ok, true);
      assert.equal(probe.dryRun, true, "dryRun 没被桥认——后面的注入类请求一律不发（宿主上注入是红线）");

      // ---- click ----
      assert.deepEqual(await ask({ command: "click", x: 120, y: 340, dryRun: true }), {
        ok: true,
        dryRun: true,
        x: 120,
        y: 340,
        button: "left",
        double: false,
      });
      const right = await ask({ command: "click", x: 5, y: 6, button: "right", double: true, dryRun: true });
      assert.deepEqual(right, { ok: true, dryRun: true, x: 5, y: 6, button: "right", double: true });
      const noX = await ask({ command: "click", y: 6, dryRun: true });
      assert.equal(noX.ok, false);
      assert.match(noX.error, /整数 x 与 y/);
      const badButton = await ask({ command: "click", x: 1, y: 2, button: "wheel", dryRun: true });
      assert.equal(badButton.ok, false);
      assert.match(badButton.error, /button 只能是/);

      // ---- key：键名 → VK（宿主侧只看解析结果，不关心 VK 具体值是否“对”到某个物理键）----
      const vks = async (key) => (await ask({ command: "key", key, dryRun: true })).vks;
      assert.deepEqual(await vks("enter"), [0x0d]);
      assert.deepEqual(await vks("Escape"), [0x1b]);
      assert.deepEqual(await vks("f12"), [0x7b]);
      assert.deepEqual(await vks("ctrl+a"), [0x11, 0x41]);
      assert.deepEqual(await vks("alt+f4"), [0x12, 0x73]);
      assert.deepEqual(await vks("win+r"), [0x5b, 0x52]);
      assert.deepEqual(await vks("Ctrl + Shift + S"), [0x11, 0x10, 0x53]);
      assert.deepEqual(await vks("numpad7"), [0x67]);
      const unknown = await ask({ command: "key", key: "hyper+x", dryRun: true });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /不认识的按键名：hyper/);
      const emptyKey = await ask({ command: "key", dryRun: true });
      assert.equal(emptyKey.ok, false);

      // ---- type：转义与中文原样回显（引号/反斜杠/换行/中文都不能被切坏）----
      const text = '他说"你好" \\ 换行\n制表\t结束';
      const typed = await ask({ command: "type", text, dryRun: true });
      assert.equal(typed.ok, true);
      assert.equal(typed.text, text);
      assert.equal(typed.length, text.length);
      const noText = await ask({ command: "type", dryRun: true });
      assert.equal(noText.ok, false);
      assert.match(noText.error, /text 字段/);

      // ---- scroll ----
      assert.deepEqual(await ask({ command: "scroll", x: 10, y: 20, deltaY: -3, dryRun: true }), {
        ok: true,
        dryRun: true,
        x: 10,
        y: 20,
        deltaY: -3,
      });
      const zeroDelta = await ask({ command: "scroll", x: 1, y: 2, deltaY: 0, dryRun: true });
      assert.equal(zeroDelta.ok, false);
      assert.match(zeroDelta.error, /deltaY 不能是 0/);
      const noDelta = await ask({ command: "scroll", x: 1, y: 2, dryRun: true });
      assert.equal(noDelta.ok, false);
      assert.match(noDelta.error, /整数 deltaY/);

      // 校验类请求也不许留下 req 文件（桥执行完就删）
      assert.deepEqual(
        fs.readdirSync(cmdDir).filter((f) => f.endsWith(".req.json")),
        [],
        "req 应全部由桥删掉",
      );
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);

// ── 轮询策略：序号直探（快路径）+ 全量枚举对齐（慢路径）────────────────────
//
// 为什么值得测：映射文件夹的目录枚举会被 RDP 驱动器重定向的缓存卡住——2026-10-14 真机
// 实测，win+r 弹出「运行」框之后宿主刚写进的 req 在 Directory.GetFiles 里 20 秒内看不见。
// 桥因此改成直探 `cmd-<序号>.req.json`（File.Exists），枚举退成每 ~4s 一次的兜底对齐。
// 这里在宿主机上测的是**策略本身**（快路径即时、跳号能被兜住、迟到的 req 不被误判），
// 不是那个只有沙箱里才复现得出来的黑窗。

test(
  "轮询：序号直探即时；跳号靠对齐兜住；迟到 / 半截的 req 不弄死循环",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-poll-test-"));
    const cmdDir = path.join(outDir, "cmd");
    const name = (seq) => "cmd-" + String(seq).padStart(6, "0");
    const respPath = (seq) => path.join(cmdDir, name(seq) + ".resp.json");
    const readResp = (seq) => JSON.parse(fs.readFileSync(respPath(seq), "utf8"));

    const bridge = spawn(exePath, ["--out-dir", outDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    try {
      assert.ok(await waitForFile(path.join(outDir, "bridge.json")), "桥应就绪");

      // ---- 快路径：序号从 1 起的连续三条命令应当「即时」回（不等 4s 的对齐周期）----
      const fastStart = Date.now();
      for (const seq of [1, 2, 3]) {
        writeRequest(cmdDir, name(seq), JSON.stringify({ seq, command: "ping" }));
        assert.ok(await waitForFile(respPath(seq), 5_000), `cmd-${seq} 应有响应。桥日志：\n${bridgeLog}`);
        assert.equal(readResp(seq).ok, true);
      }
      const fastMs = Date.now() - fastStart;
      assert.ok(fastMs < 3_000, `三条连续命令应走直探快路径（不等 4s 对齐），实际 ${fastMs}ms`);

      // ---- 跳号：下一个序号没来、更远的序号先到 → 最多一个对齐周期（~4s）被捡到 ----
      const jumpStart = Date.now();
      writeRequest(cmdDir, name(9), JSON.stringify({ seq: 9, command: "ping" }));
      assert.ok(await waitForFile(respPath(9), 8_000), `跳号应在一次对齐周期内被捡到。桥日志：\n${bridgeLog}`);
      const jumpMs = Date.now() - jumpStart;
      assert.ok(jumpMs < 8_000, `跳号对齐不该超过两个周期，实际 ${jumpMs}ms`);
      // 对齐之后 _nextSeq 跟上了：10 又走回快路径
      const afterStart = Date.now();
      writeRequest(cmdDir, name(10), JSON.stringify({ seq: 10, command: "ping" }));
      assert.ok(await waitForFile(respPath(10), 5_000));
      assert.ok(Date.now() - afterStart < 3_000, "对齐之后应回到快路径");

      // ---- 迟到：宿主只落了 .tmp、还没 rename → 桥看不到也不该误判 ----
      // （这正是黑窗的宿主机等价物：文件「还没出现」。同一个序号会被反复重探，落空不跳过）
      fs.writeFileSync(path.join(cmdDir, name(11) + ".tmp"), JSON.stringify({ seq: 11, command: "ping" }), "utf8");
      await sleep(1_200); // 桥至少转了两轮
      assert.ok(!fs.existsSync(respPath(11)), "req 还没出现，不该有任何响应");
      fs.renameSync(path.join(cmdDir, name(11) + ".tmp"), path.join(cmdDir, name(11) + ".req.json"));
      assert.ok(await waitForFile(respPath(11), 3_000), "rename 之后应立刻被直探捡到");
      assert.equal(readResp(11).ok, true);

      // ---- 半截内容：不当成功、不注入、循环继续 ----
      // （读失败那条路——rename 途中读不到——在桥里是静默下轮，Windows 上没法从测试进程
      //  确定性地制造「读不到」：node 打开文件默认带共享读写。这里测的是它的邻面。）
      fs.writeFileSync(path.join(cmdDir, name(12) + ".req.json"), '{"seq":12,"command":"type","text":"半截', "utf8");
      assert.ok(await waitForFile(respPath(12), 5_000));
      const broken = readResp(12);
      assert.equal(broken.ok, false, "半截请求不许当成成功");
      assert.match(broken.error, /text 字段/, "半截的 text 没有收尾引号，应当读不出来");
      assert.ok(!fs.existsSync(path.join(cmdDir, name(12) + ".req.json")), "坏请求也要删掉 req，不然会一直重跑");

      // 循环还活着
      writeRequest(cmdDir, name(13), JSON.stringify({ seq: 13, command: "ping" }));
      assert.ok(await waitForFile(respPath(13), 5_000), `坏请求之后循环应继续工作。桥日志：\n${bridgeLog}`);
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);


// ── CDP 命令：参数校验 / 错误文案 / 测试模式下不碰 Edge ─────────────────────
//
// ⚠ **红线**：快路径的 cdp-nav / cdp-observe 在真机上会 Process.Start msedge.exe——
// 在宿主上跑就是拉起用户真实的浏览器。所以这一组全部用桥的 `--no-browser` 测试缝
// （启动 Edge 那一步直接报错），验的是分派、参数校验与人话错误，不碰任何进程。
// 真机路径（起 Edge / WS / 截图 / 上传下载）只能由沙箱里的验收覆盖，这里如实不测。

test(
  "cdp-*：分派与参数校验；--no-browser 下绝不启动 Edge",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-cdp-test-"));
    const cmdDir = path.join(outDir, "cmd");

    const bridge = spawn(exePath, ["--out-dir", outDir, "--no-browser"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    let seq = 0;
    const ask = async (body) => {
      seq += 1;
      const name = "cmd-" + String(seq).padStart(6, "0");
      writeRequest(cmdDir, name, JSON.stringify({ seq, ...body }));
      const respPath = path.join(cmdDir, name + ".resp.json");
      assert.ok(await waitForFile(respPath), `应收到响应。桥日志：\n${bridgeLog}`);
      return JSON.parse(fs.readFileSync(respPath, "utf8"));
    };

    try {
      assert.ok(await waitForFile(path.join(outDir, "bridge.json")), "桥应就绪");

      // 没起过 Edge：status 报 running:false 并给出下一步（不启动任何进程）
      // 不带 session = **汇总**形态（宿主在缓存到上限时靠它拿真值）
      const status = await ask({ command: "cdp-status" });
      assert.equal(status.ok, true);
      assert.equal(status.running, false);
      assert.equal(status.count, 0, "还没有任何会话实例");
      assert.deepEqual(status.sessions, []);

      // 带 session = 那个会话自己：回执里回显**安全化之后**的键。
      // 没起过也是 ok:true + running:false（宿主靠 running 决定要不要 cdp-start；status 是查询不是命令）
      const one = await ask({ command: "cdp-status", session: "agent-1" });
      assert.equal(one.ok, true);
      assert.equal(one.running, false);
      assert.equal(one.session, "agent-1");
      assert.match(one.hint, /computer_screenshot/, "要告诉模型可以退回像素工具");
      const sanitized = await ask({ command: "cdp-status", session: "..\\..\\evil / x" });
      assert.equal(sanitized.session, "______evil___x", "会话键进 profile 目录前必须安全化");

      // stop 幂等：没起过也回 ok（并且说是 default 会话、已经停过）
      const stopDefault = await ask({ command: "cdp-stop" });
      assert.equal(stopDefault.ok, true);
      assert.equal(stopDefault.session, "default");
      assert.equal(stopDefault.alreadyStopped, true);
      const stopOne = await ask({ command: "cdp-stop", session: "agent-1" });
      assert.equal(stopOne.ok, true);
      assert.equal(stopOne.session, "agent-1");

      // 参数校验失败都发生在「碰 CDP」之前（带 session 也一样）
      const noUrl = await ask({ command: "cdp-nav", session: "agent-1" });
      assert.equal(noUrl.ok, false);
      assert.match(noUrl.error, /需要 url/);

      const noSelector = await ask({ command: "cdp-click", session: "agent-1" });
      assert.equal(noSelector.ok, false);
      assert.match(noSelector.error, /需要 selector/);

      // 没起过这个会话的浏览器：报「没有在运行」并给出降级指引（宿主靠这句话自愈）
      const notRunning = await ask({ command: "cdp-observe", session: "agent-2" });
      assert.equal(notRunning.ok, false);
      assert.match(notRunning.error, /没有在运行/);
      assert.match(notRunning.error, /computer_screenshot/);

      const noText = await ask({ command: "cdp-type", selector: "#q" });
      assert.equal(noText.ok, false);
      assert.match(noText.error, /需要 text/);

      const noWait = await ask({ command: "cdp-wait" });
      assert.equal(noWait.ok, false);
      assert.match(noWait.error, /selector 或 ms/);

      const badUploadDir = await ask({ command: "cdp-upload", selector: "#f", path: "C:\\Windows\\win.ini" });
      assert.equal(badUploadDir.ok, false);
      assert.match(badUploadDir.error, /只接受/);
      assert.match(badUploadDir.error, /orbita-out/);

      const badDownloadDir = await ask({ command: "cdp-download", selector: "#f", dir: "C:\\Windows\\Temp" });
      assert.equal(badDownloadDir.ok, false);
      assert.match(badDownloadDir.error, /orbita-out/);

      const badOp = await ask({ command: "cdp-tabs", op: "delete" });
      assert.equal(badOp.ok, false);
      assert.match(badOp.error, /list 或 switch/);

      const unknown = await ask({ command: "cdp-eval", expression: "1+1", session: "agent-1" });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /未知的 CDP 命令/);

      // 会去起 Edge 的命令：cdp-start 被测试缝挡住；其余命令报「浏览器没在运行」
      // （宿主那边会先自动 cdp-start，所以这句只在自动拉起也失败时才会被模型看到）
      const start = await ask({ command: "cdp-start", session: "agent-3" });
      assert.equal(start.ok, false, "cdp-start 在 --no-browser 下不许成功");
      assert.match(start.error, /测试模式/);
      assert.match(start.error, /computer_screenshot/, "错误里要有降级指引");

      // 启动失败不占名额：下一次发同一个会话的命令仍然按「没在运行」报，而不是「已起过」
      const afterFailedStart = await ask({ command: "cdp-status", session: "agent-3" });
      assert.equal(afterFailedStart.running, false);
      assert.equal(afterFailedStart.session, "agent-3");

      for (const body of [
        { command: "cdp-nav", url: "https://example.com/" },
        { command: "cdp-observe" },
        { command: "cdp-shot" },
        { command: "cdp-extract" },
      ]) {
        const resp = await ask(body);
        assert.equal(resp.ok, false, `${body.command} 在 --no-browser 下不许成功`);
        assert.match(resp.error, /没有在运行/, `${body.command} 应报浏览器未启动：${JSON.stringify(resp)}`);
        assert.match(resp.error, /computer_screenshot/, `${body.command} 的错误里要有降级指引`);
      }

      // 循环还活着（CDP 分支报错不能弄死命令循环）
      const ping = await ask({ command: "ping" });
      assert.deepEqual(ping, { ok: true });

      // 没留下任何 jpg 兄弟文件（截图命令在测试缝下根本没跑）
      assert.deepEqual(fs.readdirSync(cmdDir).filter((f) => f.endsWith(".jpg")), []);
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      killLeftoverWorkers(outDir);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);

// ── worker 层（v1.5-3）：cdp-* 由该会话自己的可杀 worker 子进程执行 ────────────────
//
// 为什么这一层只能靠自测证：它的全部能力都是「进程能起来、能到点被杀、崩了能再起」，
// 纯函数测不到；而真机验收（沙箱 + Edge）太贵，且在这里碰 msedge 是红线。
// `--selftest-worker` 自己起一个子桥（--no-browser --test-hooks），再扮演宿主发命令：
//   ① worker 被拉起并应答 worker-ping（pid 与 worker.json 一致）
//   ② 转发超时（worker-hang 睡 60s）→ 主桥 taskkill，回执是「没有响应（<命令> 超时）」
//   ③ 超时后下一条命令拉起新 worker；把新 worker 打死，下一条还能拉起
//   ④ worker-stop → worker 自己退出（不是被 taskkill 带走的）
//   ⑤ 没有 worker 时汇总 cdp-status 只回 0 个、不拉新进程

test(
  "worker 层 selftest：拉起 / 超时被杀 / 崩了能重启 / 自己退出（全程不碰 Edge）",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 180_000 },
  () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-worker"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 150_000,
    });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // 只解析最后一行：万一自测进程自己也往 stdout 写了一条日志，不该把整份回执打坏
    const line = (r.stdout ?? "").trim().split(/\r?\n/).filter((text) => text.length > 0).pop();
    const parsed = JSON.parse(line);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 12, `用例数应 >= 12，实际 ${parsed.cases}`);
    assert.equal(parsed.failures, undefined, "ok 时不该有 failures");
    console.log(`    worker 自测：${parsed.cases} 条断言全过`);
  },
);

// ── 超时杀 worker 之后的自愈（v1.5-3 真机第一轮的 bug）─────────────────────────
//
// 现场：40s 超时杀 worker 只杀进程树、不删 profile（故意的：登录态要留），于是
// `<profile>\DevToolsActivePort` 里还留着上一只 Edge 的端口。新 Edge 起来后
// WaitForPortFile 一进循环就看见「文件已存在」立刻回 true，把旧端口当成新端口 →
// 下一条 cdp-start 回「Unable to connect to the remote server」，模型既看不懂也修不了。
//
// 修复的两半都要钉住：
//   ① 起 Edge **之前**清掉旧端口文件（顺序错了等于没修）——纯函数行为由
//      `--selftest-worker` 的 ⑥ 那组断言覆盖；
//   ② 连不上要在 guest 内重试，最后回一句带下一步的人话，而不是把 .NET 的裸错误扔给模型。
// 真 Edge 只能在沙箱里验（宿主上碰 msedge 是红线），所以这里锁源码里的顺序与文案。

test("超时杀 worker 后的自愈：起 Edge 前清旧端口文件，连不上在 guest 内重试", () => {
  const src = fs.readFileSync(path.join(scriptDir, "Cdp.cs"), "utf8");

  const clearAt = src.indexOf("ClearStalePortFile(_profileDir)");
  const startAt = src.indexOf("Process.Start(new ProcessStartInfo(edge, args))");
  assert.ok(clearAt > 0, "Launch() 里应当清旧端口文件");
  assert.ok(startAt > 0, "Launch() 里应当启动 Edge");
  assert.ok(clearAt < startAt, "清端口文件必须排在 Process.Start 之前——晚了就是把旧端口当新端口用");

  // 连接要重试（不是一次 HttpGet 失败就抛），且重试前重读端口文件
  assert.match(src, /ConnectRetryMs/);
  assert.match(src, /RefreshPortFromFile\(\)/);
  // 最终失败也要给模型一句能照着做的：裸的 "Unable to connect to the remote server" 不算
  assert.match(src, /稍后重试一次 sandbox_navigate/);
  assert.match(src, /computer_screenshot \/ computer_click 像素工具/);
});

// ── 注入失败文案（B）────────────────────────────────────────────────────
//
// 真机在垂死 / 未就绪的沙箱里拿到「SendInput 只送达 0/4（错误码 5）」，模型只能看见一个
// 裸数字，白试了两轮。这条**测不了那条路径**（要 SendInput 真的失败，而宿主上跑注入是红线），
// 所以照约定直接断言源码里的文案常量：它被删掉 / 被改回裸错误码时这条会红。

test("注入失败文案：错误码 5 带人话解释（模型看得到的就这一句）", () => {
  const src = fs.readFileSync(path.join(scriptDir, "Program.cs"), "utf8");
  assert.match(src, /DescribeSendInputError/);
  assert.match(src, /错误码 5 = 拒绝访问/);
  assert.match(src, /先截图确认沙箱状态/);
  // 文案要接进异常消息里，不能只定义不用
  assert.match(src, /个事件（" \+ DescribeSendInputError/);
});

// ── launch 路径闸门的纯函数自测（--selftest-launch）────────────────────────────
//
// launch 能 Process.Start 任意 exe，边界就是那道路径闸门；它是纯函数，宿主上就能测，
// 不必起沙箱、更不必真启动一份打包版（在宿主上真启动打包版属于红线）。

test(
  "launch 路径闸门 selftest：只放行沙箱桌面下的 .exe，.. / 大小写 / 相对路径都被判对",
  { skip: !isWindows && "仅在 Windows 上运行" },
  () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-launch"], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 8, `用例数应 >= 8，实际 ${parsed.cases}`);
  },
);

// ── 会话 id 安全化的纯函数自测（--selftest-session）────────────────────────────────
//
// 会话 id 是**外部输入**（宿主给的 session 字段），而它会被拼进 `C:\orbita-browser\sessions\<键>`。
// 没这层闸门，一个带 `..` 的 id 就能把 profile 目录指到 guest 的任意位置。
// 纯函数，宿主上就能测，不必起沙箱、更不必起 Edge。

test(
  "会话 id 安全化 selftest：只留 [A-Za-z0-9_-]、截断 48、空串回 default、上限文案可照做",
  { skip: !isWindows && "仅在 Windows 上运行" },
  () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-session"], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 12, `用例数应 >= 12，实际 ${parsed.cases}`);
  },
);

// ── 浏览器错误页判定的纯函数自测（--selftest-cdp）──────────────────────────────────
//
// 离线时错误页也是一个「加载完成」的普通页面，旧行为因此回 ok:true + 「可能还在渲染」——
// 对模型是假成功，而且每次白等满 20 秒。判定与原因码都是纯函数，宿主上就能测；
// 「导航真的落在 chrome-error:// 上」只有沙箱验收能验。

test(
  "浏览器错误页 selftest：chrome-error:// 与正文 ERR_ 码命中、正常页面不命中、码/人话/URL 截断/失效 session 都对得上",
  { skip: !isWindows && "仅在 Windows 上运行" },
  () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-cdp"], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 30, `用例数应 >= 30，实际 ${parsed.cases}`);
  },
);

// ── 耗时计量的纯函数自测（--selftest-metrics）──────────────────────────────────
//
// 计量这一刀的产出就是「能读的数字」，所以先钉住它自己的口径：阈值、mtime 法传播的可信性
// 判定（缺失 / 时基差 / 超窗口）、一行日志的算术（传播可信时总 = 传播 + 读 + 执行 + 落盘，
// 轮询等待是传播内部的细分、**不计入总**），再在临时目录里跑一条真 ping 确认那行真的落出来。
// 全程不碰桌面、不起 Edge、不起子进程。

test(
  "耗时计量 selftest：阈值 / 传播可信性 / 一行日志的算术 / --align-every / 真链路真的落一行",
  { skip: !isWindows && "仅在 Windows 上运行" },
  () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const r = spawnSync(exePath, ["--selftest-metrics"], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, `selftest 应成功退出\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // 自测里会临时把打印线压到 0，命令行日志会落到 stdout；JSON 是最后一行
    const jsonLine = r.stdout.trim().split(/\r?\n/).pop();
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.cases >= 30, `用例数应 >= 30，实际 ${parsed.cases}`);
  },
);

// ── 打包产物冒烟的三条命令：参数校验与错误路径（不启动、不杀任何真进程）───────────
//
// ⚠ **红线**：launch 真成功就是在宿主上拉起一个 exe。所以这一组：
//   - launch 一律走 dryRun（桥只校验路径，不启动进程）；
//   - 真启动的路径用**沙箱里才存在**的路径去撞（宿主上没有 C:\Users\WDAGUtilityAccount），
//     于是它必然停在「沙箱里没有这个文件」——不启动任何东西，却能把成功前置的校验跑完；
//   - kill 只碰一个几乎不可能存在的 pid，并且一律带 dryRun 或者根本不存在。

test(
  "launch / kill / screenshot-stats：参数校验与错误路径；宿主上不启动任何进程",
  { skip: !isWindows && "仅在 Windows 上运行", timeout: 120_000 },
  async () => {
    assert.ok(fs.existsSync(exePath), "exe 应已由 build 测试生成：" + exePath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbita-bridge-launch-test-"));
    const cmdDir = path.join(outDir, "cmd");

    const bridge = spawn(exePath, ["--out-dir", outDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bridgeLog = "";
    bridge.stdout.on("data", (d) => (bridgeLog += d));
    bridge.stderr.on("data", (d) => (bridgeLog += d));

    const guestExe = "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\orbita.exe";
    let seq = 0;
    const ask = async (body) => {
      seq += 1;
      const name = "cmd-" + String(seq).padStart(6, "0");
      writeRequest(cmdDir, name, JSON.stringify({ seq, ...body }));
      const respPath = path.join(cmdDir, name + ".resp.json");
      assert.ok(await waitForFile(respPath), `应收到响应。桥日志：\n${bridgeLog}`);
      return JSON.parse(fs.readFileSync(respPath, "utf8"));
    };

    try {
      assert.ok(await waitForFile(path.join(outDir, "bridge.json")), "桥应就绪");

      // ---- launch：参数校验 ----
      const noPath = await ask({ command: "launch", dryRun: true });
      assert.equal(noPath.ok, false);
      assert.match(noPath.error, /需要 path 字段/);

      const outside = await ask({ command: "launch", path: "C:\\Windows\\System32\\cmd.exe", dryRun: true });
      assert.equal(outside.ok, false, "桌面之外的路径不许放行");
      assert.match(outside.error, /只允许沙箱桌面下/);

      const traversal = await ask({
        command: "launch",
        path: "C:\\Users\\WDAGUtilityAccount\\Desktop\\..\\..\\Windows\\System32\\cmd.exe",
        dryRun: true,
      });
      assert.equal(traversal.ok, false, ".. 穿越回桌面之外要拦下");

      const notExe = await ask({
        command: "launch",
        path: "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\resources\\app.asar",
        dryRun: true,
      });
      assert.equal(notExe.ok, false);
      assert.match(notExe.error, /只启动 \.exe/);

      // 路径合法但文件不存在（宿主上没有 WDAGUtilityAccount）→ 人话错误，**不启动任何东西**
      const missing = await ask({ command: "launch", path: guestExe, dryRun: true });
      assert.equal(missing.ok, false);
      assert.match(missing.error, /沙箱里没有这个文件/);
      assert.match(missing.error, /dist\/win-unpacked/, "错误里要写出下一步（先出包）");

      // ---- kill：参数校验与幂等 ----
      const noPid = await ask({ command: "kill" });
      assert.equal(noPid.ok, false);
      assert.match(noPid.error, /整数 pid/);

      const zeroPid = await ask({ command: "kill", pid: 0 });
      assert.equal(zeroPid.ok, false, "pid 0 是拒绝值（不能变成「杀当前进程组」之类）");

      const negative = await ask({ command: "kill", pid: -5 });
      assert.equal(negative.ok, false);

      // 不存在的 pid：幂等成功，并且**没有任何东西被杀**（dryRun 也拦一道）
      const gone = await ask({ command: "kill", pid: 4_000_000, dryRun: true });
      assert.equal(gone.ok, true, JSON.stringify(gone));
      assert.equal(gone.alreadyGone, true);

      // ---- screenshot-stats：字段与边界 ----
      const stats = await ask({ command: "screenshot-stats", maxWidth: 320 });
      assert.equal(stats.ok, true, JSON.stringify(stats));
      assert.ok(Number.isInteger(stats.width) && stats.width > 0);
      assert.ok(Number.isInteger(stats.height) && stats.height > 0);
      assert.ok(Math.max(stats.width, stats.height) <= 320, `长边应 ≤ 320，实际 ${stats.width}x${stats.height}`);
      for (const key of ["mean", "stdDev", "blackRatio", "whiteRatio"]) {
        assert.equal(typeof stats[key], "number", `${key} 应是数字`);
        assert.ok(stats[key] >= 0, `${key} 不该是负数`);
      }
      assert.ok(stats.mean <= 255, "mean 是亮度，不该超过 255");
      assert.ok(stats.blackRatio <= 1 && stats.whiteRatio <= 1, "占比不该超过 1");
      assert.ok(stats.blackRatio + stats.whiteRatio <= 1.0001, "黑与非黑互斥：两者之和不该超过 1");
      assert.ok(Number.isInteger(stats.distinctColors) && stats.distinctColors >= 1);

      const badWidth = await ask({ command: "screenshot-stats", maxWidth: 0 });
      assert.equal(badWidth.ok, false);
      assert.match(badWidth.error, /maxWidth 必须是正整数/);

      // 循环还活着
      assert.deepEqual(await ask({ command: "ping" }), { ok: true });
    } finally {
      bridge.kill();
      await new Promise((r) => bridge.once("exit", r));
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  },
);
