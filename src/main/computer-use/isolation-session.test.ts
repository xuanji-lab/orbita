/**
 * IsolationSessionController 的单测 —— 状态机、桥投送、端口发现、无指针降级。
 *
 * 用**真的** TCP 假桥（127.0.0.1 上的一个 net.Server）：这样走的是生产同一套
 * bridge-client（bridge.json 解析 → hello 握手 → 命令往返），只有 SDK 与会话是假的。
 * 会话里的东西（OS 账号、OS 会话）在单测里不存在，也不需要——它们由真机验收覆盖。
 */
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  computerUseGuestCommands,
  computerUseIsolationErrors,
} from "../../shared/computer-use.ts";
import {
  ISOLATION_SESSION_CAPABILITIES,
  IsolationSessionController,
  renderLauncherCmd,
  workspaceLayout,
  type IsolationSessionProbe,
  type IsolationSessionProvision,
  type IsolationSessionSdk,
} from "./isolation-session.ts";
import type { SandboxProcess } from "./sandbox.ts";

const READY_MS = 300;
const POLL_MS = 10;
const CLEANUP_MS = 120;

/** 假桥的回执：win-list 要 windows 数组（宿主侧的解析器认它），其余只要 ok */
function fakeReply(command: string | undefined): Record<string, unknown> {
  if (command === "win-list") return { ok: true, windows: [] };
  if (command === "uia-list") {
    return { ok: true, hwnd: 4242, window: { title: "fake", className: "Fake" }, generation: 1, items: [], removed: [], truncated: false };
  }
  return { ok: true };
}

/** 假桥：一条 TCP 服务，认 hello + 每条命令回 {ok:true}。端口由系统分配（与真桥一样） */
interface FakeBridge {
  server: Server;
  port: number;
  /** 收到过的命令名（按顺序） */
  commands: string[];
  close(): Promise<void>;
}

async function startFakeBridge(): Promise<FakeBridge> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let greeted = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const parsed = JSON.parse(line) as { t?: string; id?: number; command?: string };
        if (parsed.t === "hello") {
          greeted = true;
          socket.write('{"t":"hello-ok"}\n');
          continue;
        }
        if (!greeted) continue;
        if (parsed.command !== undefined) commands.push(parsed.command);
        socket.write(JSON.stringify({ id: parsed.id, resp: fakeReply(parsed.command) }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    port,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Harness {
  controller: IsolationSessionController;
  dir: string;
  workspace: string;
  bridgeDir: string;
  sdk: IsolationSessionSdk & {
    calls: string[];
    /** 让 deprovision 故意不删工作区（验「残留就报错」那条路） */
    leaveResidue: boolean;
    /** 让 spawn 不写 bridge.json（验启动超时那条路） */
    silentBridge: boolean;
    provisionFails: boolean;
  };
  bridge: FakeBridge;
  statuses: string[];
}

/**
 * 假桥的**文件协议**那一半：真桥在 out/cmd 里轮询 `.req.json`，回一份 `.resp.json`。
 * 单测里必须两条通道都能应答：`start()` 的 ping 可能落在 TCP 探活还没连上的那一瞬间，
 * 那时 bridge-client 会自动回退文件协议（生产里正是这样）——只有 TCP 应答的假桥会把
 * 一条正常的启动路径判成「ping 超时」。
 */
function serveCommandFiles(workspace: string): () => void {
  const cmdDir = join(workspaceLayout(workspace).outDir, "cmd");
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void (async () => {
      await mkdir(cmdDir, { recursive: true }).catch(() => undefined);
      const names = await readdir(cmdDir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".req.json")) continue;
        const base = name.slice(0, -".req.json".length);
        try {
          const body = await readFile(join(cmdDir, name), "utf8").catch(() => "");
          let command: string | undefined;
          try {
            const parsed = JSON.parse(body) as { command?: string; fields?: { command?: string } };
            command = parsed.command ?? parsed.fields?.command;
          } catch {
            command = undefined;
          }
          await rm(join(cmdDir, name), { force: true });
          await writeFile(join(cmdDir, `${base}.resp.json`), JSON.stringify(fakeReply(command)));
        } catch {
          // 文件被宿主清掉：无所谓
        }
      }
    })();
  };
  const timer = setInterval(tick, 10);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

let cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  const fns = cleanupFns;
  cleanupFns = [];
  for (const fn of fns) await fn().catch(() => undefined);
});

async function makeHarness(options: { withBridgeJson?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-iso-"));
  const workspace = join(dir, "Shared");
  const bridgeDir = join(dir, "bridge");
  await mkdir(workspace, { recursive: true });
  await mkdir(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "orbita-guest-bridge.exe"), "fake-bridge-binary");

  const bridge = await startFakeBridge();
  const stopFileProtocol = serveCommandFiles(workspace);
  const statuses: string[] = [];
  const provision: IsolationSessionProvision = {
    containerId: "iso:test",
    agentUserName: "TEST-AGENT",
    workspacePath: workspace,
  };
  const calls: string[] = [];

  const fakeProcess: SandboxProcess = {
    on: () => undefined,
    kill: () => true,
    pid: 0,
    exitCode: null,
  };

  const sdk = {
    calls,
    leaveResidue: false,
    silentBridge: false,
    provisionFails: false,
    probe: (): IsolationSessionProbe => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    provision: async (): Promise<IsolationSessionProvision> => {
      calls.push("provision");
      if (sdk.provisionFails) throw new Error("provision 拒绝：没有权限");
      return provision;
    },
    start: async () => {
      calls.push("start");
    },
    spawn: async () => {
      calls.push("spawn");
      if (!sdk.silentBridge && options.withBridgeJson !== false) {
        const layout = workspaceLayout(workspace);
        await mkdir(layout.outDir, { recursive: true });
        // 与真桥写的那份同形：port / token / ipv4 三件齐了宿主才走 TCP
        await writeFile(
          layout.bridgeInfo,
          JSON.stringify({
            version: "0.14.0",
            pid: 4242,
            port: bridge.port,
            token: "test-token",
            ipv4: ["127.0.0.1"],
          }),
        );
      }
      return fakeProcess;
    },
    stop: async () => {
      calls.push("stop");
    },
    deprovision: async () => {
      calls.push("deprovision");
      if (!sdk.leaveResidue) await rm(workspace, { recursive: true, force: true });
    },
  };

  const controller = new IsolationSessionController({
    bridgeDir,
    sdk,
    platform: "win32",
    fileExists: existsSync,
    readyTimeoutMs: READY_MS,
    bridgePollIntervalMs: POLL_MS,
    cleanupVerifyMs: CLEANUP_MS,
    guestTimeoutMs: 2_000,
    onStatus: (status) => statuses.push(status.state),
  });

  cleanupFns.push(async () => {
    stopFileProtocol();
    await controller.dispose().catch(() => undefined);
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { controller, dir, workspace, bridgeDir, sdk, bridge, statuses };
}

describe("IsolationSessionController", () => {
  it("launcher 是零引号 token、带 out 目录预建（MXC 的 cmd /c 会剥首尾引号）", () => {
    const cmd = renderLauncherCmd();
    assert.match(cmd, /mkdir "%~dp0out"/);
    assert.match(cmd, /cd \/d "%~dp0"/);
    assert.match(cmd, /"%~dp0bridge\.exe" --out-dir "%~dp0out"/);
    // 整条命令里不能出现「两个以上引号对」的形态之外的东西：MXC 只看到文件名，不看内容
    assert.equal(cmd.includes("&&"), false);
  });

  it("工作区落点：exe / launcher / out / bridge.json 都在工作区下面", () => {
    const layout = workspaceLayout("C:\\Users\\A-1\\Shared");
    assert.equal(layout.exe, "C:\\Users\\A-1\\Shared\\bridge.exe");
    assert.equal(layout.launcher, "C:\\Users\\A-1\\Shared\\start-bridge.cmd");
    assert.equal(layout.outDir, "C:\\Users\\A-1\\Shared\\out");
    assert.equal(layout.bridgeInfo, "C:\\Users\\A-1\\Shared\\out\\bridge.json");
  });

  it("非 Windows 直接拒（先报平台，再谈文件）", async () => {
    const harness = await makeHarness();
    const controller = new IsolationSessionController({
      bridgeDir: harness.bridgeDir,
      sdk: harness.sdk,
      platform: "darwin",
    });
    cleanupFns.push(() => controller.dispose());
    const result = await controller.start();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /只在 Windows 上有/);
    assert.deepEqual(harness.sdk.calls, []);
  });

  it("依赖不可用 → error 带原因，且不 provision（不留 OS 账号）", async () => {
    const harness = await makeHarness();
    const controller = new IsolationSessionController({
      bridgeDir: harness.bridgeDir,
      sdk: {
        ...harness.sdk,
        probe: () => ({ available: false, reason: "Node 24.14 太旧", nodeVersion: "24.14.0", nodeOk: false }),
      },
      platform: "win32",
    });
    cleanupFns.push(() => controller.dispose());
    const result = await controller.start();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /Node 24\.14 太旧/);
    assert.deepEqual(harness.sdk.calls, []);
    assert.deepEqual(controller.status(), { state: "error", message: "Node 24.14 太旧", backend: "isolation-session" });
  });

  it("正常启动：投送桥 → 通告 → ping 通 → running（状态带后端与 agent 账号）", async () => {
    const harness = await makeHarness();
    const result = await harness.controller.start();
    assert.equal(result.ok, true, result.ok === false ? result.error : "");
    const status = harness.controller.status();
    assert.equal(status.state, "running");
    assert.equal(status.state === "running" ? status.backend : null, "isolation-session");
    assert.equal(status.state === "running" ? status.agentUserName : null, "TEST-AGENT");
    // 三个文件真的落到了工作区（宿主侧 = 会话侧同一个绝对路径）
    const layout = workspaceLayout(harness.workspace);
    assert.equal(existsSync(layout.exe), true);
    assert.equal(existsSync(layout.launcher), true);
    assert.equal((await readFile(layout.exe, "utf8")).length > 0, true);
    // 状态迁移里必须有 starting → running（UI 的「启动中」不是摆设）
    assert.deepEqual(harness.statuses, ["starting", "running"]);
    // 端口来自桥的通告（不是我们自己分配的）
    assert.equal(harness.controller.tcpPort(), harness.bridge.port);
    assert.equal(await harness.controller.stop().then((r) => r.ok), true);
  });

  it("桥不通告 → 超时进 error，并把会话收掉（stop + deprovision）", async () => {
    const harness = await makeHarness();
    harness.sdk.silentBridge = true;
    const result = await harness.controller.start();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /bridge.json/);
    assert.equal(harness.sdk.calls.includes("deprovision"), true);
    assert.equal(harness.controller.status().state, "error");
  });

  it("provision 失败 → error，不去 stop 一个不存在的会话", async () => {
    const harness = await makeHarness();
    harness.sdk.provisionFails = true;
    const result = await harness.controller.start();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /provision 拒绝/);
    assert.equal(harness.sdk.calls.includes("deprovision"), false);
    assert.equal(harness.controller.status().state, "error");
  });

  it("桥 exe 不存在 → 明说去构建，而不是一个裸路径", async () => {
    const harness = await makeHarness();
    await rm(join(harness.bridgeDir, "orbita-guest-bridge.exe"));
    const result = await harness.controller.start();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /guest-bridge\/build\.mjs/);
  });

  it("停止：stop → deprovision → 工作区消失 → off", async () => {
    const harness = await makeHarness();
    assert.equal((await harness.controller.start()).ok, true);
    const stopped = await harness.controller.stop();
    assert.equal(stopped.ok, true, stopped.ok === false ? stopped.error : "");
    assert.deepEqual(
      harness.sdk.calls.filter((call) => call === "stop" || call === "deprovision"),
      ["stop", "deprovision"],
    );
    assert.equal(existsSync(harness.workspace), false);
    assert.equal(harness.controller.status().state, "off");
  });

  it("会话释放了但工作区还在 → 报 error 并写出残留路径（不假装 off）", async () => {
    const harness = await makeHarness();
    assert.equal((await harness.controller.start()).ok, true);
    harness.sdk.leaveResidue = true;
    const stopped = await harness.controller.stop();
    assert.equal(stopped.ok, false);
    assert.match(stopped.ok === false ? stopped.error : "", /残留/);
    assert.equal(harness.controller.status().state, "error");
  });

  it("像素输入四命令一律拒，且带 refused（不静默成功）", async () => {
    const harness = await makeHarness();
    // 没在跑也要拒：这条结论由档位决定，与运行状态无关
    for (const command of [
      computerUseGuestCommands.click,
      computerUseGuestCommands.type,
      computerUseGuestCommands.key,
      computerUseGuestCommands.scroll,
    ]) {
      const reply = await harness.controller.guestCommand(command, { x: 1, y: 1, text: "a" });
      assert.equal(reply.ok, false);
      assert.equal(reply.ok === false ? reply.error : "", computerUseIsolationErrors.noPointer);
      assert.equal(reply.ok === false ? reply.delivery : null, "refused");
    }
    // 一条都没发到桥上（真发出去在 RDP 会话里会「成功」而光标不动）
    assert.deepEqual(harness.bridge.commands, []);
  });

  it("非像素命令（UIA / 窗口列表）照常下发到桥", async () => {
    const harness = await makeHarness();
    assert.equal((await harness.controller.start()).ok, true);
    const list = await harness.controller.uiaList({ title: "任意窗口" });
    assert.equal(list.ok, true, list.ok === false ? list.error : "");
    const windows = await harness.controller.listWindows(2_000);
    assert.equal(windows.ok, true, windows.ok === false ? windows.error : "");
    // 通道可能是 TCP 也可能是文件（启动那一瞬 TCP 探活可能还没完成）——两条都是真桥的行为，
    // 只要命令真的到了桥上就算过；具体哪条由 bridge-client 自己选
    const overTcp = harness.bridge.commands;
    assert.equal(
      overTcp.includes(computerUseGuestCommands.uiaList) || overTcp.includes(computerUseGuestCommands.winList),
      true,
      `桥上没看到任何一条真实命令（TCP 收到：${JSON.stringify(overTcp)}）`,
    );
  });

  it("没在跑时截图回一句能转告用户的话", async () => {
    const harness = await makeHarness();
    const shot = await harness.controller.screenshot();
    assert.equal(shot.ok, false);
    assert.match(shot.ok === false ? shot.error : "", /没有在运行/);
  });

  it("stop 在 off 态幂等（不调 SDK）", async () => {
    const harness = await makeHarness();
    const stopped = await harness.controller.stop();
    assert.equal(stopped.ok, true);
    assert.deepEqual(harness.sdk.calls, []);
  });

  it("启动中取消：stop 之后不再宣布 running", async () => {
    const harness = await makeHarness();
    harness.sdk.silentBridge = true;
    const starting = harness.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopped = await harness.controller.stop();
    const started = await starting;
    assert.equal(stopped.ok, true);
    assert.equal(started.ok, false);
    assert.notEqual(harness.controller.status().state, "running");
  });

  it("桥日志与 bridge.json 都读得回来（真机排障用的那一份）", async () => {
    const harness = await makeHarness();
    assert.equal((await harness.controller.start()).ok, true);
    const layout = workspaceLayout(harness.workspace);
    const info = JSON.parse(await readFile(layout.bridgeInfo, "utf8")) as { port: number };
    assert.equal(info.port, harness.bridge.port);
    // 启动链里我们自己写的 launcher 内容可复核（MXC 只看到文件名，内容全在这里）
    assert.match(readFileSync(layout.launcher, "utf8"), /--out-dir/);
  });
});

