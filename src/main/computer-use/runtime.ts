/**
 * 隔离桌面的运行时门面 —— 在 WSB（L2）与 IsolationSession（L2b）之间按设置选一个。
 *
 * 为什么需要它：两个控制器各有完整的生命周期与车道方法，但应用只认「当前那只隔离桌面」。
 * 让上层（ipc / agent-requests / dispatch / cdp）按设置各查一次后端，会有好几份「选谁」的
 * 判断散在各处，迟早互相不一致。这里只有一份。
 *
 * 三个后端（L2 / L2b / P3 的 QEMU）**各自是一个 SandboxProvider**（见 provider.ts）：
 * 「能做哪些事」由后端自己声明（capabilities），这里只负责选谁、并把它的话原样转出去。
 * 为什么不在这里按 id 判断：id 只能回答「是谁」，回答不了「它能不能上传文件」——
 * 每加一个后端就要回来改一次 if，而漏改一次就是「命令发下去、它成功了、但什么也没发生」。
 *
 * 三条纪律：
 *   1. **启动一个后端前先把另一个停掉**：不同后端各自一份 OS 资源（一个 VM / 一个 OS 会话），
 *      同时起来就是两份隔离同时跑，设置页说不清现在用的是哪个，租约也说不对。
 *   2. **status 只报真话**：报「正在跑的那只」，两只都没跑就是 off。设置改了但没重启时，
 *      UI 上显示的还是真的在跑那只（设置页那一行常驻说明「下次启动生效」）。
 *   3. **桌面租约的粒度跟着后端变**：L2 是一块共享屏幕（全局独占键），L2b 是每会话一个桌面
 *      （`desktop:session:<id>`）。这里给出状态真值，dispatch 按它算键。
 */
