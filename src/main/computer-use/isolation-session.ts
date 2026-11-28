/**
 * L2b：MXC IsolationSession 生命周期 —— 每个 agent 一个独立 OS 会话。
 *
 * 与 sandbox.ts 的 SandboxController **接口对齐**（status / start / stop / probe + 同一套
 * guest 车道方法），这样上层（运行时门面、agent-requests、dispatch）不需要知道后面是 VM 还是
 * 独立会话——P3 抽 provider 时换的就是这一层。
 *
 * 启动链（真机实测数字写在提交信息里）：
 *   probe（只读）→ provision（OS 生成一个随机账号 + 一个宿主可写的 ephemeral 工作区）
 *   → start → 把 guest 桥 exe 与 launcher 拷进工作区 → 在会话里 spawn launcher
 *   → 轮询工作区的 out/bridge.json → ping 通 → running。
 *
 * **桥怎么进会话**（三条候选路径，只有一条通，2026-11-15 真机实测）：
 *   ① 会话直接读宿主路径（`C:\Users\dama\Desktop\...\orbita-guest-bridge.exe`）→ **读不到**
 *      （`READ_DENIED`）。会话的文件系统与宿主是隔离的，这条想都别想。
 *   ② `ephemeralWorkspacePath`（`provision` 的 metadata，形如 `C:\Users\<agent>\Shared`）
 *      → **通**。它就是为这件事存在的：宿主可写、只有本会话那个账号看得见、deprovision 时
 *      随会话一起删。拷贝 280KB 实测 1ms。
 *   ③ 用 exec 通道把字节流灌进 %TEMP% —— 不必要（② 已经直通），且 base64 过命令行会撞
 *      命令行长度上限。
 * 所以走 ②，并且**每次 start 都重新拷**：工作区的生命周期绑在会话上，不跨局复用。
 *
 * **launcher 为什么是 .cmd 而不是直接 spawn exe**：MXC 把 `command` 原样交给
 * `cmd.exe /c <command>`，而 cmd 在引号多于一对时会**剥掉首尾引号**（"文件名、目录名或卷标
 * 语法不正确" 就是它）。`"<exe>" --out-dir "<dir>"` 有两个引号对 → 被剥成半个路径。
 * 一个 .cmd 文件只有一个引号 token（`start-bridge.cmd`，零引号，相对 cwd），内容里的引号由
 * cmd 自己按行解释，不受那条规则影响。真机三条命令的对照结果写在 f5 探针里。
 *
 * **端口**：不需要分配。桥自己绑 `127.0.0.1:0`（系统分配），把 port / token / ipv4 写进
 * `out/bridge.json`；宿主照老路径读。两个会话并发实测拿到 13505 / 3582，天然不撞。这也是
 * 「每会话一个租约」在传输层的对应物：会话之间不共享任何端口。
 *
 * **桥必须带 `--loopback`**（0.15.1）：这条后端是**用户自己这台 Windows 上的另一个登录会话**
 * ——同一个内核、同一套防火墙。桥默认会在启动时关掉防火墙、加一条 `profile=any` 的入站
 * 端口规则（那是给 Windows Sandbox 的另一台 VM 准备的）；在这里跑就是在改用户整机的系统设置，
 * 是本项目的红线。带上 `--loopback` 后：一次 netsh 都不跑、只绑 `127.0.0.1`、bridge.json 的
 * ipv4 只通告 `127.0.0.1`。宿主与会话共享同一个回环，不需要任何入站放行。
 *
 * **没有真实输入设备**：会话是 RDP 形态（`SM_REMOTESESSION=1`），`SendInput` 返回 3 / err=0
 * 但光标永远停在 (0,0)。所以像素输入四命令（click / type / key / scroll）在这里**一律不下发**，
 * 直接回一句带替代车道的话（shared 的 computerUseIsolationErrors.noPointer）。
 * 让桥自己回不行——它会「成功」。
 *
 * 本文件不 import electron、不 import SDK：进程、文件、SDK 全部依赖注入，node --test 直接可跑。
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computerUseGuestCommands,
  computerUseIsolationErrors,
  isPixelInputCommand,
  parseComputerUseAdmission,
  type ComputerUseAdmission,
  type ComputerUseDelivery,
  type ComputerUseGuestCommand,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type ComputerUseUiaActResult,
  type ComputerUseUiaAction,
  type ComputerUseUiaListResult,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
  sessionDesktopKey,
  type GuestTcpChannel,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import {
  fetchGuestScreenshot,
  fetchGuestShot,
  fetchGuestUiaAct,
  fetchGuestUiaList,
  fetchGuestWindowList,
  fetchGuestWindowShot,
  GuestCommandRejected,
  pingGuest,
  resetGuestCommandSeq,
  sendGuestCommand,
  startGuestTcpProbe,
} from "./bridge-client.ts";
import { waitForBridgeInfo, type BridgeInfo } from "./bridge-ready.ts";
import type { SandboxCapabilities, SandboxProviderId } from "./provider.ts";
import type { GuestCommandReply, GuestShotReply, SandboxProcess } from "./sandbox.ts";
import { clampMaxWidth } from "./sandbox.ts";
import { cuTexts } from "./ui-language.ts";
import type { ComputerUseUiAction } from "../../shared/computer-use-texts.ts";

/** 桥 exe 的文件名（与 WSB 那条路同一个产物，宿主只按这个名字找） */
const GUEST_BRIDGE_EXE = "orbita-guest-bridge.exe";
/** 工作区里的落点名。**故意与桥自己的名字不同**：日志里一眼能分清「拷进来的那份」 */
const STAGED_EXE = "bridge.exe";
const LAUNCHER_NAME = "start-bridge.cmd";
const OUT_DIR_NAME = "out";
/**
 * 等桥通告的 deadline。isolation session 的 start 实测 1.4–1.9 秒，桥在会话里起来只要
 * ~1 秒——与 WSB 的 180 秒完全不是一个量级。但 provision 之后第一次 exec 有可能要等
 * 账号 profile 真正落地（实测偶发几秒），给 60 秒足够宽容，又不至于让「起不来」变成
 * 用户干等三分钟。
 */
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
/** 会话销毁之后账号 profile 被删的观察窗口（真机实测 deprovision 返回时就已经没了） */
const CLEANUP_VERIFY_MS = 5_000;
const CLEANUP_POLL_MS = 200;

