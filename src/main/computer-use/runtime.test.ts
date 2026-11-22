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
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { createComputerUseRuntime, type BackendController } from "./runtime.ts";
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