import {
  COMPUTER_USE_DESKTOP_KEY,
  type ComputerUseBackend,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type ComputerUseUiaActResult,
  type ComputerUseUiaAction,
  type ComputerUseUiaListResult,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import type { ComputerUseGuest } from "./agent-requests.ts";
import type { IsolationSessionController, IsolationSessionProbe } from "./isolation-session.ts";
import { QemuSandboxProvider } from "./qemu.ts";
import {
  SANDBOX_NOT_RUNNING,
  type SandboxCapabilities,
  type SandboxProvider,
} from "./provider.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";

/** 门面要的那部分控制器（两个控制器结构上都满足它） */
/** 门面要的后端面：provider（统一面）+ 各自的能力探测 */
export type BackendController = SandboxProvider;

export interface ComputerUseRuntimeDeps {
  wsb: SandboxProvider & {
    probe(options?: { isolationProbe?: () => Promise<IsolationSessionProbe> }): Promise<ComputerUseProbeResult>;
  };
  isolation: IsolationSessionController;
  /** 当前设置选的后端（每次 start 现读，改设置下一次启动生效） */
  backend: () => ComputerUseBackend | Promise<ComputerUseBackend>;
  /** 能力探测里的 L2b 依赖检查 */
  probeIsolation: () => Promise<IsolationSessionProbe>;
  log?: (message: string) => void;
}

export interface ComputerUseRuntime extends ComputerUseGuest {
  status(): SandboxStatus;
  start(): Promise<ComputerUseStartResult>;
  stop(): Promise<ComputerUseStopResult>;
  probe(): Promise<ComputerUseProbeResult>;
  /** 现在实际在跑哪个后端（两个都没跑 = null）。只用于日志与状态文案 */
  runningBackend(): ComputerUseBackend | null;
  /**
   * 现在在跑那个后端的能力声明；一个都没跑 = null。
   * 上层按它判断「这件事这个后端做不做得到」，不要再认 id（见 index.ts 的上传/下载闸门）。
   */
  capabilities(): SandboxCapabilities | null;
  /** 桌面租约键（L2 = 全局独占；L2b = 每会话一个） */
  desktopKey(sessionId: string): string;
  guestCommandReply(...args: Parameters<ComputerUseGuest["guestCommand"]>): Promise<GuestCommandReply>;
  guestShot(...args: Parameters<ComputerUseGuest["guestCommand"]>): Promise<GuestShotReply>;
  dispose(): Promise<void>;
}

export function createComputerUseRuntime(deps: ComputerUseRuntimeDeps): ComputerUseRuntime {
  const log = deps.log ?? ((message: string) => console.log(`[computer-use] ${message}`));

  /**
   * 后端注册表。顺序即优先级：`running()` 取第一个「不在 off 的」。
   * QEMU 也在这张表里（P3 的空位），它的 status() 恒为 off——注册在这里是为了让
   * 「谁在跑」这件事只有一处枚举，而不是每个方法各写一份 if。
   */
  const providers: readonly SandboxProvider[] = [deps.isolation, deps.wsb, new QemuSandboxProvider()];

  /**
   * 「现在在跑的是谁」。**不缓存**：后端自己的状态机就是真值，缓存一份迟早与它分叉
   * （start 失败、用户点停止、会话自己退出，每一条都要维护缓存）。
   */
  const runningProvider = (): SandboxProvider | null => providers.find((p) => p.status().state !== "off") ?? null;

  /** 对外仍报 shared 的两个 id：设置里能选的只有这两个（QEMU 的开关在 P3-2） */
  const running = (): ComputerUseBackend | null => {
    const provider = runningProvider();
    if (provider === null) return null;
    return provider.id === "qemu" ? null : provider.id;
  };

  const controllerOf = (backend: ComputerUseBackend): SandboxProvider =>
    backend === "wsb" ? deps.wsb : deps.isolation;

  /**
   * 启动：先把另一个停掉。**停不掉就不启动**——两个隔离同时活着比「启动失败」更难解释，
   * 而且用户下一次点停止时不知道自己在停哪一个。
   */
  const start = async (): Promise<ComputerUseStartResult> => {
    const wanted = await deps.backend();
    const other: ComputerUseBackend = wanted === "wsb" ? "isolation-session" : "wsb";
    if (running() === other) {
      log(`切换隔离后端：先停掉 ${other}`);
      const stopped = await controllerOf(other).stop();
      if (stopped.ok === false) {
        return { ok: false, error: `切换后端前停不掉 ${other}：${stopped.error}` };
      }
    }
    return controllerOf(wanted).start();
  };

  const stop = async (): Promise<ComputerUseStopResult> => {
    const current = running();
    if (current === null) return { ok: true };
    return controllerOf(current).stop();
  };

  /**
   * 能力探测：WSB 那套 + L2b 的依赖检查。**L2b 的探测失败不拖累 WSB 的结论**——
   * 它是可选后端，探测本身出错只该让那一行显示原因。
   */
  const probe = async (): Promise<ComputerUseProbeResult> => {
    try {
      return await deps.wsb.probe({ isolationProbe: deps.probeIsolation });
    } catch (cause: unknown) {
      // 探测自己挂了也要给出一份「什么都不知道」的结果：设置页不能因为探测失败而空白
      log(`能力探测失败：${cause instanceof Error ? cause.message : String(cause)}`);
      const isolation = await deps.probeIsolation().catch(() => ({
        available: false,
        reason: "探测失败",
        nodeVersion: process.versions.node,
        nodeOk: false,
      }));
      return {
        platformOk: process.platform === "win32",
        edition: "unknown",
        editionOk: false,
        featureState: "unknown",
        sandboxExeFound: false,
        hypervisorState: "unknown",
        isolationTier: "l1",
        isolationSession: isolation,
        wsl2: "unknown",
        ready: false,
        guidance: "能力探测失败——看主进程日志",
      };
    }
  };

  const notRunning = <T>(error: string = SANDBOX_NOT_RUNNING): Extract<T, { ok: false }> =>
    ({ ok: false, error }) as unknown as Extract<T, { ok: false }>;

  return {
    status: (): SandboxStatus => {
      const backend = running();
      if (backend === null) return { state: "off" };
      return controllerOf(backend).status();
    },
    start,
    stop,
    probe,
    runningBackend: running,
    capabilities: (): SandboxCapabilities | null => runningProvider()?.capabilities ?? null,
    desktopKey: (sessionId: string): string => {
      const provider = runningProvider();
      // 没在跑：全局独占键（保守——让人排队，总比两个人同时点同一个不存在的桌面强）
      if (provider === null) return COMPUTER_USE_DESKTOP_KEY;
      return provider.desktopKey(sessionId);
    },
    screenshot: async (maxWidth?: number): Promise<ComputerUseScreenshotResult> => {
      const backend = running();
      if (backend === null) return notRunning<ComputerUseScreenshotResult>();
      return controllerOf(backend).screenshot(maxWidth);
    },
    windowShot: async (options): Promise<ComputerUseWindowShotResult> => {
      const backend = running();
      if (backend === null) return notRunning<ComputerUseWindowShotResult>();
      return controllerOf(backend).windowShot(options);
    },
    listWindows: async (timeoutMs?: number): Promise<ComputerUseWindowListResult> => {
      const backend = running();
      if (backend === null) return notRunning<ComputerUseWindowListResult>();
      return controllerOf(backend).listWindows(timeoutMs);
    },
    uiaList: async (options): Promise<ComputerUseUiaListResult> => {
      const backend = running();
      if (backend === null) return notRunning<ComputerUseUiaListResult>();
      return controllerOf(backend).uiaList(options);
    },
    uiaAct: async (options: {
      hwnd?: number;
      title?: string;
      ref?: string;
      name?: string;
      perform: ComputerUseUiaAction;
      value?: string;
      timeoutMs?: number;
    }): Promise<ComputerUseUiaActResult> => {
      const backend = running();
      if (backend === null) return notRunning<ComputerUseUiaActResult>();
      return controllerOf(backend).uiaAct(options);
    },
    guestCommand: async (command, fields) => {
      const backend = running();
      if (backend === null) return notRunning<GuestCommandReply>();
      return controllerOf(backend).guestCommand(command, fields);
    },
    guestCommandReply: async (command, fields) => {
      const backend = running();
      if (backend === null) return notRunning<GuestCommandReply>();
      return controllerOf(backend).guestCommandReply(command, fields);
    },
    guestShot: async (command, fields) => {
      const backend = running();
      if (backend === null) return notRunning<GuestShotReply>();
      return controllerOf(backend).guestShot(command, fields);
    },
    dispose: async (): Promise<void> => {
      // 全部都收：一只可能停在 error（资源还在），另一只可能是上一局残留
      for (const provider of providers) {
        await Promise.resolve(provider.dispose()).catch(() => undefined);
      }
    },
  };
}
