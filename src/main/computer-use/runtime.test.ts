/**
 * 运行时门面的单测 —— 只验「选谁」这件事，不碰任何真隔离。
 *
 * 三条要钉住的：
 *   1. 启动一个后端前先把另一个停掉（两个隔离同时活着 = 设置页说不清现在用的是哪个）；
 *   2. 租约键跟着后端变（L2 全局独占 / L2b 每会话），且没在跑时回落全局键；
 *   3. 一个后端都没跑时，车道方法回同一句能转告用户的话。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPUTER_USE_DESKTOP_KEY,
  sessionDesktopKey,
  type ComputerUseProbeResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { createComputerUseRuntime, type BackendController } from "./runtime.ts";
import { QemuSandboxProvider, QEMU_CAPABILITIES } from "./qemu.ts";
import { ISOLATION_SESSION_CAPABILITIES } from "./isolation-session.ts";
import { WSB_CAPABILITIES } from "./sandbox.ts";
import type { IsolationSessionController } from "./isolation-session.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";

/** 一个只有状态机的假控制器：状态直接给，行为只记调用 */
function fakeController(name: "wsb" | "iso", state: SandboxState = "off") {
  const calls: string[] = [];
  let current: SandboxState = state;
  const status = (): SandboxStatus =>
    current === "running"
      ? { state: "running", startedAt: 1, bridgeVersion: "0.14.0", backend: name === "wsb" ? "wsb" : "isolation-session" }
      : current === "off"
        ? { state: "off" }
        : current === "error"
          ? { state: "error", message: "假的" }
          : { state: "starting", startedAt: 1 };
  const controller: BackendController = {
    // provider 面：假控制器也如实声明自己是谁、能做什么、桌面怎么算（与真控制器同一个形状）
    id: name === "wsb" ? "wsb" : "isolation-session",
    capabilities: {
      gui: true,
      realPointer: name === "wsb",
      screenshot: true,
      windows: true,
      uia: true,
      // uia: true ⇒ evidence 必须是 "value"（provider.ts 的一致性规则，真值在三个后端里）
      evidence: "value",
      cdp: true,
      sandboxFiles: name === "wsb",
      desktopScope: name === "wsb" ? "shared" : "per-session",
      snapshot: "none",
    },
    desktopKey: (sessionId: string) =>
      name === "wsb" ? COMPUTER_USE_DESKTOP_KEY : sessionDesktopKey(sessionId),
    status,
    start: async () => {
      calls.push("start");
      current = "running";
      return { ok: true };
    },
    stop: async () => {
      calls.push("stop");
      current = "off";
      return { ok: true };
    },
    screenshot: async () => {
      calls.push("screenshot");
      return { ok: true, jpegBase64: "AA==", width: 1, height: 1, nativeWidth: 1, nativeHeight: 1, takenAt: 1 };
    },
    windowShot: async () => {
      calls.push("windowShot");
      return {
        ok: true,
        jpegBase64: "AA==",
        width: 1,
        height: 1,
        nativeWidth: 1,
        nativeHeight: 1,
        hwnd: 1,
        title: "",
        restoredFromMinimized: false,
        takenAt: 1,
      };
    },
    listWindows: async () => {
      calls.push("listWindows");
      return { ok: true, windows: [] };
    },
    uiaList: async () => {
      calls.push("uiaList");
      return {
        ok: true,
        hwnd: 1,
        window: { title: "", className: "" },
        generation: 1,
        mode: "full",
        items: [],
        removed: [],
        unchanged: 0,
        rectMoved: 0,
        passwordFields: 0,
        editFields: 0,
        truncated: false,
      };
    },
    uiaAct: async () => {
      calls.push("uiaAct");
      return { ok: true, hwnd: 1, action: "invoke", usedPattern: "invoke", name: "", controlType: "", autoSetFocus: true, elapsedMs: 1 };
    },
    guestCommand: async (command): Promise<GuestCommandReply> => {
      calls.push(`guest:${command}`);
      return { ok: true, resp: { ok: true } };
    },
    guestCommandReply: async (command): Promise<GuestCommandReply> => {
      calls.push(`reply:${command}`);
      return { ok: true, resp: { ok: true } };
    },
    guestShot: async (command): Promise<GuestShotReply> => {
      calls.push(`shot:${command}`);
      return { ok: true, jpeg: new Uint8Array([1]), resp: {} };
    },
    dispose: () => {
      calls.push("dispose");
    },
  };
  return { controller, calls, status, setState: (next: SandboxState) => (current = next) };
}

