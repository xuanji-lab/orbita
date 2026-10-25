import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchGuestScreenshot,
  fetchGuestUiaAct,
  fetchGuestUiaList,
  fetchGuestWindowList,
  fetchGuestWindowShot,
  guestTimeoutMessage,
  isPlainScreenshotFileName,
  resetGuestCommandSeq,
  sendGuestCommand,
  startGuestTcpProbe,
} from "./bridge-client.ts";
import { parseBridgeInfo } from "./bridge-ready.ts";
import {
  COMPUTER_USE_CDP_TIMEOUT_MS,
  COMPUTER_USE_CMD_DIR,
  computerUseGuestTimeoutMs,
  GUEST_COMMAND_TIMEOUT_MS,
} from "../../shared/computer-use.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02]);

interface FakeBridgeRequest {
  seq: number;
  command: string;
  maxWidth?: number;
  /** 各命令自己的字段（click 的 x/y、key 的 key…），断言时按名字取 */
  [field: string]: unknown;
}

/**
 * 假桥：轮询 cmd 目录，对每个 req 应用 handler 并写回 resp（+ 可选 jpg），删 req。
 * 协议纪律与真桥一致：jpg 先于 resp 落盘，全部 tmp+rename。
 */
function startFakeBridge(
  outDir: string,
  handler: (req: FakeBridgeRequest) => { resp: Record<string, unknown>; jpg?: Buffer },
): { requests: FakeBridgeRequest[]; stop(): void } {
  const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
  const requests: FakeBridgeRequest[] = [];
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const files = (await readdir(cmdDir)).filter((f) => f.endsWith(".req.json")).sort();
        for (const file of files) {
          const baseName = file.slice(0, -".req.json".length);
          const req = JSON.parse(await readFile(join(cmdDir, file), "utf8")) as FakeBridgeRequest;
          requests.push(req);
          const { resp, jpg } = handler(req);
          if (jpg !== undefined) {
            const jpgTmp = join(cmdDir, `${baseName}.jpg.tmp`);
            await writeFile(jpgTmp, jpg);
            const jpgFinal = join(cmdDir, `${baseName}.jpg`);
            await rm(jpgFinal, { force: true });
            await rename(jpgTmp, jpgFinal);
          }
          const respTmp = join(cmdDir, `${baseName}.resp.json.tmp`);
          await writeFile(respTmp, JSON.stringify(resp), "utf8");
          const respFinal = join(cmdDir, `${baseName}.resp.json`);
          await rm(respFinal, { force: true });
          await rename(respTmp, respFinal);
          await rm(join(cmdDir, file), { force: true });
        }
      } catch {
        // 目录还没建 / 同步抖动，下一轮
      }
      await sleep(20);
    }
  })();
  return {
    requests,
    stop: () => {
      stopped = true;
    },
  };
}