/**
 * 能力声明里的 evidence（证据级别）——**必须与实现同源**。
 * L2b 没有真实指针，但 E2 实测跨进程 UIA 树可用（Invoke / SetValue 都走通了），
 * 所以它确实能读回控件值：evidence 是 value，不是 none。两件事别混：
 * 「指针能不能落桌面」讲的是输入，`evidence` 讲的是读回。
 */
describe("能力声明：证据级别与实现同源（L2b / MXC 隔离会话）", () => {
  it("有 UIA 控件树 ⇒ evidence 必须是 value（没有真实指针不影响这一项）", () => {
    assert.equal(ISOLATION_SESSION_CAPABILITIES.uia, true);
    assert.equal(ISOLATION_SESSION_CAPABILITIES.realPointer, false);
    assert.equal(ISOLATION_SESSION_CAPABILITIES.evidence, "value");
    // provider.ts 的一致性规则：uia ⇒ value；否则 windows ⇒ window；否则 none
    const implied = ISOLATION_SESSION_CAPABILITIES.uia
      ? "value"
      : ISOLATION_SESSION_CAPABILITIES.windows
        ? "window"
        : "none";
    assert.equal(ISOLATION_SESSION_CAPABILITIES.evidence, implied, "声明得比实现高就是伪造证据");
  });
});
