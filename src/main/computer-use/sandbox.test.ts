import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_INFO_FILE, COMPUTER_USE_CMD_DIR, type SandboxStatus } from "../../shared/computer-use.ts";
import { parseBridgeInfo, waitForBridgeInfo } from "./bridge-ready.ts";
import {
  junctionPathIssue,
  renderWsbXml,
  SandboxController,
  type SandboxDeps,
  type SandboxProcess,
} from "./sandbox.ts";

// ── 假沙箱进程：只实现状态机用到的 on / kill，exit / error 由测试手动发射 ─────────

class FakeSandboxProcess implements SandboxProcess {
  killed = false;
  /** 进程 id（升级杀 `killTreeByPid` 认它） */
  readonly pid = 4242;
  /** 退出码：null = 还在跑（Node 的 ChildProcess 语义）；emitExit 会把它写上 */
  exitCode: number | null = null;
  /** kill() 被调了几次——「升级时是不是真的又打了一次」看它 */
  killCount = 0;
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)): void {
    if (event === "exit") this.exitListeners.push(listener as (code: number | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }

  kill(): boolean {
    this.killed = true;
    this.killCount += 1;
    return true;
  }

  emitExit(code: number | null): void {
    this.exitCode = code ?? 0;
    for (const listener of this.exitListeners) listener(code);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

// ── 测试脚手架 ──────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await sleep(10);
  }
}

type BridgeReq = { seq: number; command: string; maxWidth?: number };
type BridgeAnswer = { resp: Record<string, unknown>; jpg?: Buffer };
/** null = 装死不应答（模拟死桥；req 文件留着不删，与真桥死亡时的现场一致） */
type Responder = (req: BridgeReq) => BridgeAnswer | null;

interface Harness {
  controller: SandboxController;
  dir: string;
  spawned: FakeSandboxProcess[];
  spawnedWsb: string[];
  events: SandboxStatus[];
  /**
   * 模拟桥上线：写 bridge.json 通告 + 启动命令应答器。
   * respond 缺省 = 只答 ping（状态机测试够用）；截图测试传自己的 handler（记得也要答 ping）；
   * respond 传 null = 通告了但命令通道装死（验 ping 超时路径）。
   */
  announceBridge(options?: { delayMs?: number; respond?: Responder | null }): void;
  /** 已应答的请求记录 */
  requests: BridgeReq[];
  /** 控制器写过的日志（收尾链的「痕迹」就在这里面） */
  logs: string[];
  /** close() 后置位，命令应答器循环据此退出（不然 node --test 被永续循环拖着不退出） */
  closed: boolean;
  close(): Promise<void>;
}

async function makeHarness(overrides: Partial<SandboxDeps> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-computer-use-"));
  const harness: Harness = {
    controller: null as unknown as SandboxController,
    dir,
    spawned: [],
    spawnedWsb: [],
    events: [],
    requests: [],
    logs: [],
    closed: false,
    announceBridge: (options = {}) => {
      const delayMs = options.delayMs ?? 30;
      const respond: Responder | null | undefined = options.respond;
      void (async () => {
        await sleep(delayMs);
        const outDir = join(dir, "out");
        // start() 里 out 目录是异步建的，撞 ENOENT 就等下一轮（模拟真实时序抖动）
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            await mkdir(outDir, { recursive: true });
            await writeFile(join(outDir, BRIDGE_INFO_FILE), JSON.stringify({ version: "test", pid: 42 }), "utf8");
            break;
          } catch {
            await sleep(10);
          }
        }
        // respond === null 表示「通告了但命令通道不通」（ping 超时路径）
        if (respond === null) return;
        const handler: Responder = respond ?? ((req) => (req.command === "ping" ? { resp: { ok: true } } : null));
        const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
        while (!harness.closed) {
          try {
            const files = (await readdir(cmdDir)).filter((f) => f.endsWith(".req.json")).sort();
            for (const file of files) {
              const baseName = file.slice(0, -".req.json".length);
              const req = JSON.parse(await readFile(join(cmdDir, file), "utf8")) as BridgeReq;
              harness.requests.push(req);
              const answer = handler(req);
              if (answer === null) continue; // 装死：不回 resp、不删 req
              const { resp, jpg } = answer;
              if (jpg !== undefined) await writeFile(join(cmdDir, `${baseName}.jpg`), jpg);
              await writeFile(join(cmdDir, `${baseName}.resp.json`), JSON.stringify(resp), "utf8");
              await rm(join(cmdDir, file), { force: true });
            }
          } catch {
            // 目录还没建 / 同步抖动，下一轮
          }
          await sleep(20);
        }
      })();
    },
    close: async () => {
      harness.closed = true;
      harness.controller.dispose();
      // Windows 上杀软 / 索引器会瞬时锁住新建的 .wsb，rm 偶发 ENOTEMPTY，退避重试几下
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt >= 4) throw error;
          await sleep(50 * (attempt + 1));
        }
      }
    },
  };
  harness.controller = new SandboxController({
    // 状态机测试模拟的是 Windows 环境（bridgeDir / sandboxExePath 都是 C:\…）：平台闸门
    // 要看 win32；平台不对的那条路径单独用 platform: "darwin" 覆写测
    platform: "win32",
    computerUseDir: dir,
    bridgeDir: "C:\\fake\\bridge",
    sandboxExePath: "C:\\Windows\\System32\\WindowsSandbox.exe",
    spawnSandbox: (wsbPath) => {
      const proc = new FakeSandboxProcess();
      harness.spawned.push(proc);
      harness.spawnedWsb.push(wsbPath);
      return proc;
    },
    fileExists: () => true,
    bridgePollIntervalMs: 20,
    onStatus: (status) => harness.events.push(status),
    log: (message) => harness.logs.push(message),
    ...overrides,
  });
  return harness;
}