/**
 * MXC SDK 的最小面。收窄成接口而不是直接 import `@microsoft/mxc-sdk`：
 *   1. 那个包要原生 FFI（koffi）+ Node ≥24.21，**import 的瞬间就会加载 DLL**；测试与非 Windows
 *      机器不该为此付出代价，生产在 index.ts 里懒加载。
 *   2. 状态机测试注入一个假 SDK 就够，不必真去建 OS 账号。
 * 生产适配器见 index.ts（`createMxcSdk()`）。
 */
export interface IsolationSessionSdk {
  /** 只读探测。不可用时 reason 必须是给用户看的人话 */
  probe(): IsolationSessionProbe | Promise<IsolationSessionProbe>;
  /** provision 一个新会话：OS 现造一个账号 + 一个宿主可写的工作区 */
  provision(): Promise<IsolationSessionProvision>;
  start(containerId: string): Promise<void>;
  /**
   * 在会话里起一个长驻进程。stdout/stderr 可能是 null（后端不暴露）——不读也不影响。
   * `workingDirectory` 必须是会话里真实存在的目录。
   */
  spawn(containerId: string, command: string, workingDirectory: string): Promise<SandboxProcess>;
  stop(containerId: string): Promise<void>;
  /** 释放会话（连带把 OS 账号与工作区删掉） */
  deprovision(containerId: string): Promise<void>;
}

export interface IsolationSessionProbe {
  available: boolean;
  reason: string | null;
  /** 运行时 Node 版本（显示用） */
  nodeVersion: string;
  nodeOk: boolean;
}

export interface IsolationSessionProvision {
  containerId: string;
  agentUserName: string;
  /** 宿主可写、会话内同路径可见的工作区（`ephemeralWorkspacePath`） */
  workspacePath: string;
}

export interface IsolationSessionDeps {
  /** 宿主侧的桥目录（内含 orbita-guest-bridge.exe）。开发 = 仓库 guest-bridge/bin */
  bridgeDir: string;
  sdk: IsolationSessionSdk;
  platform?: NodeJS.Platform;
  /**
   * `C:\Users` 这类账号根目录。清理验证用它判「agent 账号真的没了」。
   * 不传 = 只验工作区消失（测试默认走这条）。
   */
  usersRoot?: string;
  /** 默认 existsSync（测试注入假文件系统视图） */
  fileExists?: (path: string) => boolean;
  readyTimeoutMs?: number;
  bridgePollIntervalMs?: number;
  cleanupVerifyMs?: number;
  guestTimeoutMs?: number;
  /** 每条做准入判定的命令现读一次（与 WSB 那条路同源） */
  allowedApps?: () => readonly string[] | Promise<readonly string[]>;
  onStatus?: (status: SandboxStatus) => void;
  log?: (message: string) => void;
}

