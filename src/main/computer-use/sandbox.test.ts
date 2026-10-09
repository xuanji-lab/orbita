import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { COMPUTER_USE_GUEST_PORT, type SandboxStatus } from "../../shared/computer-use.ts";
import { HostServer } from "./host-server.ts";
import { renderWsbXml, SandboxController, type SandboxDeps, type SandboxProcess } from "./sandbox.ts";

// ── 假沙箱进程：只实现状态机用到的 on / kill，exit / error 由测试手动发射 ─────────

class FakeSandboxProcess implements SandboxProcess {
  killed = false;
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
    return true;
  }

  emitExit(code: number | null): void {
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

async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address !== null && typeof address === "object", "服务应已监听");
  return address.port;
}

interface Harness {
  controller: SandboxController;
  dir: string;
  spawned: FakeSandboxProcess[];
  spawnedWsb: string[];
  events: SandboxStatus[];
  serverRef: { current: HostServer | null };
  hostPort(): number | null;
  token(): Promise<string>;
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
    serverRef: { current: null },
    hostPort: () => harness.serverRef.current?.address()?.port ?? null,
    token: async () => {
      // start() 里 .wsb 是异步写的，这里轮询等它落盘（与 hostPort 可用同一先后序）
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          const xml = await readFile(join(dir, "session.wsb"), "utf8");
          const match = /--token ([0-9a-f]+)/.exec(xml);
          assert(match !== null, "session.wsb 里应能抠出 token");
          return match[1] ?? "";
        } catch (cause: unknown) {
          if ((cause as { code?: string }).code !== "ENOENT" || Date.now() > deadline) throw cause;
          await sleep(10);
        }
      }
    },
    close: async () => {
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
    findBindIp: () => ({ name: "vEthernet (Test)", ip: "127.0.0.1" }),
    createServer: (options) => (harness.serverRef.current = new HostServer(options)),
    hostPort: 0,
    onStatus: (status) => harness.events.push(status),
    log: () => {},
    ...overrides,
  });
  return harness;
}

async function register(harness: Harness, token: string, guestPort = COMPUTER_USE_GUEST_PORT): Promise<Response> {
  const port = await waitFor(() => harness.hostPort());
  return fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ port: guestPort }),
  });
}

function requireProc(harness: Harness): FakeSandboxProcess {
  const proc = harness.spawned[0];
  if (proc === undefined) throw new Error("沙箱进程没有被 spawn");
  return proc;
}

const states = (events: SandboxStatus[]): string[] => events.map((event) => event.state);

// ── .wsb 生成 ──────────────────────────────────────────────────────────

