/**
 * Windows Sandbox 生命周期 —— PR1 computer use 的主进程核心。
 *
 * 启动链（Anthropic demo 的 Windows 同构）：生成一次性 token → 渲染 .wsb（原子写）
 * → 起宿主 HTTP 服务（绑沙箱 NAT 的 vEthernet IP，等 guest 桥回连）→ spawn
 * WindowsSandbox.exe → 等 guest 桥 register（60s 超时）→ running。
 * 停止 = 杀掉我们 spawn 的 WindowsSandbox.exe（沙箱内一切状态随实例销毁）。
 *
 * 状态机：off → starting →(register 成功)→ running →(stop / 用户关窗)→ off，
 * starting 阶段 60s 没等到 register / spawn 失败 → error（可 stop 回 off 或直接重试）。
 * 所有回调带 generation 校验——stop / dispose 之后，迟到的 register / exit 不许改状态
 * （ZCode 的 generation 防陈旧绑定，同款纪律）。
 *
 * 本文件不 import electron：进程、网卡、HTTP 服务全部依赖注入，node --test 直接可跑。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  COMPUTER_USE_GUEST_BRIDGE_DIR,
  COMPUTER_USE_GUEST_OUT_DIR,
  COMPUTER_USE_GUEST_PORT,
  COMPUTER_USE_HOST_PORT,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { probe as probeCapability } from "./capability.ts";
import { fetchGuestScreenshot, GUEST_SCREENSHOT_TIMEOUT_MS } from "./bridge-client.ts";
import {
  findHostBindIp,
  HostServer,
  type BindAddress,
  type GuestRegistration,
  type HostServerOptions,
  type ListInterfaces,
} from "./host-server.ts";

/** guest 桥 exe 的文件名（guest-bridge 子代理的产物，宿主只按这个名字找） */
const GUEST_BRIDGE_EXE = "orbita-guest-bridge.exe";
const WSB_FILE_NAME = "session.wsb";
/** register 等待线：沙箱冷启动秒级，但慢盘/杀软场景留足余量 */
const REGISTER_TIMEOUT_MS = 60_000;
/** 绑定轮询间隔：vEthernet (Windows Sandbox NAT) 网卡可能要等沙箱起来才出现 */
const BIND_RETRY_MS = 2_000;
/**
 * 绑定 deadline 比注册 deadline 提前量：让「没找到网卡」的原因性错误先于通用超时落地，
 * 用户看到的是真实原因（NAT 网络没就绪）而不是误导性的「没等到 guest 桥注册」
 */
const BIND_DEADLINE_MARGIN_MS = 500;
/** 沙箱内的固定用户桌面（.wsb 的映射目录只会落在它下面，这是 WSB 的固定行为） */
const WSB_DESKTOP_USER = "C:\\Users\\WDAGUtilityAccount\\Desktop";

// ── .wsb 生成 ──────────────────────────────────────────────────────────