function probeResult(): ComputerUseProbeResult {
  return {
    platformOk: true,
    edition: "pro",
    editionOk: true,
    featureState: "enabled",
    sandboxExeFound: true,
    hypervisorState: "present",
    isolationTier: "l2",
    isolationSession: { available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true },
    wsl2: "available",
    ready: true,
    guidance: null,
  };
}

describe("运行时门面", () => {
  it("按设置启动；两只都没跑时 status 是 off、租约键回落全局", async () => {
    const wsb = fakeController("wsb");
    const iso = fakeController("iso");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "wsb",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.deepEqual(runtime.status(), { state: "off" });
    assert.equal(runtime.runningBackend(), null);
    assert.equal(runtime.desktopKey("A"), COMPUTER_USE_DESKTOP_KEY);
    assert.deepEqual(await runtime.start(), { ok: true });
    assert.deepEqual(wsb.calls, ["start"]);
    assert.deepEqual(iso.calls, []);
    assert.equal(runtime.runningBackend(), "wsb");
    await runtime.dispose();
  });

  it("换后端：先停掉正在跑的那只，再启动新的", async () => {
    const wsb = fakeController("wsb", "running");
    const iso = fakeController("iso");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "isolation-session",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.deepEqual(await runtime.start(), { ok: true });
    assert.deepEqual(wsb.calls, ["stop"]);
    assert.deepEqual(iso.calls, ["start"]);
    assert.equal(runtime.runningBackend(), "isolation-session");
  });

  it("停不掉旧后端就不启动新的（两个隔离同时活着比启动失败更难解释）", async () => {
    const wsb = fakeController("wsb", "running");
    wsb.controller.stop = async () => ({ ok: false, error: "VM 还留着" });
    const iso = fakeController("iso");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "isolation-session",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    const started = await runtime.start();
    assert.equal(started.ok, false);
    assert.match(started.ok === false ? started.error : "", /VM 还留着/);
    assert.deepEqual(iso.calls, []);
  });

  it("L2b 在跑时桌面键是每会话一个；L2 在跑时是全局独占", async () => {
    const wsb = fakeController("wsb", "off");
    const iso = fakeController("iso", "running");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "isolation-session",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.equal(runtime.desktopKey("A"), sessionDesktopKey("A"));
    assert.notEqual(runtime.desktopKey("A"), runtime.desktopKey("B"));
    iso.setState("off");
    wsb.setState("running");
    assert.equal(runtime.desktopKey("A"), COMPUTER_USE_DESKTOP_KEY);
  });

  it("一个后端都没跑时，车道方法回一句能转告用户的话（不抛、不挂）", async () => {
    const wsb = fakeController("wsb");
    const iso = fakeController("iso");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "wsb",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    const shot = await runtime.screenshot();
    assert.equal(shot.ok, false);
    assert.match(shot.ok === false ? shot.error : "", /没有在运行/);
    const cmd = await runtime.guestCommand("ping", {});
    assert.equal(cmd.ok, false);
  });

  it("车道方法委托给正在跑的那只（不多发一份）", async () => {
    const wsb = fakeController("wsb");
    const iso = fakeController("iso", "running");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "isolation-session",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    await runtime.uiaList({ title: "x" });
    await runtime.guestShot("cdp-shot", {});
    assert.deepEqual(iso.calls, ["uiaList", "shot:cdp-shot"]);
    assert.deepEqual(wsb.calls, []);
  });

  it("探测把 L2b 的依赖检查一起带出来", async () => {
    const wsb = fakeController("wsb");
    const iso = fakeController("iso");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async (options) => ({
        ...probeResult(),
        isolationSession: (await options?.isolationProbe?.()) ?? probeResult().isolationSession,
      }) },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "wsb",
      probeIsolation: async () => ({ available: false, reason: "缺 Node 24.21", nodeVersion: "24.14.0", nodeOk: false }),
    });
    const result = await runtime.probe();
    assert.equal(result.isolationSession.available, false);
    assert.match(result.isolationSession.reason ?? "", /24\.21/);
  });
});

