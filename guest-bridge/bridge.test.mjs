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
      assert.equal(info.version, "0.3.0");
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