describe("renderWsbXml", () => {
  const base = { hostPort: 52740, listenPort: 52741, token: "cafe01" };

  test("XML 转义：路径里的 & < > 引号 / 中文 / 空格都不破坏结构", () => {
    const xml = renderWsbXml({
      ...base,
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

  test("LogonCommand：junction 并到协议固定路径，再按协议参数启动桥；&& 已转义", () => {
    const xml = renderWsbXml({ ...base, bridgeDir: "C:\\some path\\guest-bridge\\bin", outputDir: "C:\\out dir\\out" });
    const command = /<Command>(.+)<\/Command>/s.exec(xml)?.[1] ?? "";
    assert.ok(command.includes("cmd.exe /c &quot;"), "命令应包在 cmd.exe /c 里");
    assert.ok(command.includes("mklink /J C:\\orbita-bridge C:\\Users\\WDAGUtilityAccount\\Desktop\\bin"));
    assert.ok(command.includes("mklink /J C:\\orbita-out C:\\Users\\WDAGUtilityAccount\\Desktop\\out"));
    assert.ok(command.includes("C:\\orbita-bridge\\orbita-guest-bridge.exe --host-port 52740 --listen-port 52741 --token cafe01"));
    assert.ok(command.includes("&amp;&amp;"), "&& 必须转义成 &amp;&amp;");
    assert.ok(!command.includes("&&"), "不允许裸 && 留在 XML 里");
  });
});

// ── 状态机 ─────────────────────────────────────────────────────────────

describe("沙箱状态机（假进程 + 真 HTTP register）", () => {
  test("start → starting；错 token 被 401 挡在门外；对 token 注册 → running", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      const port = await waitFor(() => harness.hostPort());
      assert.ok(port > 0);
      assert.match(harness.spawnedWsb[0] ?? "", /session\.wsb$/);

      const wrong = await register(harness, "deadbeef");
      assert.equal(wrong.status, 401);
      assert.equal(harness.controller.status().state, "starting");

      const right = await register(harness, await harness.token());
      assert.equal(right.status, 200);
      assert.deepEqual(await startPromise, { ok: true });
      const running = harness.controller.status();
      assert.equal(running.state, "running");
      if (running.state === "running") {
        assert.equal(running.guestIp, "127.0.0.1");
        assert.equal(running.guestPort, COMPUTER_USE_GUEST_PORT);
        assert.ok(running.startedAt > 0);
      }
      assert.deepEqual(states(harness.events), ["starting", "running"]);
      // running 期间重复 start 被拒
      assert.deepEqual(await harness.controller.start(), { ok: false, error: "沙箱已经在运行" });
    } finally {
      await harness.close();
    }
  });

  test("register 60 秒（测试缩短）等不到 → error，沙箱进程被杀；stop 从 error 复位回 off", async () => {
    const harness = await makeHarness({ registerTimeoutMs: 120 });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.hostPort());
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没等到 guest 桥注册/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
      assert.ok(requireProc(harness).killed, "超时后应杀掉沙箱进程");
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("网卡一直找不到 → 按 deadline 报 NAT 网络错误", async () => {
    const harness = await makeHarness({ registerTimeoutMs: 120, findBindIp: () => null });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /vEthernet/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("stop：running → stopping（杀进程）→ exit → off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await register(harness, await harness.token());
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

  test("用户自己关掉沙箱窗口：running 期间 exit → 直接 off，不报错；宿主服务不泄漏", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await register(harness, await harness.token());
      await startPromise;
      requireProc(harness).emitExit(null);
      assert.deepEqual(harness.controller.status(), { state: "off" });
      // cleanup 收过尾：宿主服务不再监听（不然下次 start 绑固定端口会 EADDRINUSE）
      assert.equal(harness.serverRef.current?.address(), null);
    } finally {
      await harness.close();
    }
  });

  test("沙箱窗口在注册前被关掉 → error 并把失败原因结给 start()", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.hostPort());
      requireProc(harness).emitExit(1);
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /注册前就关闭/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("启动中途 stop：start() 立刻拿到「已取消」，exit 后收尾为 off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.hostPort());
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
      await waitFor(() => harness.hostPort());
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

  test("running 时经 guest 桥截图：base64 / 原始尺寸 / token / maxWidth 都对", async () => {
    const harness = await makeHarness();
    const seen: { auth: string | undefined; maxWidth: string | null } = { auth: undefined, maxWidth: null };
    let harnessTokenCached = "";
    const guest = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seen.auth = req.headers.authorization;
      seen.maxWidth = url.searchParams.get("maxWidth");
      if (req.headers.authorization !== `Bearer ${harnessTokenCached}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "X-Native-Width": "2560", "X-Native-Height": "1440" });
      res.end(Buffer.from([0xff, 0xd8, 0x01, 0x02]));
    });
    try {
      const guestPort = await listenOn(guest);
      const startPromise = harness.controller.start();
      harnessTokenCached = await harness.token();
      const response = await register(harness, harnessTokenCached, guestPort);
      assert.equal(response.status, 200);
      assert.deepEqual(await startPromise, { ok: true });

      const shot = await harness.controller.screenshot(640);
      assert.equal(shot.ok, true);
      if (shot.ok) {
        assert.equal(shot.jpegBase64, Buffer.from([0xff, 0xd8, 0x01, 0x02]).toString("base64"));
        assert.equal(shot.nativeWidth, 2560);
        assert.equal(shot.nativeHeight, 1440);
        assert.ok(Math.abs(shot.takenAt - Date.now()) < 5_000);
      }
      assert.equal(seen.auth, `Bearer ${harnessTokenCached}`);
      assert.equal(seen.maxWidth, "640");

      // 非法 maxWidth 落回默认 1280（guest 侧看到的查询参数）
      await harness.controller.screenshot(Number.NaN);
      assert.equal(seen.maxWidth, "1280");
    } finally {
      guest.close();
      guest.closeAllConnections();
      await harness.close();
    }
  });

  test("截图超时走 guestTimeoutMs 注入", async () => {
    const harness = await makeHarness({ guestTimeoutMs: 100 });
    const guest = createServer(() => {
      /* 不响应 */
    });
    try {
      const guestPort = await listenOn(guest);
      const startPromise = harness.controller.start();
      const response = await register(harness, await harness.token(), guestPort);
      assert.equal(response.status, 200);
      await startPromise;
      const shot = await harness.controller.screenshot(1280);
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /超时/.test(shot.error));
    } finally {
      guest.close();
      guest.closeAllConnections();
      await harness.close();
    }
  });
});