/** 我们起的那只桥进程（MxcProcess 结构上满足它；测试注入假的） */
export type BridgeProcess = SandboxProcess;

/**
 * 让路字段（与 sandbox.ts 同一条语义）：只有桥自己推迟过动作才有这两个字段。
 * 隔离档里像素命令根本不下发，所以这里恒为空——留着是为了两条控制器返回同一种载荷。
 */
function deferredOf(resp: Record<string, unknown>): { yielded?: boolean; waitedMs?: number } {
  if (resp.yielded !== true) return {};
  return { yielded: true, ...(typeof resp.waitedMs === "number" ? { waitedMs: resp.waitedMs } : {}) };
}

/**
 * 会话里起桥用的 launcher。**内容里的每个引号都是给 cmd 的文件解释器看的**，不是给 MXC 的
 * 命令行看的——MXC 只看到 `start-bridge.cmd` 这一个零引号 token。
 *
 * `mkdir out` 必须在前：`1> out\bridge.log` 在目录不存在时会直接失败，而桥还没来得及
 * 自己建它（失败现场是「什么都没有」，极难归因——真机踩过一次）。
 * `cd /d "%~dp0"` 让相对路径与 cwd 约定一致；`%~dp0` 自带结尾反斜杠。
 *
 * **`--loopback` 是安全约束，不是调优**：这个会话与宿主是同一个内核、同一套防火墙，
 * 桥的默认启动会关掉防火墙并对局域网开一个端口（那是给 Windows Sandbox 的一次性 VM 准备的，
 * 见 guest-bridge/TcpChannel.cs）。宿主与会话共享回环，所以只绑 127.0.0.1 就够。
 *
 * 失败模式（认了，不是隐患）：万一回环连不通（被系统的安全策略拦住 / 以后换了跨内核的后端），
 * 宿主侧的 bridge-client 会自己退回**映射目录的文件协议**（每条命令 3–7 秒）——变慢，不会坏，
 * 而且这里绝不会去碰用户的防火墙。所以不要为了「快一点」把这一行改回去。
 */
export function renderLauncherCmd(): string {
  return [
    "@echo off",
    'mkdir "%~dp0out" 2>nul',
    'cd /d "%~dp0"',
    `"%~dp0${STAGED_EXE}" --out-dir "%~dp0${OUT_DIR_NAME}" --loopback 1>"%~dp0${OUT_DIR_NAME}\\bridge.log" 2>&1`,
    "",
  ].join("\r\n");
}

/** 工作区里各落点（宿主与会话看到的是同一个绝对路径） */
export function workspaceLayout(workspacePath: string): {
  exe: string;
  launcher: string;
  outDir: string;
  bridgeInfo: string;
} {
  return {
    exe: join(workspacePath, STAGED_EXE),
    launcher: join(workspacePath, LAUNCHER_NAME),
    outDir: join(workspacePath, OUT_DIR_NAME),
    bridgeInfo: join(workspacePath, OUT_DIR_NAME, "bridge.json"),
  };
}

/**
 * L2b（MXC 独立会话）的能力声明 —— 全部取自 P2 真机验收的事实：
 *   - 有图形桌面（会话桌面），但**没有真实指针**：RDP 会话里 `SendInput` 返回成功而光标不动，
 *     所以 pixel 命令在这个控制器里一律不下发（见 start 附近的 noPointer 分支）；
 *   - UIA / 截图 / 窗口 / CDP 都走桥，和 L2 同一条车道；
 *   - 映射目录是**会话自己的工作区**（不是宿主的 out），所以浏览器上传/下载在这里做不到；
 *   - 每会话一个桌面（租约键带 sessionId）；同样不能快照；
 *   - 证据级别 `value`：E2 实测跨进程 UIA 树可用（Invoke / SetValue 都走通了），能读控件值。
 *     **没有真实指针不影响这一项**：像素命令在这里被拒（refused），根本到不了「要证据」那一步；
 *     读回能力讲的是 UIA，与指针是两件事。
 */
export const ISOLATION_SESSION_CAPABILITIES: SandboxCapabilities = {
  gui: true,
  realPointer: false,
  screenshot: true,
  windows: true,
  uia: true,
  evidence: "value",
  cdp: true,
  sandboxFiles: false,
  desktopScope: "per-session",
  snapshot: "none",
};