describe("provider 面（P3 的空位与能力声明）", () => {
  it("capabilities() 跟着正在跑的后端走；一个都没跑 = null", async () => {
    const wsb = fakeController("wsb");
    const iso = fakeController("iso", "running");
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      backend: () => "isolation-session",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    // 没在跑的那只不算：L2b 只会话桌面、没有真实指针
    assert.equal(runtime.capabilities()?.realPointer, false);
    assert.equal(runtime.capabilities()?.desktopScope, "per-session");
    iso.setState("off");
    assert.equal(runtime.capabilities(), null);
    wsb.setState("running");
    assert.equal(runtime.capabilities()?.realPointer, true);
    assert.equal(runtime.capabilities()?.sandboxFiles, true);
  });

  it("QEMU：镜像不全时启动如实失败（带上缺哪个文件），不抛异常也不假装成功", async () => {
    // 指到一个不存在的镜像目录：真的去 spawn 之前就该被 missingQemuVmFiles 拦住
    const qemu = new QemuSandboxProvider({
      paths: {
        imageDir: "/nonexistent-orbita-p3",
        qemuDir: "/nonexistent-orbita-p3/qemu",
        qemu: "/nonexistent-orbita-p3/qemu/root/mingw64/bin/qemu-system-x86_64.exe",
        disk: "/nonexistent-orbita-p3/desktop.qcow2",
        kernel: "/nonexistent-orbita-p3/vmlinuz-virt",
        initrd: "/nonexistent-orbita-p3/initramfs-orbita.cpio.gz",
      },
    });
    assert.deepEqual(qemu.status(), { state: "off" });
    const started = await qemu.start();
    assert.equal(started.ok, false);
    // 错误要能照着做：点名缺的那个文件
    assert.match(started.ok === false ? started.error : "", /desktop\.qcow2/);
    assert.equal(qemu.status().state, "error");
    // 没起来过（或起失败了）→ stop 是幂等的成功（语义是「让它别在跑」）
    assert.deepEqual(await qemu.stop(), { ok: true });
    assert.deepEqual(qemu.status(), { state: "off" });
    // 能力按**实现**声明：Linux 侧没有 UIA / 没有按窗口截图 / 快照还没接
    assert.equal(qemu.capabilities.uia, false);
    assert.equal(qemu.capabilities.windows, false);
    assert.equal(qemu.capabilities.snapshot, "none");
    // 一台 VM 一块屏幕：租约是全局独占键（per-session 要等 VM 池）
    assert.equal(qemu.desktopKey("A"), COMPUTER_USE_DESKTOP_KEY);
  });

  it("选到 L3（qemu）时：先停掉正在跑的 WSB，再起 QEMU，runningBackend 报 qemu", async () => {
    const wsb = fakeController("wsb", "running");
    const iso = fakeController("iso");
    const qemuCalls: string[] = [];
    const qemu = {
      ...fakeController("wsb").controller,
      id: "qemu" as const,
      capabilities: QEMU_CAPABILITIES,
      status: () => ({ state: "off" }) as SandboxStatus,
      start: async (): Promise<ComputerUseStartResult> => {
        qemuCalls.push("start");
        return { ok: true };
      },
      stop: async (): Promise<ComputerUseStopResult> => {
        qemuCalls.push("stop");
        return { ok: true };
      },
    };
    const runtime = createComputerUseRuntime({
      wsb: { ...wsb.controller, probe: async () => probeResult() },
      isolation: iso.controller as unknown as IsolationSessionController,
      qemu,
      backend: () => "qemu",
      probeIsolation: async () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.deepEqual(await runtime.start(), { ok: true });
    // 两个隔离不能同时活着：WSB 先被停
    assert.deepEqual(wsb.calls, ["stop"]);
    assert.deepEqual(qemuCalls, ["start"]);
    assert.deepEqual(iso.calls, []);
    await runtime.dispose();
  });

  it("三个后端的租约粒度只在 provider 里定义一次（门面不再按 id 猜）", () => {
    assert.equal(WSB_CAPABILITIES.desktopScope, "shared");
    assert.equal(ISOLATION_SESSION_CAPABILITIES.desktopScope, "per-session");
    // QEMU 现在一台 VM 一块屏幕（VM 池还没做），所以它和 L2 一样是 shared
    assert.equal(QEMU_CAPABILITIES.desktopScope, "shared");
    // L2b 与 QEMU 都不能把宿主文件放进 guest 的映射目录；只有 L2 能
    assert.deepEqual(
      [WSB_CAPABILITIES, ISOLATION_SESSION_CAPABILITIES, QEMU_CAPABILITIES].map((c) => c.sandboxFiles),
      [true, false, false],
    );
  });
});