export interface WsbRenderInput {
  /** 宿主的 guest-bridge 目录（内含 orbita-guest-bridge.exe），只读映射进沙箱 */
  bridgeDir: string;
  /** 宿主的输出目录，读写映射进沙箱（桥写在这里，沙箱销毁后宿主目录里仍在） */
  outputDir: string;
  hostPort: number;
  listenPort: number;
  token: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 渲染 .wsb。两个坑都处理在明面上：
 *  - XML 转义：宿主路径可含空格 / 中文 / &，全部过 escapeXml（含命令串里的 && → &amp;&amp;）；
 *  - 沙箱内路径：MappedFolder 没有客机路径参数，只会落在沙箱桌面 <目录名>/ 下。协议要求
 *    桥从固定路径 C:\orbita-bridge 跑，所以 LogonCommand 先用 junction（mklink /J，免提权）
 *    把桌面映射目录并到固定路径，再启动桥；&& 要 cmd 解释，整条命令包在 cmd.exe /c 里。
 *
 * Networking 用 Default：官方 .wsb 文档只定义 Disable / Default 两个值，Default 即启用。
 */
export function renderWsbXml(input: WsbRenderInput): string {
  const bridgeOnDesktop = `${WSB_DESKTOP_USER}\\${basename(input.bridgeDir)}`;
  const outOnDesktop = `${WSB_DESKTOP_USER}\\${basename(input.outputDir)}`;
  const guestCommand = [
    "cmd.exe /c \"",
    `mklink /J ${COMPUTER_USE_GUEST_BRIDGE_DIR} ${bridgeOnDesktop}`,
    "&&",
    `mklink /J ${COMPUTER_USE_GUEST_OUT_DIR} ${outOnDesktop}`,
    "&&",
    `${COMPUTER_USE_GUEST_BRIDGE_DIR}\\${GUEST_BRIDGE_EXE} --host-port ${input.hostPort} --listen-port ${input.listenPort} --token ${input.token}`,
    "\"",
  ].join(" ");
  return `<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <Networking>Default</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${escapeXml(input.bridgeDir)}</HostFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escapeXml(input.outputDir)}</HostFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>${escapeXml(guestCommand)}</Command>
  </LogonCommand>
</Configuration>
`;
}

// ── 控制器 ─────────────────────────────────────────────────────────────

/**
 * 我们 spawn 出来的沙箱进程的最小面。收窄成接口而不是直接用 ChildProcess：
 * 状态机测试注入一个只有 on/kill 的假进程就行，不用碰真的子进程类型。
 */
export interface SandboxProcess {
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(): boolean;
}

export interface SandboxDeps {
  /** userData/computer-use：session.wsb 与 out/（读写映射的宿主侧）都落这里 */
  computerUseDir: string;
  /** guest-bridge 目录（内含 orbita-guest-bridge.exe）。开发 = 仓库 guest-bridge/bin；打包 = resources/guest-bridge */
  bridgeDir: string;
  /** WindowsSandbox.exe 绝对路径（index.ts 用 capability.windowsSandboxExePath() 解出） */
  sandboxExePath: string;
  /** 真 spawn 在 index.ts 接线；测试注入假进程。**测试绝不许传真 spawn**（沙箱窗口是用户可见面） */
  spawnSandbox: (wsbPath: string) => SandboxProcess;
  /** 默认 existsSync */
  fileExists?: (path: string) => boolean;
  /** 默认 host-server 的 findHostBindIp；测试注入固定 127.0.0.1 */
  findBindIp?: () => BindAddress | null;
  /** 默认 new HostServer(...)；测试注入以便拿到实例地址、从测试回连 register */
  createServer?: (options: HostServerOptions) => HostServer;
  /** 默认 52740（测试传 0 拿临时端口） */
  hostPort?: number;
  /** 写进 .wsb 的 --listen-port，默认 52741 */
  guestPort?: number;
  /** 默认 60_000；测试传小值验超时路径 */
  registerTimeoutMs?: number;
  /** 截图超时，默认 15_000 */
  guestTimeoutMs?: number;
  /** 状态机每次迁移的出口（index.ts 接 broadcastComputerUseStatus） */
  onStatus?: (status: SandboxStatus) => void;
  /** 默认 console.log */
  log?: (message: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * stop() / dispose() 在启动中途取消时结算挂着的 start() 用的标记错误。
 * catch 靠它区分「用户取消」（回「已取消」）和「真失败」（原话带出真实原因）。
 */
class StartCancelledError extends Error {
  constructor() {
    super("启动在完成前被停止");
    this.name = "StartCancelledError";
  }
}

function clampMaxWidth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1280;
  return Math.min(Math.max(Math.round(value), 320), 4096);
}

export class SandboxController {
  private readonly deps: SandboxDeps;
  private state: SandboxState = "off";
  private errorMessage: string | null = null;
  /** 每次新 start 递增；迟到的回调对不上号就丢弃 */
  private generation = 0;
  private token: string | null = null;
  private guest: GuestRegistration | null = null;
  private startedAt = 0;
  private server: HostServer | null = null;
  private child: SandboxProcess | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private stopFallbackTimer: NodeJS.Timeout | null = null;
  private settleStart: { resolve: (registration: GuestRegistration) => void; reject: (error: Error) => void } | null =
    null;