export class IsolationSessionController {
  readonly id: SandboxProviderId = "isolation-session";
  readonly capabilities: SandboxCapabilities = ISOLATION_SESSION_CAPABILITIES;
  private readonly deps: IsolationSessionDeps;
  private state: SandboxState = "off";
  private errorMessage: string | null = null;
  /** 每次新 start 递增；迟到的 SDK 回调不许改状态 */
  private generation = 0;
  private startedAt = 0;
  private bridgeVersion = "";
  private containerId: string | null = null;
  private agentUserName = "";
  private workspacePath: string | null = null;
  private bridgeProc: BridgeProcess | null = null;
  /** 桥通告的 TCP 通道（端口由桥自己分配并通告，宿主只读） */
  private tcp: GuestTcpChannel | null = null;

  constructor(deps: IsolationSessionDeps) {
    this.deps = deps;
  }

  private log(message: string): void {
    (this.deps.log ?? console.log)(`[computer-use/isolation] ${message}`);
  }

  private phase(): SandboxState {
    return this.state;
  }

  private transition(next: SandboxState): void {
    this.state = next;
    this.emit();
  }

  private emit(): void {
    this.deps.onStatus?.(this.status());
  }

  status(): SandboxStatus {
    switch (this.state) {
      case "off":
        return { state: "off" };
      case "starting":
        return { state: "starting", startedAt: this.startedAt };
      case "running":
        return {
          state: "running",
          startedAt: this.startedAt,
          bridgeVersion: this.bridgeVersion,
          backend: "isolation-session",
          ...(this.agentUserName === "" ? {} : { agentUserName: this.agentUserName }),
        };
      case "stopping":
        return { state: "stopping" };
      case "error":
        return { state: "error", message: this.errorMessage ?? cuTexts().startFailed, backend: "isolation-session" };
    }
  }

  /** 每会话一个桌面：租约键带 sessionId，两个会话各用各的、不互相排队 */
  desktopKey(sessionId: string): string {
    return sessionDesktopKey(sessionId);
  }

  /** 当前工作区（宿主侧 = 会话侧同一路径）。没在跑 / 已停时为 null */
  outDir(): string | null {
    return this.workspacePath === null ? null : workspaceLayout(this.workspacePath).outDir;
  }

