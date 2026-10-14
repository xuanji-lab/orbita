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
import { join, win32 } from "node:path";
import {
  BRIDGE_INFO_FILE,
  COMPUTER_USE_CMD_DIR,
  COMPUTER_USE_GUEST_BRIDGE_DIR,
  COMPUTER_USE_GUEST_OUT_DIR,
  computerUseGuestCommands,
  GUEST_COMMAND_TIMEOUT_MS,
  type ComputerUseGuestCommand,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { probe as probeCapability } from "./capability.ts";
import {
  fetchGuestScreenshot,
  pingGuest,
  resetGuestCommandSeq,
  sendGuestCommand,
} from "./bridge-client.ts";
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
 * 映射目录的末段名能不能放进 LogonCommand 里那条不加引号的 junction 命令。
 *
 * 为什么只能查末段名：MappedFolder 没有客机路径参数，映射目录只会落在沙箱桌面的
 * `<目录名>/` 下，所以**末段名**（basename）就是沙箱里那一段；宿主路径前面的空格 / 中文
 * 都不参与那条命令，不该被拦。末段名按 Windows 规则切（win32.basename）：这条名字要进
 * 沙箱内的 junction 命令，真机路径是 `C:\...`，posix basename 在 macOS/Linux 开发机上
 * 切不开它（测试也要在任何平台过）。
 *
 * 为什么不能带空格 / cmd 特殊字符：整条命令包在 `cmd.exe /c "…"` 里，路径再各自套一层
 * 引号会把自己绕死（cmd 的引号规则与 XML 转义叠加），所以 `mklink /J C:\orbita-bridge
 * C:\…\Desktop\my bridge` 会被 cmd 切成两个参数——junction 建不成，桥也就不存在。
 * 以前这条约束只活在注释里（2026-10-14 审查意见 F：让它可执行）。
 *
 * 返回人话错误（带上是哪个目录），没问题回 null。
 */
export function junctionPathIssue(bridgeDir: string, outputDir: string): string | null {
  const names = [win32.basename(bridgeDir), win32.basename(outputDir)];
  const bad = names.find((name) => /[\s&()^|<>%"]/.test(name));
  if (bad === undefined) return null;
  return (
    `映射目录的末段名不能带空格或 cmd 特殊字符：「${bad}」——.wsb 里的 junction 命令不加引号，` +
    "会被 cmd 切成两个参数。把 guest 桥 / 输出目录放到不含这些字符的路径下再启动。"
  );
}

/**
 * 渲染 .wsb。两个坑都处理在明面上：
 *  - XML 转义：宿主路径可含空格 / 中文 / &，全部过 escapeXml（含命令串里的 && → &amp;&amp;）；
 *  - 沙箱内路径：MappedFolder 没有客机路径参数，只会落在沙箱桌面 <目录名>/ 下。协议要求
 *    桥从固定路径 C:\orbita-bridge 跑，所以 LogonCommand 先用 junction（mklink /J，免提权）
 *    把桌面映射目录并到固定路径，再启动桥；&& 要 cmd 解释，整条命令包在 cmd.exe /c 里。
 *    （junction + LogonCommand + 桌面落点均已在 Windows 11 25H2 真机验证，2026-10-10。）
 *
 * Networking 用 Default（沙箱能上网）：官方 .wsb 文档只定义 Disable / Default 两个值，
 * Default 即启用。**这是有意放开的攻击面**——v1 的 computer use 就是「沙箱里的网页自动化」，
 * 断网等于没有这个功能；代价是沙箱内的进程（含 agent 打开的网页）能访问网络与宿主所在内网，
 * 别把沙箱当成「防网络的隔离层」。将来考虑加开关（禁出网 = 只做本地桌面自动化）。
 */
export function renderWsbXml(input: WsbRenderInput): string {
  // 末段名按 Windows 规则切（映射目录落在沙箱桌面 <目录名>/ 下，名字进 junction 命令）
  const bridgeOnDesktop = `${WSB_DESKTOP_USER}\\${win32.basename(input.bridgeDir)}`;
  const outOnDesktop = `${WSB_DESKTOP_USER}\\${win32.basename(input.outputDir)}`;
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
 *
 * pid / exitCode 是给「确认真的死了」用的（stop 的收尾链），**可选**：假进程可以不实现，
 * 那种情况下只剩 exit 事件一个信号源。
 */
export interface SandboxProcess {
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(): boolean;
  /** 进程 id（升级杀 `taskkill /PID <pid> /T /F` 要它） */
  readonly pid?: number;
  /** 退出码：null = 还在跑（Node 的 ChildProcess 语义）；没这个字段就只能靠 exit 事件判断 */
  readonly exitCode?: number | null;
}

/**
 * guest 命令下发的回执（controller 内部形状）。只有成/败：输入类命令的语义就是
 * 「事件已送出」，屏幕变成什么样要看下一张截图。**不进 shared/**：它不过进程边界，
 * 跨边界的那份是 shared/computer-use.ts 的 ComputerUseToolOutcome。
 */
export type GuestCommandResult = { ok: true } | { ok: false; error: string };

export interface SandboxDeps {
  /** userData/computer-use：session.wsb 与 out/（读写映射的宿主侧）都落这里 */
  computerUseDir: string;
  /** guest-bridge 目录（内含 orbita-guest-bridge.exe）。开发 = 仓库 guest-bridge/bin；打包 = resources/guest-bridge */
  bridgeDir: string;
  /** WindowsSandbox.exe 绝对路径（index.ts 用 capability.windowsSandboxExePath() 解出） */
  sandboxExePath: string;
  /** 默认 process.platform，测试可注入。非 win32 时 start() 直接拒——先报平台，再谈文件 */
  platform?: NodeJS.Platform;
  /** 真 spawn 在 index.ts 接线；测试注入假进程。**测试绝不许传真 spawn**（沙箱窗口是用户可见面） */
  spawnSandbox: (wsbPath: string) => SandboxProcess;
  /** 默认 existsSync */
  fileExists?: (path: string) => boolean;
  /** 等桥通告的 deadline，默认 180_000（冷启动实测 105s+）；测试传小值验超时路径 */
  readyTimeoutMs?: number;
  /** bridge.json 轮询间隔，默认 500ms；测试传小值 */
  bridgePollIntervalMs?: number;
  /** 截图 / 命令超时，默认 45_000（黑窗余量，见 bridge-client.ts 的 GUEST_COMMAND_TIMEOUT_MS） */
  guestTimeoutMs?: number;
  /** 状态机每次迁移的出口（index.ts 接 broadcastComputerUseStatus） */
  onStatus?: (status: SandboxStatus) => void;
  /** 默认 console.log */
  log?: (message: string) => void;
  /**
   * 升级杀：按 PID 再杀一次进程树。生产在 index.ts 接真 `taskkill /PID <pid> /T /F`
   * （沙箱是 launcher + WindowsSandboxClient 两棵树，单进程杀会留孤儿窗口与 ~2GB 的 VM）；
   * 不接就退回再调一次 child.kill()。**不许按镜像名杀**（仓规：禁 pkill/killall 式按名字匹配）。
   */
  killTreeByPid?: (pid: number) => void;
  /** kill 之后多久没确认退出就升级杀，默认 3_000；测试传小值 */
  killFallbackMs?: number;
  /** 升级之后再等多久仍不退出就收尾，默认 5_000；测试传小值 */
  killEscalationMs?: number;
}

/**
 * stop() 发起 kill 之后等多久还没确认退出就升级杀。
 * 2026-10-14 真机咬两次：原来的 3 秒兜底定时器直接宣布 off，而进程根本没死——UI 显示
 * 「未启动」，宿主却留着 ~2GB 的孤儿 VM（第二次得按 PID 手动清）。
 */
const STOP_FALLBACK_MS = 3_000;
/** 升级杀之后再等多久仍不退出就收尾（并留下「进程可能未退出」的痕迹） */
const STOP_ESCALATION_MS = 5_000;
/** 退出确认的轮询节奏：exit 事件是主路径，这个是兜底信号（二者取先到） */
const EXIT_POLL_INTERVAL_MS = 250;

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
  /** 升级杀之后的第二个窗口 */
  private escalationTimer: NodeJS.Timeout | null = null;
  /** 退出确认的轮询（exit 事件的兜底信号） */
  private exitWatchTimer: NodeJS.Timeout | null = null;

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
    // 平台不对时这是第一个该报的事：先报平台，再谈文件存在性——macOS/Linux 上报
    // 「先运行 bun run build:bridge」是误导（桥编不了，编了也没沙箱可跑）。
    // 文案与 probe 指引的平台那条一致（主进程文案 i18n 留给后续 PR）。
    if ((this.deps.platform ?? process.platform) !== "win32") {
      return { ok: false, error: "电脑使用沙箱目前只在 Windows 上可用。" };
    }
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
    // LogonCommand 里那条 junction 命令不加引号（理由见 junctionPathIssue）：末段名带空格 /
    // cmd 特殊字符的话它会被切坏——宁可不启动，也不落一份跑不起来的 .wsb
    const outputDir = join(this.deps.computerUseDir, "out");
    const junctionIssue = junctionPathIssue(this.deps.bridgeDir, outputDir);
    if (junctionIssue !== null) return { ok: false, error: junctionIssue };

    const generation = ++this.generation;
    // 新一局开始：上一局可能还有没走完的收尾链（兜底 / 升级窗口 / 退出轮询），先全清
    this.clearTimers();
    this.bridge = null;
    this.startedAt = Date.now();
    this.transition("starting");
    try {
      // .wsb 原子落盘（临时文件 + rename 的仓规同样管它）；读写映射的 out 目录顺手建好
      await mkdir(outputDir, { recursive: true });
      // 上一局残留的通告与命令文件必须先清掉，不然轮询会捡到上一局沙箱的死人文件；
      // 序号一并归零：guest 桥的快路径直探 cmd-000001.req.json，宿主接着上局的数字往下走
      // 会让它一直落空，只能等 4 秒一次的全量枚举（bridge-client.ts 的 resetGuestCommandSeq）
      await rm(join(outputDir, BRIDGE_INFO_FILE), { force: true });
      await rm(join(outputDir, COMPUTER_USE_CMD_DIR), { recursive: true, force: true });
      resetGuestCommandSeq();
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
    if (child === null) {
      this.transition("off");
      return { ok: true };
    }
    // 退出这件事从此刻起有两个信号源：exit 事件（快路径）与 exitCode 轮询（兜底），
    // 谁先到算谁的（重复到达幂等，onChildExit 自己会挡住）。
    // **宣布 off 必须有退出证据**：真机上 taskkill 可能没杀成 / 只杀掉 launcher，
    // 盲宣布 off 会留下 ~2GB 的孤儿 VM（2026-10-14 咬两次）。
    this.watchExit(child);
    try {
      child.kill();
    } catch {
      // 杀不掉不是失败：升级链会再试（下面）
    }
    this.stopFallbackTimer = setTimeout(
      () => this.onStopFallback(child),
      this.deps.killFallbackMs ?? STOP_FALLBACK_MS,
    );
    return { ok: true };
  }

  /** 手动「看一眼」：向 guest 桥要一张沙箱桌面截图（文件协议）。只在 running 可用。 */
  async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
    const gate = this.notRunning("截图");
    if (gate !== null) return gate;
    try {
      const shot = await fetchGuestScreenshot(
        this.outDir(),
        clampMaxWidth(maxWidth),
        this.deps.guestTimeoutMs ?? GUEST_COMMAND_TIMEOUT_MS,
      );
      return {
        ok: true,
        jpegBase64: Buffer.from(shot.jpeg).toString("base64"),
        width: shot.width,
        height: shot.height,
        nativeWidth: shot.nativeWidth,
        nativeHeight: shot.nativeHeight,
        takenAt: Date.now(),
      };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * agent 工具的通用命令下发（PR2 的 click / type / key / scroll 走它）。
   * 闸门与 screenshot 同一处：只有 running 才发得出去——没在跑时命令会石沉大海（上一局的
   * out/cmd 已被清空），等 45 秒超时再报错对模型毫无信息量。
   * 回执只有成/败：这些命令的语义就是「事件已送出」，屏幕变成什么样要看下一张截图。
   */
  async guestCommand(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<GuestCommandResult> {
    const gate = this.notRunning("沙箱操作");
    if (gate !== null) return gate;
    try {
      await sendGuestCommand(
        this.outDir(),
        command,
        fields,
        this.deps.guestTimeoutMs ?? GUEST_COMMAND_TIMEOUT_MS,
      );
      return { ok: true };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** 应用退出前的总清理：作废全部回调、杀沙箱。不广播（退出中没人听了）。 */
  dispose(): void {
    this.generation += 1;
    this.clearTimers();
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

  /** 读写映射的宿主侧输出目录（桥的 bridge.json 与 cmd/ 都在它下面） */
  private outDir(): string {
    return join(this.deps.computerUseDir, "out");
  }

  /**
   * 「沙箱没在跑」的闸门。两个调用方（renderer 的「看一眼」与 agent 的工具）拿的是
   * 同一句话，所以这句里必须带**下一步怎么办**：agent 自己启不了沙箱，它只能把这句
   * 转告用户；只回一句「沙箱没运行」它大概率会重试。
   */
  private notRunning(what: string): { ok: false; error: string } | null {
    if (this.state === "running" && this.bridge !== null) return null;
    return {
      ok: false,
      error: `沙箱没有在运行（当前状态：${this.state}），${what}不可用——先在「设置 › 实验功能 › 电脑使用」里启动沙箱`,
    };
  }

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
      // stopping = 我们 kill 的正常收尾（这里就是「确认退出」的那一下）；
      // running = 用户自己关了沙箱窗口
      this.clearTimers();
      this.cleanup();
      this.transition("off");
    }
    // error：failLocal 已经清理并宣布过，不重复
  }

  /**
   * 退出确认的轮询信号。真进程的 exit 事件是主路径（onChildExit），这里只是「二者取先到」
   * 里的另一条：假进程 / 事件丢了的极端情况，靠 exitCode 也能把状态推到 off。
   */
  private watchExit(child: SandboxProcess): void {
    this.clearExitWatch();
    this.exitWatchTimer = setInterval(() => {
      if (child.exitCode === undefined || child.exitCode === null) return; // 没这个字段 / 还在跑
      this.onChildExit(this.generation, child.exitCode);
    }, EXIT_POLL_INTERVAL_MS);
  }

  /**
   * 兜底窗口到点：还没确认退出就升级一次——**按 PID 杀进程树**（不按镜像名）。
   * 升级之后进第二个窗口，仍不退才收尾（onEscalationDeadline）。
   */
  private onStopFallback(child: SandboxProcess): void {
    this.stopFallbackTimer = null;
    if (this.child !== child) return; // 已经确认退出 / 换了一局
    const fallbackMs = this.deps.killFallbackMs ?? STOP_FALLBACK_MS;
    this.log(`沙箱进程（pid ${child.pid ?? "未知"}）${fallbackMs}ms 内没有退出，升级：按 PID 杀进程树`);
    this.escalateKill(child);
    this.escalationTimer = setTimeout(
      () => this.onEscalationDeadline(child),
      this.deps.killEscalationMs ?? STOP_ESCALATION_MS,
    );
  }

  /** 升级杀：有 pid 且有注入点就走 taskkill 进程树，否则退回再调一次 child.kill() */
  private escalateKill(child: SandboxProcess): void {
    const pid = child.pid;
    if (pid !== undefined && this.deps.killTreeByPid !== undefined) {
      this.deps.killTreeByPid(pid);
      return;
    }
    try {
      child.kill();
    } catch {
      // 失败留到 onEscalationDeadline 收尾（那里会留下痕迹，不静默）
    }
  }

  /**
   * 升级之后仍不退出：收尾为 off，但**留下痕迹**——孤儿 VM 会吃 ~2GB，
   * 静默变成「未启动」比报错更坑（用户看着干净，机器里留着两个进程）。
   */
  private onEscalationDeadline(child: SandboxProcess): void {
    this.escalationTimer = null;
    if (this.child !== child) return; // 第二个窗口里退出了 / 换了一局
    const pid = child.pid ?? "未知";
    this.log(
      `沙箱进程（pid ${pid}）在升级杀之后仍未退出——状态收尾为 off，但宿主里可能留着孤儿 VM：` +
        "任务管理器里若见 WindowsSandboxClient / WindowsSandbox 占着内存，按 PID 手动结束它",
    );
    this.child = null;
    this.cleanup();
    this.transition("off");
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
    this.clearTimers();
    this.bridge = null;
  }

  /** 三个定时器一起清：兜底 / 升级窗口 / 退出轮询 */
  private clearTimers(): void {
    this.clearStopFallback();
    this.clearExitWatch();
    if (this.escalationTimer !== null) {
      clearTimeout(this.escalationTimer);
      this.escalationTimer = null;
    }
  }

  private clearExitWatch(): void {
    if (this.exitWatchTimer !== null) {
      clearInterval(this.exitWatchTimer);
      this.exitWatchTimer = null;
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

function clampMaxWidth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1280;
  return Math.min(Math.max(Math.round(value), 320), 4096);
}