function requireProc(harness: Harness): FakeSandboxProcess {
  const proc = harness.spawned[0];
  if (proc === undefined) throw new Error("沙箱进程没有被 spawn");
  return proc;
}

const states = (events: SandboxStatus[]): string[] => events.map((event) => event.state);

// ── .wsb 生成 ──────────────────────────────────────────────────────────

describe("renderWsbXml", () => {
  test("XML 转义：路径里的 & < > 引号 / 中文 / 空格都不破坏结构", () => {
    const xml = renderWsbXml({
      bridgeDir: 'C:\\Users\\达 玛 & <同事>\\orbita "dev"\\guest-bridge\\bin',
      outputDir: "C:\\Users\\达 玛\\AppData\\Roaming\\orbita-dev\\computer-use\\out",
    });
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.ok(
      xml.includes("<HostFolder>C:\\Users\\达 玛 &amp; &lt;同事&gt;\\orbita &quot;dev&quot;\\guest-bridge\\bin</HostFolder>"),
    );
    // 只读映射桥目录、读写映射输出目录
    const readOnlyParts = xml.split("<ReadOnly>").slice(1);
    assert.deepEqual([readOnlyParts[0]?.split("</")[0], readOnlyParts[1]?.split("</")[0]], ["true", "false"]);
    assert.ok(xml.includes("<Networking>Default</Networking>"));
  });

  test("LogonCommand：junction 并到协议固定路径，桥只带 --out-dir（文件协议无 token/端口）", () => {
    const xml = renderWsbXml({ bridgeDir: "C:\\some path\\guest-bridge\\bin", outputDir: "C:\\out dir\\out" });
    const command = /<Command>(.+)<\/Command>/s.exec(xml)?.[1] ?? "";
    assert.ok(command.includes("cmd.exe /c &quot;"), "命令应包在 cmd.exe /c 里");
    assert.ok(command.includes("mklink /J C:\\orbita-bridge C:\\Users\\WDAGUtilityAccount\\Desktop\\bin"));
    assert.ok(command.includes("mklink /J C:\\orbita-out C:\\Users\\WDAGUtilityAccount\\Desktop\\out"));
    assert.ok(command.includes("C:\\orbita-bridge\\orbita-guest-bridge.exe --out-dir C:\\orbita-out"));
    assert.ok(command.includes("1&gt; C:\\orbita-out\\bridge.log 2&gt;&amp;1"), "桥的日志应重定向进 out 目录（诊断通道）");
    assert.ok(!command.includes("--token"), "文件协议没有 token");
    assert.ok(!command.includes("--listen-port"), "文件协议没有端口");
    assert.ok(command.includes("&amp;&amp;"), "&& 必须转义成 &amp;&amp;");
    assert.ok(!command.includes("&&"), "不允许裸 && 留在 XML 里");
  });
});