describe("bridge-client（文件协议）", () => {
  test("screenshot 全链：req 落盘 → resp + jpg 回来 → 临时文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, (req) => ({
      resp: { ok: true, nativeWidth: 2560, nativeHeight: 1440, width: 640, height: 360, jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg` },
      jpg: FAKE_JPEG,
    }));
    try {
      const shot = await fetchGuestScreenshot(dir, 640);
      assert.deepEqual(Array.from(shot.jpeg), Array.from(FAKE_JPEG));
      assert.equal(shot.nativeWidth, 2560);
      assert.equal(shot.nativeHeight, 1440);
      assert.equal(bridge.requests[0]?.command, "screenshot");
      assert.equal(bridge.requests[0]?.maxWidth, 640);
      // 清理纪律：cmd 目录里 req/resp/jpg 都不许残留
      const left = await readdir(join(dir, COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("桥回错误命令响应 → 原话抛出，文件清理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: "截图失败：显示器没就绪" } }));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280), /截图失败：显示器没就绪/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("桥死了不回 → 超时抛「没有响应」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280, 300), /没有响应/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("半截 resp（同步抖动）不当成功也不当失败——等到完整文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      const promise = fetchGuestScreenshot(dir, 1280, 3_000);
      await sleep(150); // 等 req 落盘
      const cmdDir = join(dir, COMPUTER_USE_CMD_DIR);
      const reqFile = (await readdir(cmdDir)).find((f) => f.endsWith(".req.json"));
      assert.ok(reqFile, "req 应已落盘");
      const baseName = reqFile.slice(0, -".req.json".length);
      // 先写半截，再写全——模拟撞上半截文件的那一轮
      await writeFile(join(cmdDir, `${baseName}.resp.json`), '{"ok":true,"nativeWidth":', "utf8");
      await sleep(300);
      await writeFile(join(cmdDir, `${baseName}.jpg`), FAKE_JPEG);
      await writeFile(
        join(cmdDir, `${baseName}.resp.json`),
        JSON.stringify({ ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg: `${baseName}.jpg` }),
        "utf8",
      );
      const shot = await promise;
      assert.equal(shot.nativeWidth, 100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("超时默认值是协议常量", () => {
    // 45s 不是宽容值：win+r 后映射目录的枚举缓存会卡住，host→guest 方向有 8–20s 的黑窗
    // （2026-10-14 真机实测，见 GUEST_COMMAND_TIMEOUT_MS 的注释）。
    // 15s 会把一次真成功的注入判成失败，而模型看到失败会重试——同一个动作做两遍。
    assert.equal(GUEST_COMMAND_TIMEOUT_MS, 45_000);
  });

  test("浏览器命令走更长的线：容得下 40s 杀线 + 那句话走回宿主的一跳", () => {
    // 2026-10-25 真机：40s 杀线确实杀了 worker，但宿主 45s 已经放弃——那句「通道已重启、
    // 可以用 cdp-status 确认 / 改用像素工具」没送到模型面前，模型只看到一句笼统的「没有响应」。
    // 那一刻起宿主还要等 resp 过来：同一台机器满载实测每一跳 8–19s（8+40+10 ≈ 59s）。
    assert.equal(COMPUTER_USE_CDP_TIMEOUT_MS, 70_000);
    const bridgeKillLineMs = 40_000; // guest-bridge/WorkerHost.cs 的 CommandTimeoutMs
    assert.ok(
      COMPUTER_USE_CDP_TIMEOUT_MS > bridgeKillLineMs + 15_000,
      "宿主线必须比杀线长出「杀线之后那句话再走一跳」的余量（实测最坏 19s）",
    );
    assert.ok(COMPUTER_USE_CDP_TIMEOUT_MS > GUEST_COMMAND_TIMEOUT_MS, "浏览器命令比像素命令长");

    // 规则只有一份：按命令名取线
    assert.equal(computerUseGuestTimeoutMs("cdp-nav"), COMPUTER_USE_CDP_TIMEOUT_MS);
    assert.equal(computerUseGuestTimeoutMs("cdp-shot"), COMPUTER_USE_CDP_TIMEOUT_MS);
    assert.equal(computerUseGuestTimeoutMs("cdp-status"), COMPUTER_USE_CDP_TIMEOUT_MS);
    for (const pixel of ["screenshot", "click", "type", "key", "scroll", "ping"]) {
      assert.equal(computerUseGuestTimeoutMs(pixel), GUEST_COMMAND_TIMEOUT_MS, pixel);
    }
  });

  test("超时文案能照着做：浏览器命令指向 cdp-status / 像素工具，桌面命令指向先截图", () => {
    // 模型看不见 UI：一句「没有响应」它只能重试同一个动作。两句都要带下一步。
    const browser = guestTimeoutMessage("cdp-nav", COMPUTER_USE_CDP_TIMEOUT_MS);
    assert.match(browser, /沙箱里的浏览器没有响应/);
    assert.match(browser, /cdp-nav 超时 70s/);
    assert.match(browser, /cdp-status/);
    assert.match(browser, /computer_screenshot \/ computer_click/);

    const desktop = guestTimeoutMessage("screenshot", GUEST_COMMAND_TIMEOUT_MS);
    assert.match(desktop, /沙箱里的桌面没有响应/);
    assert.match(desktop, /screenshot 超时 45s/);
    assert.match(desktop, /computer_screenshot/);

    // 超时不是「缓存过期」：宿主的 cdp.ts 靠这两个词做自愈重试，超时不该触发它
    for (const text of [browser, desktop]) {
      assert.ok(!text.includes("没有在运行") && !text.includes("没有启动"), text);
    }
  });

  test("命令序号：单调递增；resetGuestCommandSeq 后从 1 重新数（与桥的快路径对齐）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true } }));
    try {
      await sendGuestCommand(dir, "ping", {});
      await sendGuestCommand(dir, "ping", {});
      const seqs = bridge.requests.map((req) => req.seq);
      assert.equal(seqs.length, 2);
      assert.equal(seqs[1], (seqs[0] ?? 0) + 1, "同一次运行内序号单调递增");
      // 新一局沙箱：宿主归零，桥的 _nextSeq 也从 1 起（否则快路径永远落空）
      resetGuestCommandSeq();
      await sendGuestCommand(dir, "ping", {});
      assert.equal(bridge.requests.length, 3);
      assert.equal(bridge.requests[2]?.seq, 1);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── 通用命令往返（PR2：agent 的 click / type / key / scroll 走它）──────────

  test("通用命令：字段原样到桥、回执回传、文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, dryRun: true, vks: [17, 65] } }));
    try {
      const resp = await sendGuestCommand(dir, "key", { key: "ctrl+a" });
      assert.deepEqual(resp, { ok: true, dryRun: true, vks: [17, 65] });
      assert.equal(bridge.requests[0]?.command, "key");
      assert.equal(bridge.requests[0]?.["key"], "ctrl+a");
      assert.deepEqual(await readdir(join(dir, COMPUTER_USE_CMD_DIR)), []);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("通用命令：桥回错误响应 → 原话抛出（模型要能照抄给用户）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: "不认识的按键名：hyper" } }));
    try {
      await assert.rejects(sendGuestCommand(dir, "key", { key: "hyper+x" }), /不认识的按键名：hyper/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("通用命令：桥死了不回 → 超时抛出（带下一步，不是一句干巴巴的「没有响应」）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    try {
      await assert.rejects(sendGuestCommand(dir, "click", { x: 1, y: 2 }, 300), (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        assert.match(message, /没有响应/);
        assert.match(message, /click 超时 300ms/);
        assert.match(message, /computer_screenshot/, "要告诉模型下一步做什么");
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 截图文件名：路径穿越闸门（审查意见 A）────────────────────────────────
//
// resp 是 guest 进程写的内容，是整条协议里唯一的不可信输入。没有这一关的话，
// 被攻陷的 guest 回一个 `..\..\Users\<me>\.ssh\id_ed25519`，宿主就会替它把任意文件
// 读出来、base64 之后经 IPC 送进 renderer。

describe("截图文件名闸门", () => {
  test("纯文件名才放行；目录 / 反斜杠 / .. / 盘符一律拒", () => {
    for (const name of ["cmd-000001.jpg", "a.jpg", "截图.jpg"]) {
      assert.equal(isPlainScreenshotFileName(name), true, name);
    }
    for (const name of [
      "",
      "..",
      "../x.jpg",
      "..\\x.jpg",
      "..\\..\\Users\\me\\.ssh\\id_ed25519",
      "sub/x.jpg",
      "sub\\x.jpg",
      "a/../b.jpg",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "C:x.jpg",
      "a/..",
    ]) {
      assert.equal(isPlainScreenshotFileName(name), false, name);
    }
  });

  test("恶意 resp：jpeg 指向 cmd 目录之外 → 抛错，绝不读那个文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const secretPath = join(dir, "id_ed25519");
    const secret = "PRIVATE-KEY-CONTENT";
    // 哨兵：cmd 目录是 <dir>/cmd，所以 `..\id_ed25519` 正好指向它
    await writeFile(secretPath, secret, "utf8");
    const bridge = startFakeBridge(dir, () => ({
      resp: { ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg: "..\\id_ed25519" },
    }));
    try {
      await assert.rejects(fetchGuestScreenshot(dir, 1280), /非法的截图文件名/);
      assert.equal(await readFile(secretPath, "utf8"), secret, "哨兵文件应原封不动");
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("恶意 resp：绝对路径与正斜杠穿越同样拒（不同写法都堵）", async () => {
    for (const jpeg of ["/etc/passwd", "C:\\Windows\\win.ini", "../x.jpg", "..", "sub/../x.jpg"]) {
      const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
      const bridge = startFakeBridge(dir, () => ({
        resp: { ok: true, nativeWidth: 100, nativeHeight: 50, width: 100, height: 50, jpeg },
      }));
      try {
        await assert.rejects(fetchGuestScreenshot(dir, 1280), /非法的截图文件名/, jpeg);
      } finally {
        bridge.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

// ── TCP 命令通道（桥 0.8.0）──────────────────────────────────────────────────
//
// 真机上的契约：宿主主动连进 guest，一条连接复用到底；文件协议是回退通道。
// 这里用 node 的 net 起一个假 guest（与 guest-bridge/TcpChannel.cs 同一套行协议），
// 把「什么时候走 TCP、什么时候回退、回退之后上层拿到什么」全部钉死——不需要沙箱。

interface FakeTcpRequest {
  id: number;
  command: string;
  fields: Record<string, unknown>;
}

interface FakeTcpGuestOptions {
  token: string;
  /** 收到命令后怎么回；缺省回 {ok:true} */
  handler?: (req: FakeTcpRequest) => { resp: Record<string, unknown>; jpeg?: Uint8Array };
  /** 非 ping 命令收到后装死（不回执）：验读超时。ping 仍照常回（那是宿主每条命令前的探活） */
  silent?: boolean;
  /** 非 ping 命令收到就掐断连接：验「发出去了但回执丢了」（探活仍然是通的） */
  dropNonPing?: boolean;
  /** 握手成功之后**连 ping 也不回**：验「连接看着还在、实际已经死了」→ 本条命令改走文件 */
  muteAfterGreeting?: boolean;
  /** 前 N 次握手回 hello-fail（模拟「guest 网卡还没就绪」）：验短退避重试 */
  failHellos?: number;
  /** 收下连接但永远不回 hello：模拟握手卡住（验命令不被探活拖慢） */
  hangHello?: boolean;
}

interface FakeTcpGuest {
  port: number;
  connections: number;
  requests: FakeTcpRequest[];
  close(): Promise<void>;
}

/** 假 guest：一行一条 JSON，先握手再收命令（与 guest-bridge/TcpChannel.cs 同一套） */
async function startFakeTcpGuest(options: FakeTcpGuestOptions): Promise<FakeTcpGuest> {
  const requests: FakeTcpRequest[] = [];
  const sockets = new Set<Socket>();
  const state = { connections: 0, failedHellos: 0 };
  const server = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    let greeted = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message["t"] === "hello") {
          // 装死：收下连接但不回 hello（握手超时那一档）
          if (options.hangHello === true) continue;
          // 前 N 次回 hello-fail：模拟「网卡刚起来，通告先到」
          if (state.failedHellos < (options.failHellos ?? 0)) {
            state.failedHellos += 1;
            socket.write(`${JSON.stringify({ t: "hello-fail" })}\n`);
            socket.end();
            return;
          }
          if (message["token"] !== options.token) {
            socket.write(`${JSON.stringify({ t: "hello-fail" })}\n`);
            socket.end();
            return;
          }
          greeted = true;
          socket.write(`${JSON.stringify({ t: "hello-ok" })}\n`);
          continue;
        }
        if (!greeted) {
          socket.destroy();
          return;
        }
        const req: FakeTcpRequest = {
          id: typeof message["id"] === "number" ? message["id"] : -1,
          command: typeof message["command"] === "string" ? message["command"] : "",
          fields: (message["fields"] as Record<string, unknown> | undefined) ?? {},
        };
        requests.push(req);
        // 宿主每条命令发送前都会在这条连接上打一发 ping（探活）：假 guest 默认也要回，
        // 否则所有用例都会变成「探活失败 → 走文件」。muteAfterGreeting 例外，那是专门验它的。
        if (req.command === "ping" && options.muteAfterGreeting !== true) {
          socket.write(`${JSON.stringify({ id: req.id, resp: { ok: true } })}
`);
          continue;
        }
        if (options.muteAfterGreeting === true) continue;
        if (options.dropNonPing === true) {
          socket.destroy();
          return;
        }
        if (options.silent === true) continue;
        const reply = options.handler?.(req) ?? { resp: { ok: true } };
        const frame: Record<string, unknown> = { id: req.id, resp: reply.resp };
        if (reply.jpeg !== undefined) frame["jpegBase64"] = Buffer.from(reply.jpeg).toString("base64");
        socket.write(`${JSON.stringify(frame)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    get connections() {
      return state.connections;
    },
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 写一份 bridge.json（`tcp` 传 null 就是老桥：只有 version / pid） */
async function writeBridgeJson(
  outDir: string,
  tcp: { port: number; token: string; ipv4?: string[] } | null,
  fwAllowed?: boolean,
): Promise<void> {
  const body: Record<string, unknown> = { version: tcp === null ? "0.7.2" : "0.8.2", pid: 4321 };
  if (tcp !== null) {
    body["port"] = tcp.port;
    body["token"] = tcp.token;
    body["ipv4"] = tcp.ipv4 ?? ["127.0.0.1"];
  }
  if (fwAllowed !== undefined) body["fwAllowed"] = fwAllowed;
  await writeFile(join(outDir, "bridge.json"), JSON.stringify(body), "utf8");
}

/**
 * 等后台探活把 TCP 连上。建连**不在命令路径里**（那是本刀的纪律），所以测试先像启动链一样
 * 排一次探活（`startGuestTcpProbe`），再等 guest 接受连接。
 */
async function waitForTcpLink(outDir: string, guest: FakeTcpGuest, timeoutMs = 3000): Promise<boolean> {
  await startGuestTcpProbe(outDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (guest.connections > 0) {
      await sleep(30); // 给握手一点时间（回环上一跳，几十微秒）
      return true;
    }
    await sleep(5);
  }
  return false;
}

/** 临时接管 console.log（验通道日志：同一轮里只关心宿主自己打的那几行） */
async function captureLog<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.log = original;
  }
}

describe("bridge-client（TCP 通道）", () => {
  test("握手成功 → 走 TCP：字段原样到 guest、回执回传、映射目录里一个文件都没有", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({
      token: "t0ken",
      handler: (req) => ({ resp: { ok: true, echo: req.command, got: req.fields["key"] } }),
    });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t0ken" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      const resp = await sendGuestCommand(dir, "key", { key: "ctrl+a" });
      assert.deepEqual(resp, { ok: true, echo: "key", got: "ctrl+a" });
      // 两条：发送前的探活 ping + 正式命令
      assert.deepEqual(guest.requests.map((r) => r.command), ["ping", "key"]);
      assert.equal(guest.connections, 1);
      // 走的是 TCP：宿主没有往映射目录里写 req
      assert.deepEqual(await readdir(join(dir, COMPUTER_USE_CMD_DIR)).catch(() => []), []);
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("同一条连接复用：多条命令只建一次连（连接成本不是每条命令都付）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t" });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      await sendGuestCommand(dir, "ping", {});
      await sendGuestCommand(dir, "ping", {});
      await sendGuestCommand(dir, "ping", {});
      assert.equal(guest.connections, 1);
      // 3 条命令 = 3 发探活 + 3 发正式命令
      assert.equal(guest.requests.length, 6);
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("并发请求在同一条连接上按 id 对号（不是串行排队）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({
      token: "t",
      handler: (req) => ({ resp: { ok: true, command: req.command } }),
    });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      const [first, second] = await Promise.all([
        sendGuestCommand(dir, "cdp-status", {}),
        sendGuestCommand(dir, "screenshot-stats", {}),
      ]);
      assert.equal(first["command"], "cdp-status");
      assert.equal(second["command"], "screenshot-stats");
      assert.equal(guest.connections, 1);
      // 2 条命令 = 2 发探活 + 2 发正式命令
      assert.equal(guest.requests.length, 4);
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("令牌不符 → 透明回退文件协议：上层拿到一样的回执，TCP 侧一条命令都没收到", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "right-token" });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "wrong-token" });
      const resp = await sendGuestCommand(dir, "ping", {});
      assert.deepEqual(resp, { ok: true, via: "file" });
      assert.equal(guest.requests.length, 0);
      assert.equal(bridge.requests.length, 1);
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("端口连不上 → 回退文件协议（命令照样成功）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      // 127.0.0.1:9 通常没在监听 —— 连接会被立刻拒（不需要等 1.5s 超时）
      await writeBridgeJson(dir, { port: 9, token: "t" });
      const resp = await sendGuestCommand(dir, "ping", {});
      assert.deepEqual(resp, { ok: true, via: "file" });
      assert.equal(bridge.requests.length, 1);
    } finally {
      bridge.stop();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("TCP 读超时 → 报「没有响应」，并进冷却：下一条命令直接回到文件协议", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t", silent: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      await assert.rejects(fetchGuestScreenshot(dir, 1280, 300), (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        assert.match(message, /没有响应/, "超时文案与文件协议同一套（下一步该怎么试完全一样）");
        assert.match(message, /截图|screenshot/);
        return true;
      });
      assert.equal(guest.requests.length, 2, "探活 + 正式命令都确实发出去了");
      // 冷却窗口内：直接走文件协议，不再去撞那条已经扭断的连接
      const resp = await sendGuestCommand(dir, "ping", {});
      assert.deepEqual(resp, { ok: true, via: "file" });
      assert.equal(bridge.requests.length, 1);
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("回执丢了（连接被掐）→ 报通道中断，且**不重放**（不会让一次点击变两下）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t", dropNonPing: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      await assert.rejects(sendGuestCommand(dir, "click", { x: 10, y: 20 }), (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        assert.match(message, /命令通道中断/);
        assert.match(message, /click/);
        assert.match(message, /computer_screenshot/, "要告诉模型下一步做什么");
        return true;
      });
      assert.equal(bridge.requests.length, 0, "已发出的命令不许经文件协议重放");
      assert.deepEqual(await readdir(join(dir, COMPUTER_USE_CMD_DIR)).catch(() => []), []);
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("jpegBase64 还原成 Uint8Array（截图不经过映射目录）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({
      token: "t",
      handler: () => ({
        resp: { ok: true, nativeWidth: 2560, nativeHeight: 1440, width: 640, height: 360, jpeg: "tcp-000001.jpg" },
        jpeg: FAKE_JPEG,
      }),
    });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      const shot = await fetchGuestScreenshot(dir, 640);
      assert.deepEqual(Array.from(shot.jpeg), Array.from(FAKE_JPEG));
      assert.equal(shot.width, 640);
      assert.equal(shot.nativeWidth, 2560);
      assert.deepEqual(await readdir(join(dir, COMPUTER_USE_CMD_DIR)).catch(() => []), []);
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("guest 回 ok:false → 原话抛出（那是命令失败，不是通道失败，不回退也不重试）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({
      token: "t",
      handler: () => ({ resp: { ok: false, error: "不认识的按键名：hyper" } }),
    });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      await assert.rejects(sendGuestCommand(dir, "key", { key: "hyper+x" }), /不认识的按键名：hyper/);
      assert.deepEqual(guest.requests.map((r) => r.command), ["ping", "key"], "探活一通，正式命令一通");
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("老桥兼容：bridge.json 只有 version / pid（或 TCP 字段不全）→ 纯文件协议", async () => {
    const variants: Array<{ port: number; token: string } | null> = [
      null,
      { port: 50000, token: "" },
      { port: Number.NaN, token: "t" },
    ];
    for (const tcp of variants) {
      const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
      resetGuestCommandSeq();
      const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
      try {
        await writeBridgeJson(dir, tcp);
        const resp = await sendGuestCommand(dir, "ping", {});
        assert.deepEqual(resp, { ok: true, via: "file" }, JSON.stringify(tcp));
        assert.equal(bridge.requests.length, 1);
      } finally {
        bridge.stop();
        resetGuestCommandSeq();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("bridge.json 换成新桥的通告后，parseBridgeInfo 拿到的是新端口与新令牌", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-tcp-"));
    resetGuestCommandSeq();
    const deadGuest = await startFakeTcpGuest({ token: "old", dropNonPing: true });
    const freshGuest = await startFakeTcpGuest({ token: "new" });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true } }));
    try {
      await writeBridgeJson(dir, { port: deadGuest.port, token: "old" });
      assert.ok(await waitForTcpLink(dir, deadGuest), "后台探活应把 TCP 连上");
      await assert.rejects(sendGuestCommand(dir, "screenshot-stats", {}), /命令通道中断/);
      // 桥重启：新通告、新端口、新令牌（冷却期间命令走文件协议，冷却后重新读通告）
      await writeBridgeJson(dir, { port: freshGuest.port, token: "new" });
      const parsed = parseBridgeInfo(await readFile(join(dir, "bridge.json"), "utf8"));
      assert.equal(parsed?.tcp?.port, freshGuest.port);
      assert.equal(parsed?.tcp?.token, "new");
      assert.deepEqual(parsed?.tcp?.ipv4, ["127.0.0.1"]);
      const resp = await sendGuestCommand(dir, "ping", {});
      assert.deepEqual(resp, { ok: true }, "冷却中：这条走文件协议");
      assert.equal(bridge.requests.length, 1);
    } finally {
      bridge.stop();
      await deadGuest.close();
      await freshGuest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── TCP 后台探活（真机第一轮的修正）────────────────────────────────────────
//
// 真实现场（2026-10-25，沙箱 21209ms 起）：bridge.json 一到宿主就同步建连，但 guest 的网卡
// 还要几秒才就绪；旧策略「首次失败 → 10s 冷却」把开局那几条命令全送给了每跳 6 秒的文件协议。
// 现在：建连从命令路径里拿出去，后台探活 + 短退避重试；命令到了没连上就直接走文件协议。

describe("bridge-client（TCP 后台探活）", () => {
  test("探活不阻塞命令：握手还挂着时命令立刻走文件协议，探活自己在后台跑", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-probe-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t", hangHello: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      const started = Date.now();
      const resp = await sendGuestCommand(dir, "ping", {});
      const elapsed = Date.now() - started;
      assert.deepEqual(resp, { ok: true, via: "file" });
      assert.equal(bridge.requests.length, 1);
      // 探活的握手预算是 1.5s：这条命令绝不许把它算进自己的耗时
      assert.ok(elapsed < 800, `命令不该等探活，实测 ${elapsed}ms`);
      assert.ok(await waitForTcpLink(dir, guest, 500), "探活应在后台自己跑起来（连上了，握手挂着）");
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("首轮失败按短退避再试：第 2 次连上就换回 TCP，日志写明第几次尝试与失败原因", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-probe-"));
    resetGuestCommandSeq();
    // 第一次握手回 hello-fail（= 通告先到、网卡还没就绪），之后正常
    const guest = await startFakeTcpGuest({ token: "t", failHellos: 1 });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      const { lines } = await captureLog(async () => {
        // 通告刚出现：通道还没连上，这条走文件协议（但不该慢）
        await sendGuestCommand(dir, "ping", {});
        // 退避后（500ms）第二次尝试应连上
        const deadline = Date.now() + 3000;
        while (guest.connections < 2 && Date.now() < deadline) await sleep(10);
        await sleep(50);
        // 这一条应当已经走 TCP
        await sendGuestCommand(dir, "ping", {});
      });
      assert.equal(bridge.requests.length, 1, "只有通告刚出现的那条走文件协议");
      assert.equal(guest.requests.length, 2, "退避重试连上之后，下一条命令走 TCP（探活 + 正式）");
      const joined = lines.join("\n");
      assert.match(joined, /通道：TCP 连接失败（第 1 次）：.*握手失败：桥回 hello-fail/, "每次尝试的失败原因都要留在日志里");
      assert.match(joined, /通道：TCP 127\.0\.0\.1:\d+（第 2 次尝试后）/, "连上时要写明第几次尝试");
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("探活不做无谓的重试：已经连上就不再建连（连接复用）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-probe-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t" });
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "后台探活应把 TCP 连上");
      for (let i = 0; i < 5; i += 1) await sendGuestCommand(dir, "ping", {});
      await sleep(600); // 足够跨过一轮退避窗口
      assert.equal(guest.connections, 1, "连上之后不许再建新连接");
      assert.equal(guest.requests.length, 10, "5 条命令 = 5 发探活 + 5 发正式命令");
    } finally {
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 发送前的连接探活（真沙箱里宿主→guest 的 TCP 间歇可达）────────────────
//
// 真机现场（2026-10-25）：握手成功的连接可能几秒后就不通了，而 guest 的 accept 心跳显示
// 「已接入 0 条」——SYN 根本没到。两端代码都改不动这件事，所以 TCP 只当机会型加速器：
// 每条命令发送前先在这条连接上打一发 ping，回执没来就让**这一条命令**改走文件协议。

describe("bridge-client（发送前探活）", () => {
  test("探活没回执 → 本条命令改走文件并成功（不报错、不重放）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-health-"));
    resetGuestCommandSeq();
    // 握手照旧成功，但之后连 ping 都不回：连接「看着还在、其实已经不通了」
    const guest = await startFakeTcpGuest({ token: "t", muteAfterGreeting: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest), "握手本身仍然成功（这是真机那种「通着通着就不通」）");
      const { value, lines } = await captureLog(async () => sendGuestCommand(dir, "screenshot-stats", {}));
      assert.deepEqual(value, { ok: true, via: "file" }, "探活失败只让这一条命令改走文件，不报错");
      assert.equal(bridge.requests.length, 1, "命令确实走文件协议跑完了");
      // 关键：正式命令**没有**被发进 TCP（探活先倒下了），所以不存在重放
      assert.deepEqual(guest.requests.map((r) => r.command), ["ping"]);
      const joined = lines.join("\n");
      assert.match(joined, /通道：TCP 探活失败（.*），本条命令改走文件/, "日志要能看出为什么这条走了文件");
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("探活失败日志 10s 内同一原因只打一行（间歇丢包不刷屏）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-health-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t", muteAfterGreeting: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest));
      const { lines } = await captureLog(async () => {
        // 第 1 条：探活失败 → 丢连接（不进冷却）；后台会重连，所以第 2 条也能再撞一次探活
        await sendGuestCommand(dir, "screenshot-stats", {});
        const deadline = Date.now() + 3000;
        while (guest.connections < 2 && Date.now() < deadline) await sleep(10);
        await sleep(50);
        await sendGuestCommand(dir, "screenshot-stats", {});
      });
      const probeLines = lines.filter((line) => line.includes("TCP 探活失败"));
      assert.equal(probeLines.length, 1, `同一原因 10s 内只打一行，实际 ${probeLines.length} 行：\n${lines.join("\n")}`);
      assert.equal(bridge.requests.length, 2, "两条命令都靠文件协议跑完");
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("连续两次探活失败才进冷却：冷却期内不再发探活、不再重连", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-health-"));
    resetGuestCommandSeq();
    const guest = await startFakeTcpGuest({ token: "t", muteAfterGreeting: true });
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      await writeBridgeJson(dir, { port: guest.port, token: "t" });
      assert.ok(await waitForTcpLink(dir, guest));
      // 第 1 次探活失败：只丢这条连接，不进冷却（后台会自己重连一条）
      await sendGuestCommand(dir, "screenshot-stats", {});
      assert.equal(bridge.requests.length, 1);
      const deadline = Date.now() + 3000;
      while (guest.connections < 2 && Date.now() < deadline) await sleep(10);
      await sleep(80); // 等后台那条连接握手完（回环上一跳）
      assert.equal(guest.connections, 2, "探活失败后应在后台重连一条");
      // 第 2 次探活失败 → 连续两次，进冷却
      await sendGuestCommand(dir, "screenshot-stats", {});
      assert.equal(bridge.requests.length, 2);
      const connections = guest.connections;
      const requests = guest.requests.length;
      // 冷却期内：命令直接走文件协议，既不发探活也不重连
      await sendGuestCommand(dir, "screenshot-stats", {});
      assert.equal(bridge.requests.length, 3);
      assert.equal(guest.connections, connections, "冷却期内不该再建连");
      assert.equal(
        guest.requests.length,
        requests,
        `冷却期内不该再发探活（新增：${JSON.stringify(guest.requests.slice(requests).map((r) => r.command))}）`,
      );
    } finally {
      bridge.stop();
      await guest.close();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 防火墙状态（0.8.2）────────────────────────────────────────────────────
//
// 真机 2026-10-25 的结论：沙箱弹出「Windows 防火墙已阻止…orbita-guest-bridge」的提示，
// 没人点「允许」时入站 TCP 全被丢（宿主 8 次全超时、guest 心跳「已接入 0 条」），点完立刻通。
// 桥现在会自己建入站允许规则并把结果写进 bridge.json 的 fwAllowed；宿主据此把「连不上」说清楚。

describe("bridge-client（防火墙状态）", () => {
  test("bridge.json 的 fwAllowed 被解析出来（老桥没有这个字段 → undefined）", () => {
    const withField = parseBridgeInfo(
      JSON.stringify({ version: "0.8.2", pid: 1, port: 5, token: "t", ipv4: ["127.0.0.1"], fwAllowed: false }),
    );
    assert.equal(withField?.fwAllowed, false);
    const withoutField = parseBridgeInfo(JSON.stringify({ version: "0.8.1", pid: 1 }));
    assert.equal(withoutField?.fwAllowed, undefined);
  });

  test("fwAllowed=false 且连不上：日志说清「沙箱防火墙未放行」，只解释一次，命令照常温", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-fw-"));
    resetGuestCommandSeq();
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, via: "file" } }));
    try {
      // 端口连不上 + 桥自报防火墙没放行（沙箱里那个「允许/取消」没人点的现场）
      await writeBridgeJson(dir, { port: 9, token: "t" }, false);
      const { value, lines } = await captureLog(async () => {
        const resp = await sendGuestCommand(dir, "ping", {});
        // 后台探活会在这条命令之后失败（命令本身不等它）
        await sleep(300);
        await sendGuestCommand(dir, "ping", {});
        await sleep(300);
        return resp;
      });
      assert.deepEqual(value, { ok: true, via: "file" }, "命令语义不变：走文件协议照样成功");
      const hints = lines.filter((line) => line.includes("沙箱防火墙未放行"));
      assert.equal(hints.length, 1, `防火墙提示只解释一次，实际 ${hints.length} 行：\n${lines.join("\n")}`);
      assert.match(hints[0] ?? "", /fwAllowed=false/);
      assert.match(hints[0] ?? "", /点「允许」/);
    } finally {
      bridge.stop();
      resetGuestCommandSeq();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 按窗口截图（win-shot / win-list，桥 0.9.0）──────────────────────────────
//
// 这两条命令的错误原话是模型唯一的换路指示（「这个窗口拍不到…——改用整桌面截图或
// computer_screenshot」），所以这一层只验两件事：字段原样到桥上、回执按契约验过再交出去。

describe("窗口截图（win-shot / win-list）", () => {
  test("win-shot 全链：hwnd / title / maxWidth 到桥，JPEG 与窗口几何回来，文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, (req) => ({
      resp: {
        ok: true,
        hwnd: req.hwnd ?? 999,
        title: "记事本 - 未命名",
        restoredFromMinimized: true,
        nativeWidth: 800,
        nativeHeight: 600,
        width: 640,
        height: 480,
        jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg`,
      },
      jpg: FAKE_JPEG,
    }));
    try {
      const shot = await fetchGuestWindowShot(dir, { hwnd: 4321, maxWidth: 640 });
      assert.deepEqual(Array.from(shot.jpeg), Array.from(FAKE_JPEG));
      assert.equal(shot.hwnd, 4321);
      assert.equal(shot.title, "记事本 - 未命名");
      assert.equal(shot.restoredFromMinimized, true);
      assert.equal(shot.nativeWidth, 800);
      assert.equal(shot.width, 640);
      assert.equal(bridge.requests[0]?.command, "win-shot");
      assert.equal(bridge.requests[0]?.hwnd, 4321);
      assert.equal(bridge.requests[0]?.maxWidth, 640);
      const left = await readdir(join(dir, COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("win-shot 拍不到：桥的人话原话抛出（不改写成超时 / 缺字段）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const human =
      "这个窗口拍不到（可能被最小化后无法恢复 / 显卡合成方式不支持按窗口截取）——改用整桌面截图或 computer_screenshot";
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: human } }));
    try {
      await assert.rejects(fetchGuestWindowShot(dir, { hwnd: 1 }), new RegExp("拍不到"));
      await assert.rejects(fetchGuestWindowShot(dir, { hwnd: 1 }), new RegExp("computer_screenshot"));
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("win-shot 回执缺字段：报缺字段，不把 undefined 当尺寸交给上层", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, (req) => ({
      resp: { ok: true, width: 640, height: 480, jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg` },
      jpg: FAKE_JPEG,
    }));
    try {
      await assert.rejects(fetchGuestWindowShot(dir, { hwnd: 1 }), /缺字段/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("win-list：windows 数组按契约解析；没有 hwnd 的条目跳过；桥报错原话抛出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({
      resp: {
        ok: true,
        windows: [
          { hwnd: 11, title: "Edge", process: "msedge", className: "Chrome_WidgetWin_1", x: 1, y: 2, w: 3, h: 4, minimized: false, visible: true },
          { title: "半条记录" },
        ],
      },
    }));
    try {
      const windows = await fetchGuestWindowList(dir);
      assert.equal(windows.length, 1);
      assert.deepEqual(windows[0], {
        hwnd: 11,
        title: "Edge",
        process: "msedge",
        className: "Chrome_WidgetWin_1",
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        minimized: false,
        visible: true,
      });
      assert.equal(bridge.requests[0]?.command, "win-list");
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }

    const failing = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const failingBridge = startFakeBridge(failing, () => ({ resp: { ok: false, error: "window 列表失败：桌面没就绪" } }));
    try {
      await assert.rejects(fetchGuestWindowList(failing), /桌面没就绪/);
    } finally {
      failingBridge.stop();
      await rm(failing, { recursive: true, force: true });
    }
  });
});

// ── UIA 车道（uia-list / uia-act，桥 0.10.0）──────────────────────────────
//
// 这一层只做两件事：字段原样到桥上、回执按契约验过再交出去。桥的人话（「它支持：value」
// 「目标窗口没有响应（UIA 调用超时…）」）必须原话抛出——宿主改写那句话，模型就不知道下一步。

describe("UIA 车道（uia-list / uia-act）", () => {
  test("uia-list 全链：hwnd / title / maxItems 原样下发，半条记录跳过，文件清干净", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({
      resp: {
        ok: true,
        hwnd: 4321,
        window: { title: "记事本", className: "Notepad" },
        items: [
          {
            ref: 1,
            name: "文本编辑器",
            controlType: "document",
            automationId: "15",
            className: "Edit",
            x: 10,
            y: 40,
            w: 700,
            h: 500,
            patterns: ["value"],
            enabled: true,
            offscreen: false,
          },
          { ref: 0, name: "坏记录" },
          { name: "没有 ref" },
        ],
        truncated: true,
      },
    }));
    try {
      const reply = await fetchGuestUiaList(dir, { hwnd: 4321, maxItems: 60 });
      assert.equal(reply.hwnd, 4321);
      assert.deepEqual(reply.window, { title: "记事本", className: "Notepad" });
      assert.equal(reply.items.length, 1, "ref 缺失 / 非法的半条记录必须跳过");
      assert.deepEqual(reply.items[0], {
        ref: 1,
        name: "文本编辑器",
        controlType: "document",
        automationId: "15",
        className: "Edit",
        x: 10,
        y: 40,
        w: 700,
        h: 500,
        patterns: ["value"],
        enabled: true,
        offscreen: false,
      });
      assert.equal(reply.truncated, true);
      assert.equal(bridge.requests[0]?.command, "uia-list");
      assert.equal(bridge.requests[0]?.hwnd, 4321);
      assert.equal(bridge.requests[0]?.maxItems, 60);
      const left = await readdir(join(dir, COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uia-list 缺 items / 缺 hwnd：报缺字段，不把半张表交给上层", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, hwnd: 1 } }));
    try {
      await assert.rejects(fetchGuestUiaList(dir, { hwnd: 1 }), /缺 items/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
    const dir2 = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge2 = startFakeBridge(dir2, () => ({ resp: { ok: true, items: [] } }));
    try {
      await assert.rejects(fetchGuestUiaList(dir2, { hwnd: 1 }), /缺 hwnd/);
    } finally {
      bridge2.stop();
      await rm(dir2, { recursive: true, force: true });
    }
  });

  test("uia-list 失败：桥的人话原话抛出（超时文案里要能搜到「UIA 调用超时」）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const human = "目标窗口没有响应（UIA 调用超时：uia-list 在 5 秒内没有返回）——先用 computer_screenshot 看一眼";
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: human } }));
    try {
      await assert.rejects(fetchGuestUiaList(dir, { hwnd: 1 }), new RegExp("UIA 调用超时"));
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uia-act 全链：action / ref / value / timeoutMs 到桥，回执解析成契约形状", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, (req) => ({
      resp: {
        ok: true,
        hwnd: req.hwnd ?? 1,
        action: req.action ?? "invoke",
        usedPattern: "invoke",
        name: "关闭",
        controlType: "button",
        focused: false,
        autoSetFocus: true,
        elapsedMs: 12,
      },
    }));
    try {
      const reply = await fetchGuestUiaAct(dir, {
        hwnd: 4321,
        action: "invoke",
        ref: 2,
        timeoutMs: 1500,
      });
      assert.deepEqual(reply, {
        hwnd: 4321,
        action: "invoke",
        usedPattern: "invoke",
        name: "关闭",
        controlType: "button",
        focused: false,
        autoSetFocus: true,
        elapsedMs: 12,
      });
      assert.equal(bridge.requests[0]?.command, "uia-act");
      assert.equal(bridge.requests[0]?.["action"], "invoke");
      assert.equal(bridge.requests[0]?.["ref"], 2);
      assert.equal(bridge.requests[0]?.["timeoutMs"], 1500);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uia-act 关不掉 AutoSetFocus：autoSetFocus=false 与原因一起带出（不是错误）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({
      resp: {
        ok: true,
        hwnd: 9,
        action: "setValue",
        usedPattern: "value",
        name: "搜索",
        controlType: "edit",
        focused: false,
        autoSetFocus: false,
        autoSetFocusWarning: "AutoSetFocus 关不掉（这个系统的 UIA 客户端没有 IUIAutomation2）——可能抢焦点",
        elapsedMs: 30,
      },
    }));
    try {
      const reply = await fetchGuestUiaAct(dir, { hwnd: 9, action: "setValue", name: "搜索", value: "orbita" });
      assert.equal(reply.autoSetFocus, false);
      assert.match(reply.autoSetFocusWarning ?? "", /AutoSetFocus 关不掉/);
      assert.equal(reply.usedPattern, "value");
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uia-act 回执缺字段 / 动作名不认识：报缺字段，不把 undefined 当动作", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: true, hwnd: 1, action: "click" } }));
    try {
      await assert.rejects(fetchGuestUiaAct(dir, { hwnd: 1, action: "invoke" }), /缺 action/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uia-act 失败：桥的不支持文案原话抛出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-client-"));
    const human = "这个控件不支持 invoke（edit，它支持：value）——改用 computer_click / computer_type 的像素路径";
    const bridge = startFakeBridge(dir, () => ({ resp: { ok: false, error: human } }));
    try {
      await assert.rejects(fetchGuestUiaAct(dir, { hwnd: 1, action: "invoke", ref: 1 }), /不支持 invoke/);
      await assert.rejects(fetchGuestUiaAct(dir, { hwnd: 1, action: "invoke", ref: 1 }), /computer_click/);
    } finally {
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