  constructor(deps: SandboxDeps) {
    this.deps = deps;
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
          guestIp: this.guest?.ip ?? "",
          guestPort: this.guest?.port ?? 0,
        };
      case "stopping":
        return { state: "stopping" };
      case "error":
        return { state: "error", message: this.errorMessage ?? "未知错误" };
    }
  }

  /** 能力探测（全只读）。委托 capability.ts，这里只是门面。 */
  probe(): Promise<ComputerUseProbeResult> {
    return probeCapability();
  }

  async start(): Promise<ComputerUseStartResult> {
    if (this.state === "starting") return { ok: false, error: "沙箱已经在启动中" };
    if (this.state === "running") return { ok: false, error: "沙箱已经在运行" };
    if (this.state === "stopping") return { ok: false, error: "沙箱正在关闭，等它关完再启动" };
    // 廉价前置检查（两个文件存在性；reg query 那种秒级慢查询留给 probe，不拖在这里）
    const fileExists = this.deps.fileExists ?? existsSync;
    const bridgeExePath = join(this.deps.bridgeDir, GUEST_BRIDGE_EXE);
    if (!fileExists(bridgeExePath)) {
      return { ok: false, error: `guest 桥不存在（${bridgeExePath}）——先运行 bun run build:bridge 构建` };
    }
    if (!fileExists(this.deps.sandboxExePath)) {
      return {
        ok: false,
        error: `找不到 ${this.deps.sandboxExePath}——Windows 沙箱功能可能未启用，先「探测」看开启指引`,
      };
    }

    const generation = ++this.generation;
    this.token = randomBytes(32).toString("hex");
    this.guest = null;
    this.startedAt = Date.now();
    this.transition("starting");
    try {
      // .wsb 原子落盘（临时文件 + rename 的仓规同样管它）；读写映射的 out 目录顺手建好
      const outputDir = join(this.deps.computerUseDir, "out");
      await mkdir(outputDir, { recursive: true });
      const wsbPath = join(this.deps.computerUseDir, WSB_FILE_NAME);
      const hostPort = this.deps.hostPort ?? COMPUTER_USE_HOST_PORT;
      await writeTextAtomic(
        wsbPath,
        renderWsbXml({
          bridgeDir: this.deps.bridgeDir,
          outputDir,
          hostPort,
          listenPort: this.deps.guestPort ?? COMPUTER_USE_GUEST_PORT,
          token: this.token,
        }),
      );

      const server = (this.deps.createServer ?? ((options: HostServerOptions) => new HostServer(options)))({
        hostPort,
        token: this.token,
        onRegister: (registration) => this.onRegistered(generation, registration),
        log: (message) => this.log(message),
      });
      this.server = server;

      const registered = new Promise<GuestRegistration>((resolve, reject) => {
        this.settleStart = { resolve, reject };
      });
      // failLocal / stop 可能在 race 已被其它一方结算后才 reject 它——
      // 若绑定一直没成功（race 没来得及收养这个 promise），拒绝就成了 unhandled rejection，
      // 这里挂个空 catch 把它标记为已处理；正常路径的传递不受影响
      registered.catch(() => {});
      const child = this.deps.spawnSandbox(wsbPath);
      this.child = child;
      child.on("exit", (code) => this.onChildExit(generation, code));
      child.on("error", (cause) => this.onChildError(generation, cause));

      const timeoutMs = this.deps.registerTimeoutMs ?? REGISTER_TIMEOUT_MS;
      // 超时用「resolve(null) 的 sleep」而不是 reject：赛输的一方永远挂着不触发 unhandled rejection
      const timeout = new Promise<null>((resolve) => {
        this.deadlineTimer = setTimeout(() => resolve(null), timeoutMs);
      });
      const deadline = this.startedAt + timeoutMs;
      const winner = await Promise.race([this.bindServerWithRetry(generation, deadline).then(() => registered), timeout]);
      if (winner === null) {
        throw new Error("60 秒内没等到 guest 桥注册——沙箱可能还在启动，或 guest 桥启动失败");
      }
      // resolve 到这里之间 stop() 可能已经把状态改走；只有还停在 starting 才轮得到我们宣布 running。
      // 用 phase() 读真值：await 之后 this.state 的 TS 属性收窄已经不可信（transition 在方法里改的）
      if (generation === this.generation && this.phase() === "starting") {
        this.transition("running");
      }
      return { ok: true };
    } catch (cause: unknown) {
      if (cause instanceof StartCancelledError) {
        // stop() / dispose() 已把状态改走并接管清理
        return { ok: false, error: "启动已取消" };
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (generation === this.generation && this.phase() === "starting") {
        this.failLocal(message);
        return { ok: false, error: message };
      }
      // 真实原因已由 onChildExit / onChildError 路径的 failLocal 结算出来（状态已是 error），
      // 这里原话带出，不许吞成「已取消」
      return { ok: false, error: message };
    }
  }

  async stop(): Promise<ComputerUseStopResult> {
    if (this.state === "off" || this.state === "stopping") return { ok: true };
    if (this.state === "error") {
      // error 是可恢复态：清理干净回 off，让「停止」同时充当复位按钮
      this.cleanup();
      this.transition("off");
      return { ok: true };
    }
    this.transition("stopping");
    // 让还挂着的 start() 立刻返回「已取消」，不等 register 超时
    this.settleStart?.reject(new StartCancelledError());
    this.cleanup();
    const child = this.child;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 杀不掉就靠兜底定时器收尾（Windows 上 TerminateProcess 几乎不会失败）
      }
      this.stopFallbackTimer = setTimeout(() => {
        if (this.state !== "stopping") return;
        this.log("沙箱进程 3 秒内没有退出，直接收尾为 off");
        this.child = null;
        this.transition("off");
      }, 3_000);
    } else {
      this.transition("off");
    }
    return { ok: true };
  }

  /** 手动「看一眼」：向 guest 桥要一张沙箱桌面截图。只在 running 可用。 */
  async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
    if (this.state !== "running" || this.token === null || this.guest === null) {
      return { ok: false, error: "沙箱没有在运行，先启动沙箱再截图" };
    }
    try {
      const shot = await fetchGuestScreenshot(
        { ip: this.guest.ip, port: this.guest.port, token: this.token },
        clampMaxWidth(maxWidth),
        this.deps.guestTimeoutMs ?? GUEST_SCREENSHOT_TIMEOUT_MS,
      );
      return {
        ok: true,
        jpegBase64: Buffer.from(shot.jpeg).toString("base64"),
        nativeWidth: shot.nativeWidth,
        nativeHeight: shot.nativeHeight,
        takenAt: Date.now(),
      };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** 应用退出前的总清理：作废全部回调、关服务、杀沙箱。不广播（退出中没人听了）。 */
  dispose(): void {
    this.generation += 1;
    this.settleStart?.reject(new StartCancelledError());
    this.settleStart = null;
    this.clearDeadlineTimer();
    this.clearStopFallback();
    this.server?.close();
    this.server = null;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 应用都在退出了，没有更好的办法
      }
    }
    this.state = "off";
    this.token = null;
    this.guest = null;
  }

  // ── 内部 ──

  /**
   * 绑定宿主服务：找到 vEthernet 就绑；没有就按间隔重试到 deadline——
   * Windows Sandbox NAT 网卡可能要等沙箱起来才出现，不能只查一次就放弃。
   */
  private async bindServerWithRetry(generation: number, deadline: number): Promise<void> {
    const server = this.server;
    if (server === null) throw new Error("宿主 HTTP 服务没有建立");
    const findBindIp = this.deps.findBindIp ?? findHostBindIp;
    const bindDeadline = deadline - BIND_DEADLINE_MARGIN_MS;
    let lastProblem = "一直没找到 vEthernet 虚拟网卡（Windows Sandbox NAT）";
    for (;;) {
      if (generation !== this.generation || this.state !== "starting") throw new Error("已取消");
      const bind = findBindIp();
      if (bind === null) {
        lastProblem = "一直没找到 vEthernet 虚拟网卡（Windows Sandbox NAT）";
      } else {
        try {
          const hostPort = this.deps.hostPort ?? COMPUTER_USE_HOST_PORT;
          await server.listen(bind.ip);
          this.log(`宿主服务已监听 ${bind.ip}:${hostPort}（${bind.name}）`);
          return;
        } catch (cause: unknown) {
          lastProblem = `绑不上 ${bind.ip}：${cause instanceof Error ? cause.message : String(cause)}`;
        }
      }
      if (Date.now() >= bindDeadline) {
        throw new Error(`${lastProblem}——沙箱 NAT 网络没就绪，确认沙箱窗口已打开、功能已启用`);
      }
      await sleep(BIND_RETRY_MS);
    }
  }

  private onRegistered(generation: number, registration: GuestRegistration): void {
    if (generation !== this.generation || this.state !== "starting") return;
    this.guest = registration;
    const settle = this.settleStart;
    this.settleStart = null;
    settle?.resolve(registration);
  }

  private onChildExit(generation: number, code: number | null): void {
    if (generation !== this.generation) return;
    this.child = null;
    if (this.state === "starting") {
      this.failLocal(`沙箱窗口在 guest 桥注册前就关闭了（exit code ${code}）`);
      return;
    }
    if (this.state === "stopping" || this.state === "running") {
      // stopping = 我们 kill 的正常收尾；running = 用户自己关了沙箱窗口。
      // 两条路都要 cleanup：不然服务还挂在 vEthernet IP 上，下次 start 绑 52740 会撞死
      this.clearStopFallback();
      this.cleanup();
      this.transition("off");
    }
    // error：failLocal 已经清理并宣布过，不重复
  }

  private onChildError(generation: number, cause: Error): void {
    if (generation !== this.generation || this.state !== "starting") return;
    this.failLocal(`WindowsSandbox.exe 启动失败：${cause.message}`);
  }

  /** starting 阶段的失败收口：结算挂着的 start()、清理资源、杀进程、宣布 error。 */
  private failLocal(message: string): void {
    const settle = this.settleStart;
    this.settleStart = null;
    settle?.reject(new Error(message));
    this.clearDeadlineTimer();
    this.server?.close();
    this.server = null;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 同 stop()：留给兜底，不阻塞失败路径
      }
    }
    this.transition("error", message);
  }

  private cleanup(): void {
    this.clearDeadlineTimer();
    this.clearStopFallback();
    this.settleStart = null;
    this.server?.close();
    this.server = null;
    this.token = null;
    this.guest = null;
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private clearStopFallback(): void {
    if (this.stopFallbackTimer !== null) {
      clearTimeout(this.stopFallbackTimer);
      this.stopFallbackTimer = null;
    }
  }

  /** 读状态的真值（绕开 TS 对 this.state 的属性收窄——await 之后它可能是陈旧的） */
  private phase(): SandboxState {
    return this.state;
  }

  private transition(state: SandboxState, message?: string): void {
    this.state = state;
    this.errorMessage = message ?? null;
    this.log(`沙箱状态 → ${state}${message === undefined ? "" : `：${message}`}`);
    this.deps.onStatus?.(this.status());
  }

  private log(message: string): void {
    const log = this.deps.log;
    if (log !== undefined) log(message);
    else console.log(`[computer-use] ${message}`);
  }
}