// ── bridge.json 通告解析 ────────────────────────────────────────────────

describe("parseBridgeInfo / waitForBridgeInfo", () => {
  test("parse：完整通告通过；半截 / 坏 JSON / 缺 version 都回 null", () => {
    assert.deepEqual(parseBridgeInfo('{"version":"0.1.0","pid":1234}'), { version: "0.1.0", pid: 1234 });
    assert.deepEqual(parseBridgeInfo('{"version":"0.1.0"}'), { version: "0.1.0", pid: 0 });
    assert.equal(parseBridgeInfo('{"version":""}'), null);
    assert.equal(parseBridgeInfo('{"pid":42}'), null);
    assert.equal(parseBridgeInfo('{"version":"0.1'), null);
    assert.equal(parseBridgeInfo("not json"), null);
    assert.equal(parseBridgeInfo(""), null);
  });

  test("wait：文件先坏后好——坏文件不当致命，继续等到好通告", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-ready-"));
    try {
      await writeFile(join(dir, BRIDGE_INFO_FILE), '{"version":"0.1', "utf8"); // 半截
      const waitPromise = waitForBridgeInfo(dir, { timeoutMs: 2_000, intervalMs: 20 });
      await sleep(60);
      await writeFile(join(dir, BRIDGE_INFO_FILE), '{"version":"0.1.0","pid":7}', "utf8");
      const info = await waitPromise;
      assert.equal(info?.version, "0.1.0");
      assert.equal(info?.pid, 7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wait：超时抛人话；取消 resolve null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-ready-"));
    try {
      await assert.rejects(waitForBridgeInfo(dir, { timeoutMs: 60, intervalMs: 10 }), /没等到 guest 桥就绪/);
      const cancelled = await waitForBridgeInfo(dir, { timeoutMs: 5_000, intervalMs: 10, isCancelled: () => true });
      assert.equal(cancelled, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 状态机 ─────────────────────────────────────────────────────────────

describe("沙箱状态机（假进程 + 真 bridge.json 通告）", () => {
  test("start → starting；桥通告后 → running", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null); // start() 内部异步：mkdir → 清旧文件 → 写 wsb → spawn
      assert.match(harness.spawnedWsb[0] ?? "", /session\.wsb$/);
      harness.announceBridge();

      assert.deepEqual(await startPromise, { ok: true });
      const running = harness.controller.status();
      assert.equal(running.state, "running");
      if (running.state === "running") {
        assert.equal(running.bridgeVersion, "test");
        assert.ok(running.startedAt > 0);
      }
      assert.deepEqual(states(harness.events), ["starting", "running"]);
      // running 期间重复 start 被拒
      assert.deepEqual(await harness.controller.start(), { ok: false, error: "沙箱已经在运行" });
    } finally {
      await harness.close();
    }
  });

  test("上一局残留的 bridge.json 会被清掉——不许捡到死人通告", async () => {
    const harness = await makeHarness();
    try {
      // 预埋一份上一局的死通告
      await mkdir(join(harness.dir, "out"), { recursive: true });
      await writeFile(join(harness.dir, "out", BRIDGE_INFO_FILE), '{"version":"old","pid":1}', "utf8");
      const startPromise = harness.controller.start();
      await sleep(50); // 让 start() 先跑完清理与 spawn
      // 死通告应已被删除；此时不 announce 就不会就绪——状态应停在 starting
      assert.equal(harness.controller.status().state, "starting");
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
    }
  });

  test("等不到桥通告 → 超时 error，沙箱进程被杀；stop 从 error 复位回 off", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 150 });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没等到 guest 桥就绪/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
      assert.ok(requireProc(harness).killed, "超时后应杀掉沙箱进程");
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("通告到了但命令通道不通（ping 无应答）→ error，消息指向 ping（映射文件夹开机热身期的护栏）", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 400 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({ respond: null }); // 只通告，不应答任何命令
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /ping/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("ping 阶段中途 stop → start() 拿「已取消」", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 30_000 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({ respond: null }); // ping 永远不会应答，停在握手阶段
      await sleep(200); // 等通告被消费、进入 ping
      const stopPromise = harness.controller.stop();
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /已取消/.test(result.error));
      assert.deepEqual(await stopPromise, { ok: true });
      requireProc(harness).emitExit(0);
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
    } finally {
      await harness.close();
    }
  });

  test("stop：running → stopping（杀进程）→ exit → off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge();
      await startPromise;
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.equal(harness.controller.status().state, "stopping");
      assert.ok(requireProc(harness).killed);
      requireProc(harness).emitExit(0);
      assert.deepEqual(harness.controller.status(), { state: "off" });
      assert.deepEqual(states(harness.events), ["starting", "running", "stopping", "off"]);
    } finally {
      await harness.close();
    }
  });

  test("用户自己关掉沙箱窗口：running 期间 exit → 直接 off，不报错", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge();
      await startPromise;
      requireProc(harness).emitExit(null);
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("沙箱窗口在桥就绪前被关掉 → error 并把真实原因结给 start()（不吞成「已取消」）", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50); // 等 start() 进入轮询
      requireProc(harness).emitExit(1);
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /就绪前就关闭/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("启动中途 stop：start() 立刻拿到「已取消」，exit 后收尾为 off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50); // 等 start() 进入轮询
      const stopPromise = harness.controller.stop();
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /已取消/.test(result.error));
      assert.deepEqual(await stopPromise, { ok: true });
      requireProc(harness).emitExit(0);
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
      assert.ok(requireProc(harness).killed);
    } finally {
      await harness.close();
    }
  });

  test("guest 桥 exe 不存在 → 不 spawn、给明确错误、状态停在 off", async () => {
    const harness = await makeHarness({ fileExists: () => false });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /guest 桥不存在/.test(result.error));
      assert.deepEqual(harness.spawned, []);
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("spawn 失败（error 事件）→ error 态，错误进状态，进程不残留", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50);
      requireProc(harness).emitError(new Error("ENOENT"));
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /启动失败/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
      // error 之后再来的 exit 不改状态（failLocal 已收口）
      requireProc(harness).emitExit(1);
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });
});