  /** 只读探测（设置页与 start 的前置闸门共用同一份结论） */
  async probe(): Promise<IsolationSessionProbe> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== "win32") {
      return {
        available: false,
        reason: cuTexts().isolationWindowsOnly(platform),
        nodeVersion: process.versions.node,
        nodeOk: false,
      };
    }
    try {
      return await this.deps.sdk.probe();
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        available: false,
        reason: cuTexts().isolationProbeFailed(message),
        nodeVersion: process.versions.node,
        nodeOk: false,
      };
    }
  }

  async start(): Promise<ComputerUseStartResult> {
    if (this.state === "running") return { ok: true };
    if (this.state === "starting" || this.state === "stopping") {
      return { ok: false, error: cuTexts().isolationStartingOrStopping };
    }
    const platform = this.deps.platform ?? process.platform;
    if (platform !== "win32") {
      return { ok: false, error: cuTexts().isolationWindowsOnly(platform) };
    }

    const generation = ++this.generation;
    this.errorMessage = null;
    this.startedAt = Date.now();
    this.bridgeVersion = "";
    this.agentUserName = "";
    this.workspacePath = null;
    this.tcp = null;
    this.transition("starting");

    // 上一局的失败态可能留了容器（start 失败但 provision 成功）：先清掉再建，
    // 否则每重试一次就多一个 OS 账号。
    await this.releaseIfAny();

    const probe = await this.probe();
    if (!probe.available) {
      // 依赖不满足是**启动前**就该说清的事：不建会话、不留账号
      this.errorMessage = probe.reason ?? cuTexts().isolationUnavailable;
      if (generation === this.generation) this.transition("error");
      return { ok: false, error: this.errorMessage };
    }

    try {
      const provision = await this.deps.sdk.provision();
      if (generation !== this.generation) {
        // 已经被 stop 掉了：把它建出来的那个会话收掉，别留孤儿账号
        void this.release(generation, provision.containerId);
        return { ok: false, error: cuTexts().startCancelled };
      }
      this.containerId = provision.containerId;
      this.agentUserName = provision.agentUserName;
      this.workspacePath = provision.workspacePath;
      this.log(`已 provision：agent=${provision.agentUserName} 工作区=${provision.workspacePath}`);

      await this.deps.sdk.start(provision.containerId);
      if (generation !== this.generation) {
        await this.releaseIfAny();
        return { ok: false, error: cuTexts().startCancelled };
      }

      const layout = workspaceLayout(provision.workspacePath);
      await this.stageBridge(provision.workspacePath);
      // out 目录先建好：桥自己也会建，但 launcher 的 `1> out\bridge.log` 比它早一步
      await mkdir(layout.outDir, { recursive: true });

      const proc = await this.deps.sdk.spawn(provision.containerId, LAUNCHER_NAME, provision.workspacePath);
      this.bridgeProc = proc;
      this.log(`已在会话里起桥：启动器=${LAUNCHER_NAME}`);

      const info = await this.waitForBridge(layout.outDir, generation);
      if (info === null) {
        if (this.phase() === "error") return { ok: false, error: this.errorMessage ?? cuTexts().startFailed };
        if (generation !== this.generation) return { ok: false, error: cuTexts().startCancelled };
        this.fail(cuTexts().isolationBridgeNoAnnouncement);
        return { ok: false, error: this.errorMessage ?? cuTexts().startFailed };
      }
      this.tcp = info.tcp ?? null;
      if (this.tcp !== null) {
        // TCP 先连上（桥自己分配端口、通告在 bridge.json 里）：loopback 在宿主与会话之间是
        // 共享的（真机实测宿主直连会话里 Edge 的 CDP 端口全通），所以不需要穿透任何网络策略。
        await startGuestTcpProbe(layout.outDir);
        this.log(`桥通告 TCP 端口 ${this.tcp.port}（宿主直连会话 loopback）`);
      } else {
        // 没有 TCP 通告也照样能工作：文件协议在同一个工作区里（宿主可写、会话可读）。
        // 只是每条命令要多背一跳传播延迟，所以明说一句而不是静默降级。
        this.log("桥没有通告 TCP 端口，本次会话走文件协议（每条命令会更慢）");
      }

      // 通告 ≠ 能干活：ping 通才算 running（与 WSB 那条路同一条判据）
      try {
        await pingGuest(layout.outDir, this.deps.guestTimeoutMs ?? 20_000);
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.fail(cuTexts().isolationBridgePingFailed(message));
        return { ok: false, error: this.errorMessage ?? cuTexts().startFailed };
      }

      if (generation === this.generation && this.phase() === "starting") {
        this.bridgeVersion = info.version;
        this.transition("running");
        this.log(`已就绪：桥 ${info.version}，agent=${this.agentUserName}`);
      }
      return { ok: true };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (generation === this.generation) {
        this.fail(message);
      }
      return { ok: false, error: message };
    }
  }

  /**
   * 等桥通告。**超时的话术要是 L2b 自己的**：bridge-ready.ts 那段话在讲 WSB 的单实例竞争
   * （vmwp / WindowsSandboxRemoteSession），放到独立会话里指错了方向。这里换成「看 bridge.log
   * 的最后几行」——会话里的启动失败（launcher 写错、exe 被拦、账号 profile 没落地）都写在那里。
   */
  private async waitForBridge(outDir: string, generation: number): Promise<BridgeInfo | null> {
    const layout = workspaceLayout(this.workspacePath ?? "");
    try {
      return await waitForBridgeInfo(outDir, {
        timeoutMs: this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
        intervalMs: this.deps.bridgePollIntervalMs ?? POLL_INTERVAL_MS,
        isCancelled: () => generation !== this.generation || this.phase() !== "starting",
      });
    } catch (cause: unknown) {
      if (generation !== this.generation) return null;
      const tail = await this.bridgeLogTail(layout.outDir);
      const seconds = Math.round((this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000);
      throw new Error(
        cuTexts().bridgeWaitTimedOut(seconds) +
          cuTexts().isolationBridgeNotAnnounced(join(layout.outDir, "bridge.log"), tail),
      );
    }
  }

  /** 桥的重定向日志尾部（宿主与会话同路径）。读不到回 null */
  private async bridgeLogTail(outDir: string): Promise<string | null> {
    try {
      const raw = await readFile(join(outDir, "bridge.log"), "utf8");
      const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
      return lines.slice(-3).join(" / ");
    } catch {
      return null;
    }
  }

  /**
   * 把桥送进会话。两条文件：exe（280KB）与 launcher .cmd。
   * **写不进去就说清楚是权限**：工作区在别的用户 profile 下（`C:\Users\<agent>\Shared`），
   * 非管理员跑 Orbita 时会 EACCES/EPERM，而现场报错只是一个路径——用户看不出要提权。
   */
  private async stageBridge(workspacePath: string): Promise<void> {
    const layout = workspaceLayout(workspacePath);
    const source = join(this.deps.bridgeDir, GUEST_BRIDGE_EXE);
    const fileExists = this.deps.fileExists ?? existsSync;
    if (!fileExists(source)) {
      throw new Error(cuTexts().isolationBridgeExeMissing(source));
    }
    try {
      await mkdir(workspacePath, { recursive: true });
      await copyFile(source, layout.exe);
      await writeTextAtomic(layout.launcher, renderLauncherCmd());
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(cuTexts().isolationWorkspaceWriteFailed(workspacePath, message));
    }
  }

  private fail(message: string): void {
    this.errorMessage = message;
    if (this.state === "starting" || this.state === "running") this.transition("error");
    // 失败也要把会话收掉：留着的容器就是下一个「UI 说失败、账号还在」的现场。
    // 不 await：调用方（对话）不该为了清理多等几秒，回收是后台的。
    void this.releaseIfAny();
  }

  async stop(): Promise<ComputerUseStopResult> {
    if (this.state === "off") return { ok: true };
    const generation = ++this.generation;
    this.transition("stopping");
    const result = await this.release(generation, this.containerId);
    return result;
  }

  /**
   * 收尾：杀桥 → stop → deprovision → 验证账号/工作区真的没了。
   *
   * **验证不是形式**：`deprovision` 是唯一会删 OS 账号与工作区的调用，它失败了（或者被
   * 跳过）时如果 UI 报「已停止」，用户的机器上就悄悄多了一个登录账号 + 一份 profile。
   * 所以这里按观察窗口轮询，没消失就进 error 并写明残留路径。
   */
  private async release(generation: number, containerId: string | null): Promise<ComputerUseStopResult> {
    const proc = this.bridgeProc;
    this.bridgeProc = null;
    if (proc !== null) {
      try {
        proc.kill();
      } catch (cause: unknown) {
        this.log(`杀桥进程失败（会话销毁时它也会没）：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (containerId === null) {
      this.finishStopped(generation);
      return { ok: true };
    }

    let failure: string | null = null;
    try {
      await this.deps.sdk.stop(containerId);
    } catch (cause: unknown) {
      // stop 失败不挡住 deprovision：真正删账号的是后者，能删就别把会话留成半截
      failure = cuTexts().isolationStopSessionFailed(cause instanceof Error ? cause.message : String(cause));
    }
    try {
      await this.deps.sdk.deprovision(containerId);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failure = (failure === null ? "" : `${failure}；`) + cuTexts().isolationReleaseFailed(message);
    }

    const residual = await this.verifyCleaned();
    if (residual !== null) {
      failure = (failure === null ? "" : `${failure}；`) + residual;
    }
    if (failure !== null) {
      this.containerId = null;
      this.workspacePath = null;
      this.tcp = null;
      this.errorMessage = failure;
      if (generation === this.generation) this.transition("error");
      return { ok: false, error: failure };
    }
    this.finishStopped(generation);
    return { ok: true };
  }

  private finishStopped(generation: number): void {
    this.containerId = null;
    this.workspacePath = null;
    this.agentUserName = "";
    this.tcp = null;
    this.errorMessage = null;
    if (generation === this.generation) this.transition("off");
  }

  /**
   * 清理验证：工作区目录与 `C:\Users\<agent>` 都要消失。回 null = 干净，否则回一句人话。
   * 允许几秒观察窗口：OS 删 profile 是异步的（真机 deprovision 返回时通常已经没了）。
   */
  private async verifyCleaned(): Promise<string | null> {
    const fileExists = this.deps.fileExists ?? existsSync;
    const workspace = this.workspacePath;
    const usersRoot = this.deps.usersRoot;
    const agent = this.agentUserName;
    const profile = usersRoot !== undefined && agent !== "" ? join(usersRoot, agent) : null;
    const deadline = Date.now() + (this.deps.cleanupVerifyMs ?? CLEANUP_VERIFY_MS);
    const residue = (): string | null => {
      const left: string[] = [];
      if (workspace !== null && fileExists(workspace)) left.push(workspace);
      if (profile !== null && fileExists(profile)) left.push(profile);
      return left.length === 0 ? null : left.join("、");
    };
    for (;;) {
      const left = residue();
      if (left === null) return null;
      if (Date.now() >= deadline) {
        return cuTexts().isolationResidue(left);
      }
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_POLL_MS));
    }
  }

  /** 收掉当前可能存在的会话（重试启动 / 失败清理用）。幂等：没会话时直接过。 */
  private async releaseIfAny(): Promise<void> {
    const containerId = this.containerId;
    if (containerId === null) {
      this.bridgeProc = null;
      return;
    }
    const generation = this.generation;
    await this.release(generation, containerId);
  }

  // ── guest 车道（与 SandboxController 同名同语义）────────────────────

  private notRunning<T extends { ok: false; error: string }>(what: ComputerUseUiAction): T | null {
    if (this.state === "running") return null;
    const texts = cuTexts();
    const state = this.state;
    const error =
      state === "error"
        ? texts.isolationErrorState(this.errorMessage ?? texts.isolationUnknownReason)
        : texts.isolationNotRunning(what, state);
    return { ok: false, error } as T;
  }

  private requireOutDir(): string {
    const outDir = this.outDir();
    if (outDir === null) throw new Error(cuTexts().isolationNoWorkspace);
    return outDir;
  }

  private async allowedExe(): Promise<string[]> {
    const getter = this.deps.allowedApps;
    if (getter === undefined) return [];
    try {
      return [...(await getter())];
    } catch {
      return [];
    }
  }

  /**
   * 像素输入四命令在 L2b 里**不发**。判定放在最前面（连「有没有在跑」都排在它后面）：
   * 这条拒用的理由与运行状态无关，它由隔离档位本身决定，永远是同一句话。
   * 回 `delivery: "refused"` 而不是裸 error：确定没发出去，模型可以放心换车道。
   */
  async guestCommand(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandReply> {
    if (isPixelInputCommand(command)) {
      return { ok: false, error: computerUseIsolationErrors.noPointer, delivery: "refused" };
    }
    const gate = this.notRunning<{ ok: false; error: string }>("pixels");
    if (gate !== null) return gate;
    try {
      if (command === computerUseGuestCommands.click || command === computerUseGuestCommands.scroll) {
        fields["allowExe"] = await this.allowedExe();
      }
      const resp = await sendGuestCommand(this.requireOutDir(), command, fields, this.deps.guestTimeoutMs);
      const admission = parseComputerUseAdmission(resp);
      return {
        ok: true,
        resp,
        ...(admission === null ? {} : { admission }),
        ...deferredOf(resp),
      };
    } catch (cause: unknown) {
      return this.rejected(cause);
    }
  }

  /** CDP 命令（sandbox_* 工具组）：语义命令原样下发，回执载荷原样带回 */
  async guestCommandReply(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<GuestCommandReply> {
    const gate = this.notRunning<{ ok: false; error: string }>("browser");
    if (gate !== null) return gate;
    try {
      const resp = await sendGuestCommand(this.requireOutDir(), command, fields, this.deps.guestTimeoutMs);
      return { ok: true, resp };
    } catch (cause: unknown) {
      return this.rejected(cause);
    }
  }

  private rejected(cause: unknown): { ok: false; error: string; delivery?: ComputerUseDelivery } {
    const delivery = cause instanceof GuestCommandRejected ? cause.delivery : undefined;
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      ...(delivery === undefined ? {} : { delivery }),
    };
  }

  async guestShot(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestShotReply> {
    const gate = this.notRunning<{ ok: false; error: string }>("browser");
    if (gate !== null) return gate;
    try {
      const shot = await fetchGuestShot(this.requireOutDir(), command, fields, this.deps.guestTimeoutMs);
      return { ok: true, jpeg: shot.jpeg, resp: shot.resp };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
    const gate = this.notRunning<{ ok: false; error: string }>("screenshot");
    if (gate !== null) return gate;
    try {
      const shot = await fetchGuestScreenshot(this.requireOutDir(), clampMaxWidth(maxWidth), this.deps.guestTimeoutMs);
      return {
        ok: true,
        jpegBase64: Buffer.from(shot.jpeg).toString("base64"),
        width: shot.width,
        height: shot.height,
        nativeWidth: shot.nativeWidth,
        nativeHeight: shot.nativeHeight,
        takenAt: Date.now(),
        ...(shot.capture === undefined ? {} : { capture: shot.capture }),
      };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * 按窗口截图（PrintWindow）。**L2b 里这是最重要的截图车道之一**：桌面截图只有 640×480
   * 且没有 shell（会话是 RDP 形态、无 explorer），按窗口拍才能拍到应用真实内容。
   */
  async windowShot(options: {
    hwnd?: number;
    title?: string;
    maxWidth?: number;
  }): Promise<ComputerUseWindowShotResult> {
    const gate = this.notRunning<{ ok: false; error: string }>("windowShot");
    if (gate !== null) return gate;
    const fields: Record<string, unknown> = { maxWidth: clampMaxWidth(options.maxWidth) };
    if (options.hwnd !== undefined) fields["hwnd"] = options.hwnd;
    if (options.title !== undefined && options.title.trim() !== "") fields["title"] = options.title.trim();
    try {
      const shot = await fetchGuestWindowShot(this.requireOutDir(), fields, this.deps.guestTimeoutMs);
      return {
        ok: true,
        jpegBase64: Buffer.from(shot.jpeg).toString("base64"),
        width: shot.width,
        height: shot.height,
        nativeWidth: shot.nativeWidth,
        nativeHeight: shot.nativeHeight,
        hwnd: shot.hwnd,
        title: shot.title,
        restoredFromMinimized: shot.restoredFromMinimized,
        takenAt: Date.now(),
        ...(shot.capture === undefined ? {} : { capture: shot.capture }),
      };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async listWindows(timeoutMs?: number): Promise<ComputerUseWindowListResult> {
    const gate = this.notRunning<{ ok: false; error: string }>("windowList");
    if (gate !== null) return gate;
    try {
      const windows = await fetchGuestWindowList(this.requireOutDir(), timeoutMs);
      return { ok: true, windows };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** UIA 车道：L2b 里的主力（会话内跨进程 UIA 完整可用，真机 9 个后代 + Invoke/SetValue 都生效） */
  async uiaList(options: {
    hwnd?: number;
    title?: string;
    maxItems?: number;
    since?: number;
  }): Promise<ComputerUseUiaListResult> {
    const gate = this.notRunning<{ ok: false; error: string }>("uiaList");
    if (gate !== null) return gate;
    const fields: Record<string, unknown> = {};
    if (options.hwnd !== undefined) fields["hwnd"] = options.hwnd;
    if (options.title !== undefined && options.title.trim() !== "") fields["title"] = options.title.trim();
    if (options.maxItems !== undefined) fields["maxItems"] = options.maxItems;
    if (options.since !== undefined) fields["since"] = options.since;
    try {
      const reply = await fetchGuestUiaList(this.requireOutDir(), fields);
      return { ok: true, ...reply };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async uiaAct(options: {
    hwnd?: number;
    title?: string;
    ref?: string;
    name?: string;
    perform: ComputerUseUiaAction;
    value?: string;
    timeoutMs?: number;
  }): Promise<ComputerUseUiaActResult> {
    const gate = this.notRunning<{ ok: false; error: string }>("uiaAct");
    if (gate !== null) return gate;
    const fields: Record<string, unknown> = { action: options.perform };
    if (options.hwnd !== undefined) fields["hwnd"] = options.hwnd;
    if (options.title !== undefined && options.title.trim() !== "") fields["title"] = options.title.trim();
    if (options.ref !== undefined) fields["ref"] = options.ref;
    if (options.name !== undefined && options.name !== "") fields["name"] = options.name;
    if (options.value !== undefined) fields["value"] = options.value;
    if (options.timeoutMs !== undefined) fields["timeoutMs"] = options.timeoutMs;
    fields["allowExe"] = await this.allowedExe();
    try {
      const reply = await fetchGuestUiaAct(this.requireOutDir(), fields);
      return { ok: true, ...reply };
    } catch (cause: unknown) {
      return this.rejectedUiaAct(cause);
    }
  }

  /**
   * uia-act 的失败回执：桥回了 `ok:false` = 明确拒绝 → `refused`（与 WSB 后端同一句理由，
   * 见 sandbox.ts 的 rejectedUiaAct）；超时 / 响应畸形不带档位，那时不知道动作有没有落下。
   */
  private rejectedUiaAct(cause: unknown): { ok: false; error: string; delivery?: ComputerUseDelivery } {
    if (cause instanceof GuestCommandRejected) {
      return { ok: false, error: cause.message, delivery: cause.delivery ?? "refused" };
    }
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  /** 应用退出前的总清理：作废回执、杀桥、收会话。不广播（退出中没人听了）。 */
  async dispose(): Promise<void> {
    this.generation += 1;
    if (this.containerId !== null) {
      await this.release(this.generation, this.containerId);
    }
    this.state = "off";
    this.errorMessage = null;
    this.workspacePath = null;
    this.containerId = null;
    this.bridgeProc = null;
  }

  /** 给日志/测试看：会话里那个桥进程的 pid（MXC 的 isolation_session 后端不暴露宿主 PID，恒为 0） */
  bridgePid(): number {
    return this.bridgeProc?.pid ?? 0;
  }

  /** 桥通告的 TCP 端口（未通告 / 未运行 = null） */
  tcpPort(): number | null {
    return this.tcp?.port ?? null;
  }
}
