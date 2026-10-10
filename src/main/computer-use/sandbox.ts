/**
 * Windows Sandbox 生命周期 —— PR1 computer use 的主进程核心。
 *
 * 启动链：渲染 .wsb（原子写）→ 清掉上一局的 bridge.json 与 cmd 目录 → spawn
 * WindowsSandbox.exe → 轮询 out/bridge.json 等桥自我通告（默认 180s，冷启动实测 105s+）
 * → running。停止 = 杀掉我们 spawn 的 WindowsSandbox.exe（沙箱内一切状态随实例销毁）。
 *
 * 通道是映射文件夹里的文件对，不是网络：宿主防火墙把宿主↔沙箱 TCP 当不可测
 * （2026-10-10 真机：ICMP 通、TCP 被丢且随启动时好时坏；guest 回连方向稳定被丢），
 * 调防火墙规则要提权弹窗。文件通道每次可靠（bridge-ready.ts 有完整论证）。
 *
 * 状态机：off → starting →(bridge.json 就绪)→ running →(stop / 用户关窗)→ off，
 * starting 阶段超时 / spawn 失败 / 沙箱窗被提前关掉 → error（可 stop 回 off 或直接重试）。
 * 所有回调带 generation 校验——stop / dispose 之后，迟到的 exit / 通告不许改状态
 * （ZCode 的 generation 防陈旧绑定，同款纪律）。
 *
 * 本文件不 import electron：进程、文件系统、轮询全部依赖注入，node --test 直接可跑。
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BRIDGE_INFO_FILE,
  COMPUTER_USE_CMD_DIR,
  COMPUTER_USE_GUEST_BRIDGE_DIR,
  COMPUTER_USE_GUEST_OUT_DIR,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { probe as probeCapability } from "./capability.ts";
import { fetchGuestScreenshot, pingGuest, GUEST_COMMAND_TIMEOUT_MS } from "./bridge-client.ts";
import { waitForBridgeInfo, type BridgeInfo } from "./bridge-ready.ts";

/** guest 桥 exe 的文件名（guest-bridge 子代理的产物，宿主只按这个名字找） */
const GUEST_BRIDGE_EXE = "orbita-guest-bridge.exe";
const WSB_FILE_NAME = "session.wsb";
/**
 * 等桥通告的 deadline：Windows 11 25H2 真机实测冷启动（含首次拉镜像）可达 105 秒以上，
 * 60 秒会在沙箱还没进桌面时就误报超时。热启动（镜像已缓存）通常在 20 秒内。
 */
const BRIDGE_READY_TIMEOUT_MS = 180_000;
/** bridge.json 轮询间隔（映射文件夹同步是即时的，这个间隔只是读盘节奏） */
const BRIDGE_POLL_INTERVAL_MS = 500;
/** 沙箱内的固定用户桌面（.wsb 的映射目录只会落在它下面，这是 WSB 的固定行为） */
const WSB_DESKTOP_USER = "C:\\Users\\WDAGUtilityAccount\\Desktop";

// ── .wsb 生成 ──────────────────────────────────────────────────────────

export interface WsbRenderInput {
  /** 宿主的 guest-bridge 目录（内含 orbita-guest-bridge.exe），只读映射进沙箱 */
  bridgeDir: string;
  /** 宿主的输出目录，读写映射进沙箱（桥写 bridge.json / cmd 响应在这里，宿主轮询读） */
  outputDir: string;
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
 *    （junction + LogonCommand + 桌面落点均已在 Windows 11 25H2 真机验证，2026-10-10。）
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
    // 桥的标准输出/错误重定向进 out 目录：桥的日志自动落在宿主侧，沙箱出问题不用猜
    `${COMPUTER_USE_GUEST_BRIDGE_DIR}\\${GUEST_BRIDGE_EXE} --out-dir ${COMPUTER_USE_GUEST_OUT_DIR} 1> ${COMPUTER_USE_GUEST_OUT_DIR}\\bridge.log 2>&1`,
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
  /** 等桥通告的 deadline，默认 180_000（冷启动实测 105s+）；测试传小值验超时路径 */
  readyTimeoutMs?: number;
  /** bridge.json 轮询间隔，默认 500ms；测试传小值 */
  bridgePollIntervalMs?: number;
  /** 截图超时，默认 15_000 */
  guestTimeoutMs?: number;
  /** 状态机每次迁移的出口（index.ts 接 broadcastComputerUseStatus） */
  onStatus?: (status: SandboxStatus) => void;
  /** 默认 console.log */
  log?: (message: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SandboxController {
  private readonly deps: SandboxDeps;
  private state: SandboxState = "off";
  private errorMessage: string | null = null;
  /** 每次新 start 递增；迟到的回调对不上号就丢弃 */
  private generation = 0;
  private bridge: BridgeInfo | null = null;
  private startedAt = 0;
  private child: SandboxProcess | null = null;
  private stopFallbackTimer: NodeJS.Timeout | null = null;

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
          bridgeVersion: this.bridge?.version ?? "",
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
        error: `找不到 ${this.deps.sandboxExePath}——Windows 沙箱功能可能未启用，先「检测能力」看开启指引`,
      };
    }