// ── 截图（renderer 手动「看一眼」）─────────────────────────────────────────

describe("手动截图", () => {
  test("不在 running → 直接拒绝", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.controller.screenshot();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没有在运行/.test(result.error));
    } finally {
      await harness.close();
    }
  });

  test("running 时经文件协议截图：base64 / 原始尺寸 / maxWidth 传递都对，文件清干净", async () => {
    const harness = await makeHarness();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  nativeWidth: 2560,
                  nativeHeight: 1440,
                  width: req.maxWidth ?? 1280,
                  height: 720,
                  jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg`,
                },
                jpg: jpegBytes,
              },
      });
      assert.deepEqual(await startPromise, { ok: true });

      const shot = await harness.controller.screenshot(640);
      assert.equal(shot.ok, true);
      if (shot.ok) {
        assert.equal(shot.jpegBase64, jpegBytes.toString("base64"));
        assert.equal(shot.nativeWidth, 2560);
        assert.equal(shot.nativeHeight, 1440);
        assert.ok(Math.abs(shot.takenAt - Date.now()) < 5_000);
      }
      const shots = harness.requests.filter((r) => r.command === "screenshot");
      assert.equal(shots[0]?.maxWidth, 640);

      // 非法 maxWidth 落回默认 1280（桥侧看到的请求字段）
      await harness.controller.screenshot(Number.NaN);
      const shotsAfter = harness.requests.filter((r) => r.command === "screenshot");
      assert.equal(shotsAfter[1]?.maxWidth, 1280);

      // 清理纪律：cmd 目录不许残留 req/resp/jpg
      const left = await readdir(join(harness.dir, "out", COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      await harness.close();
    }
  });

  test("桥死了不回 → 超时错误原话带出", async () => {
    const harness = await makeHarness({ guestTimeoutMs: 300 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge(); // 默认应答器只答 ping；截图无人应答
      await startPromise;
      const shot = await harness.controller.screenshot(1280);
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /没有响应/.test(shot.error));
    } finally {
      await harness.close();
    }
  });

  test("桥回错误响应（截图失败）→ 错误原话带出", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping" ? { resp: { ok: true } } : { resp: { ok: false, error: "截图失败：桌面会话没就绪" } },
      });
      await startPromise;
      const shot = await harness.controller.screenshot(1280);
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /桌面会话没就绪/.test(shot.error));
    } finally {
      await harness.close();
    }
  });
});



// ── junction 末段名闸门（审查意见 F）──────────────────────────────────────
//
// .wsb 里那条 junction 命令不加引号（整条包在 cmd.exe /c "…" 里，路径再套引号会把自己
// 绕死），所以映射目录的末段名带空格 / cmd 特殊字符就会把命令切坏——以前这条约束只活在
// 注释里，现在它可执行：start() 在落 .wsb 之前先卡一次。
// 路径一律用 join() 拼（不写反斜杠字面量）：win32 与 posix 的 basename 都认自己那套分隔符。

describe("junction 末段名闸门", () => {
  test("junctionPathIssue：干净名字放行；空格 / cmd 特殊字符拦下；只看末段名", () => {
    const p = (...parts: string[]): string => join(...parts);
    assert.equal(junctionPathIssue(p("app", "guest-bridge", "bin"), p("u", "orbita", "computer-use", "out")), null);
    // 宿主路径前面的空格 / 中文不参与那条命令，不该被拦
    assert.equal(junctionPathIssue(p("Users", "达 玛", "guest-bridge", "bin"), p("Users", "达 玛", "orbita", "out")), null);
    assert.match(String(junctionPathIssue(p("x", "my bridge"), p("y", "out"))), /my bridge/);
    assert.match(String(junctionPathIssue(p("x", "bin"), p("y", "my out"))), /my out/);
    for (const [bridgeDir, outputDir] of [
      [p("x", "bin & co"), p("y", "out")],
      [p("x", "bin"), p("y", "a(b)")],
      [p("x", "a^b"), p("y", "out")],
      [p("x", "100%done"), p("y", "out")],
    ] as const) {
      assert.ok(junctionPathIssue(bridgeDir, outputDir) !== null, `${bridgeDir} / ${outputDir}`);
    }
  });

  test("start：末段名带空格 → 人话错误，不 spawn、不落 .wsb、状态停在 off", async () => {
    const harness = await makeHarness({ bridgeDir: join("some path", "my bridge") });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /my bridge/.test(result.error), result.ok ? "" : result.error);
      assert.deepEqual(harness.spawned, [], "闸门在 spawn 之前，不该起沙箱进程");
      assert.equal(existsSync(join(harness.dir, "session.wsb")), false, "不该落 .wsb");
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });
});

// ── stop 的收尾链：宣布 off 必须有退出证据（2026-10-14 真机咬两次）──────────
//
// 原来的 3 秒兜底定时器直接宣布 off，而 taskkill 可能没杀成 / 只杀掉了 launcher：
// UI 显示「未启动」，宿主却留着 ~2GB 的孤儿 VM（第二次得按 PID 手动清）。
// 现在：kill → 等退出（exit 事件 / exitCode 轮询，二者取先到）→ 还没退就升级一次
// 按 PID 杀进程树 → 再等一个窗口仍不退才 off，并留下「进程可能未退出」的痕迹。

describe("平台闸门", () => {
  test("start：非 win32 → 只报平台那一条，不 spawn、不落 .wsb、状态停在 off（macOS 验收）", async () => {
    const harness = await makeHarness({ platform: "darwin" });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && result.error.includes("只在 Windows"), result.ok ? "" : result.error);
      // 不能报「先运行 bun run build:bridge」那类误导文案
      assert.ok(result.ok === false && !result.error.includes("build:bridge"), result.ok ? "" : result.error);
      assert.deepEqual(harness.spawned, [], "平台不对，不该起沙箱进程");
      assert.equal(existsSync(join(harness.dir, "session.wsb")), false, "不该落 .wsb");
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });
});

describe("stop 的收尾链", () => {
  /** 起一局并进入 running（三例共用） */
  const startRunning = async (harness: Harness): Promise<FakeSandboxProcess> => {
    const startPromise = harness.controller.start();
    harness.announceBridge();
    assert.deepEqual(await startPromise, { ok: true });
    return requireProc(harness);
  };

  test("① 正常退出：退出事件即确认，off；兜底与升级都不发生", async () => {
    const escalated: number[] = [];
    const harness = await makeHarness({
      killTreeByPid: (pid) => escalated.push(pid),
      killFallbackMs: 30,
      killEscalationMs: 30,
    });
    try {
      const proc = await startRunning(harness);
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.equal(harness.controller.status().state, "stopping", "stop() 回执只说这次调用，状态听推送");
      assert.equal(proc.killCount, 1, "第一次 kill 照常发");

      proc.emitExit(0);
      assert.deepEqual(harness.controller.status(), { state: "off" });
      // 两个窗口都过完之后也不许再有杀动作（定时器该被清掉）
      await sleep(150);
      assert.deepEqual(escalated, [], "确认退出之后不许升级杀");
      assert.equal(proc.killCount, 1);
      assert.deepEqual(harness.logs.filter((line) => /升级/.test(line)), []);
    } finally {
      await harness.close();
    }
  });

  test("② 永不退出：升级一次按 PID 杀进程树；仍不退才 off，且留下痕迹（不静默）", async () => {
    const escalated: number[] = [];
    const harness = await makeHarness({
      killTreeByPid: (pid) => escalated.push(pid),
      killFallbackMs: 30,
      killEscalationMs: 40,
    });
    try {
      const proc = await startRunning(harness);
      await harness.controller.stop();
      // 兜底窗口（30ms）→ 升级 → 升级窗口（40ms）→ off
      await waitFor(() => (harness.controller.status().state === "off" ? true : null), 2_000);
      assert.deepEqual(escalated, [4242], "兜底窗口到点应按 PID 升级杀一次");
      assert.ok(harness.logs.some((line) => /升级/.test(line)), harness.logs.join("\n"));
      assert.ok(harness.logs.some((line) => /仍未退出/.test(line)), harness.logs.join("\n"));
      assert.ok(harness.logs.some((line) => /手动结束/.test(line)), "痕迹要带上「怎么收拾」");
      assert.equal(proc.killCount, 1, "升级走的是 killTreeByPid，不再调 child.kill()");
      // 收尾之后不再有新的杀动作
      await sleep(100);
      assert.equal(escalated.length, 1);
    } finally {
      await harness.close();
    }
  });

  test("③ 没接升级杀（无 pid / 无注入点）→ 退回再调一次 child.kill()", async () => {
    const harness = await makeHarness({ killFallbackMs: 30, killEscalationMs: 30 });
    try {
      const proc = await startRunning(harness);
      await harness.controller.stop();
      await waitFor(() => (proc.killCount >= 2 ? true : null), 2_000);
      assert.equal(proc.killCount, 2, "第一次 kill + 升级时再调一次");
    } finally {
      await harness.close();
    }
  });
});