    const generation = ++this.generation;
    this.bridge = null;
    this.startedAt = Date.now();
    this.transition("starting");
    try {
      // .wsb 原子落盘（临时文件 + rename 的仓规同样管它）；读写映射的 out 目录顺手建好
      const outputDir = join(this.deps.computerUseDir, "out");
      await mkdir(outputDir, { recursive: true });
      // 上一局残留的通告与命令文件必须先清掉，不然轮询会捡到上一局沙箱的死人文件
      await rm(join(outputDir, BRIDGE_INFO_FILE), { force: true });
      await rm(join(outputDir, COMPUTER_USE_CMD_DIR), { recursive: true, force: true });
      const wsbPath = join(this.deps.computerUseDir, WSB_FILE_NAME);
      await writeTextAtomic(
        wsbPath,
        renderWsbXml({ bridgeDir: this.deps.bridgeDir, outputDir }),
      );

      const child = this.deps.spawnSandbox(wsbPath);
      this.child = child;
      child.on("exit", (code) => this.onChildExit(generation, code));
      child.on("error", (cause) => this.onChildError(generation, cause));

      const readyTimeoutMs = this.deps.readyTimeoutMs ?? BRIDGE_READY_TIMEOUT_MS;
      const deadline = this.startedAt + readyTimeoutMs;
      const remainingMs = (): number => Math.max(deadline - Date.now(), 1);
      const info = await waitForBridgeInfo(outputDir, {
        timeoutMs: readyTimeoutMs,
        intervalMs: this.deps.bridgePollIntervalMs ?? BRIDGE_POLL_INTERVAL_MS,
        isCancelled: () => generation !== this.generation || this.phase() !== "starting",
      });
      if (info === null) {
        // 被取消：stop()/dispose() 已接管清理；若其实是沙箱进程先死（failLocal 已结算
        // 真实原因进 error 态），把真实原因带出来，不许吞成「已取消」
        if (this.phase() === "error") return { ok: false, error: this.errorMessage ?? "启动失败" };
        return { ok: false, error: "启动已取消" };
      }
      // 通告 ≠ 能干活：映射文件夹 host→guest 方向开机后有 ~20 秒热身期（2026-10-10 实测），
      // 必须经命令通道 ping 通才算就绪。「running」的定义 = 桥真的能执行命令。
      // ping 用启动阶段的剩余预算（与等通告共享同一个 deadline）。
      const pinged = await this.pingWithCancel(outputDir, remainingMs(), generation);
      if (!pinged) {
        if (this.phase() === "error") return { ok: false, error: this.errorMessage ?? "启动失败" };
        return { ok: false, error: "启动已取消" };
      }
      this.bridge = info;
      // 等到之后 stop() 可能已经把状态改走；只有还停在 starting 才轮得到我们宣布 running
      if (generation === this.generation && this.phase() === "starting") {
        this.transition("running");
      }
      return { ok: true };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (generation === this.generation && this.phase() === "starting") {
        this.failLocal(message);
        return { ok: false, error: message };
      }
      // 真实原因已由 onChildExit / onChildError 路径的 failLocal 结算出来（状态已是 error），原话带出
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

  /** 手动「看一眼」：向 guest 桥要一张沙箱桌面截图（文件协议）。只在 running 可用。 */
  async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
    if (this.state !== "running" || this.bridge === null) {
      return { ok: false, error: "沙箱没有在运行，先启动沙箱再截图" };
    }
    try {
      const shot = await fetchGuestScreenshot(
        join(this.deps.computerUseDir, "out"),
        clampMaxWidth(maxWidth),
        this.deps.guestTimeoutMs ?? GUEST_COMMAND_TIMEOUT_MS,
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

  /** 应用退出前的总清理：作废全部回调、杀沙箱。不广播（退出中没人听了）。 */
  dispose(): void {
    this.generation += 1;
    this.clearStopFallback();
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
    this.bridge = null;
  }

  // ── 内部 ──

  /**
   * ping 握手包装：把「取消」与「真超时」分开——取消 resolve false（start 走取消结算），
   * ping 超时抛错（进 failLocal 宣布 error）。
   */
  private async pingWithCancel(outputDir: string, timeoutMs: number, generation: number): Promise<boolean> {
    // 三分支赛跑：ok=握手通 / fail=超时或错误响应（原话抛给 start 的 catch）/ wait=还没到点继续盯取消
    const pingPromise = pingGuest(outputDir, timeoutMs);
    for (;;) {
      const winner = await Promise.race([
        pingPromise.then(
          () => "ok" as const,
          () => "fail" as const,
        ),
        sleep(200).then(() => "wait" as const),
      ]);
      if (winner === "ok") return true;
      if (winner === "fail") await pingPromise; // 重新拿到真因抛出（这里必 rejected）
      if (generation !== this.generation || this.phase() !== "starting") return false;
    }
  }

  private onChildExit(generation: number, code: number | null): void {
    if (generation !== this.generation) return;
    this.child = null;
    if (this.state === "starting") {
      this.failLocal(`沙箱窗口在 guest 桥就绪前就关闭了（exit code ${code}）`);
      return;
    }
    if (this.state === "stopping" || this.state === "running") {
      // stopping = 我们 kill 的正常收尾；running = 用户自己关了沙箱窗口
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

  /** starting 阶段的失败收口：清理资源、杀进程、宣布 error（等桥的轮询靠 isCancelled 自行解开）。 */
  private failLocal(message: string): void {
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
    this.clearStopFallback();
    this.bridge = null;
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

function clampMaxWidth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1280;
  return Math.min(Math.max(Math.round(value), 320), 4096);
}
