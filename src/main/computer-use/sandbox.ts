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
import { join } from "node:path";
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
  fetchGuestShot,
  pingGuest,
  resetGuestCommandSeq,
  sendGuestCommand,
} from "./bridge-client.ts";
import { waitForBridgeInfo, type BridgeInfo } from "./bridge-ready.ts";
import { isRemoteSessionImage, type SandboxProcessInfo } from "./process-list.ts";

/** guest 桥 exe 的文件名（guest-bridge 子代理的产物，宿主只按这个名字找） */
const GUEST_BRIDGE_EXE = "orbita-guest-bridge.exe";
const WSB_FILE_NAME = "session.wsb";
/** 映射进沙箱桌面的打包产物目录名（.wsb 的 MappedFolder 落点见 GUEST_APP_SANDBOX_FOLDER） */
const GUEST_APP_DIR_NAME = "orbita-app";
/**
 * 等桥通告的 deadline：Windows 11 25H2 真机实测冷启动（含首次拉镜像）可达 105 秒以上，
 * 60 秒会在沙箱还没进桌面时就误报超时。热启动（镜像已缓存）通常在 20 秒内。
 */
const BRIDGE_READY_TIMEOUT_MS = 180_000;
/** bridge.json 轮询间隔（映射文件夹同步是即时的，这个间隔只是读盘节奏） */
const BRIDGE_POLL_INTERVAL_MS = 500;
/** 沙箱内的固定用户桌面（.wsb 的映射目录只会落在它下面，这是 WSB 的固定行为） */
const WSB_DESKTOP_USER = "C:\\Users\\WDAGUtilityAccount\\Desktop";
/**
 * 桥目录在沙箱里的落点（.wsb 的 <SandboxFolder>，写死绝对 guest 路径）。
 *
 * **必须显式写**：MappedFolder 没有 SandboxFolder 时，WSB 按**宿主目录名**派生落点
 * （`...\dist\win-unpacked` → `Desktop\win-unpacked`），与代码里的假设无关。
 * 2026-10-24 真机咬过：三条映射都缺 SandboxFolder，`launch` 去 Desktop\orbita-app
 * 找 exe 直接扑空，沙箱侧配置也可能异常导致 LogonCommand 不跑。
 */
const GUEST_BRIDGE_SANDBOX_FOLDER = `${WSB_DESKTOP_USER}\\bin`;
/** 输出目录在沙箱里的落点（同上：显式 SandboxFolder） */
const GUEST_OUT_SANDBOX_FOLDER = `${WSB_DESKTOP_USER}\\out`;
/**
 * 打包产物目录在沙箱里的落点（同上：显式 SandboxFolder）。
 * COMPUTER_USE_GUEST_APP_EXE 从它拼出来，两边只有一个来源。
 */
const GUEST_APP_SANDBOX_FOLDER = `${WSB_DESKTOP_USER}\\${GUEST_APP_DIR_NAME}`;
/**
 * 打包产物的入口 exe 在 guest 里的路径（冒烟脚本按它 launch）。
 * 与 .wsb 里那条 app 映射的 SandboxFolder 同一个常量来源——改名字时不会只改一半。
 */
export const COMPUTER_USE_GUEST_APP_EXE = `${GUEST_APP_SANDBOX_FOLDER}\\orbita.exe`;

// ── .wsb 生成 ──────────────────────────────────────────────────────────

export interface WsbRenderInput {
  /** 宿主的 guest-bridge 目录（内含 orbita-guest-bridge.exe），只读映射进沙箱 */
  bridgeDir: string;
  /** 宿主的输出目录，读写映射进沙箱（桥写 bridge.json / cmd 响应在这里，宿主轮询读） */
  outputDir: string;
  /**
   * 打包产物目录（`<repo>/dist/win-unpacked`，内含 orbita.exe），只读映射到沙箱
   * `C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app`。
   *
   * 只在**调用方确认它存在**时才传（sandbox.ts 的 start() 用 existsSync 判）：
   * 映射一个不存在的宿主目录会让整个 MappedFolder 失败、沙箱起不来——
   * 而没出包是开发时的常态，不该因此让人连「看一眼桌面」都用不了。
   * 真机验收步骤在 scripts/sandbox-ui-smoke.mjs 的头部注释里。
   */
  appDir?: string;
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
 * 渲染 .wsb。三个坑都处理在明面上：
 *  - XML 转义：宿主路径可含空格 / 中文 / &，全部过 escapeXml（含命令串里的 && → &amp;&amp;）；
 *  - 沙箱内落点：**每条映射都显式写 <SandboxFolder>**（绝对 guest 路径，写死在常量里）。
 *    不写的话 WSB 按**宿主目录名**派生落点（`...\dist\win-unpacked` → `Desktop\win-unpacked`），
 *    代码里假设的路径就全错（2026-10-24 真机：launch 扑空、桥可能压根没起）。
 *    显式写之后落点与宿主目录名无关，LogonCommand 里那条不加引号的 junction 也就不再
 *    受宿主末段名的空格 / cmd 特殊字符影响（原来的 junctionPathIssue 闸门因此删掉）。
 *  - 协议要求桥从固定路径 C:\orbita-bridge 跑，所以 LogonCommand 先用 junction（mklink /J，
 *    免提权）把 SandboxFolder 并到固定路径，再启动桥；&& 要 cmd 解释，整条命令包在
 *    cmd.exe /c 里。（junction + LogonCommand + 桌面落点均已在 Windows 11 25H2 真机验证，2026-10-10。）
 *
 * Networking 用 Default（沙箱能上网）：官方 .wsb 文档只定义 Disable / Default 两个值，
 * Default 即启用。**这是有意放开的攻击面**——v1 的 computer use 就是「沙箱里的网页自动化」，
 * 断网等于没有这个功能；代价是沙箱内的进程（含 agent 打开的网页）能访问网络与宿主所在内网，
 * 别把沙箱当成「防网络的隔离层」。将来考虑加开关（禁出网 = 只做本地桌面自动化）。
 *
 * appDir（PR5，打包产物冒烟）：多一条**只读**映射，把 `<repo>/dist/win-unpacked` 放到沙箱
 * 桌面的 orbita-app/ 下（SandboxFolder 与 COMPUTER_USE_GUEST_APP_EXE 同源）。
 * 为什么只读：沙箱里跑的是一份待验收的产物，它不该回写宿主的打包目录（产物是构建结果，
 * 被沙箱改过就没法判断「验的是不是同一份」）。
 * 为什么用桌面子目录而不是 junction：SandboxFolder 直接指定落点就够了，多建一条 junction
 * 只会再给 cmd 引号规则添一个坑。
 */
export function renderWsbXml(input: WsbRenderInput): string {
  // 映射落点全部走显式 <SandboxFolder>（不靠目录名派生）。junction 的目标同时也是
  // SandboxFolder——否则「映射落在哪」与「junction 指向哪」会各说一套。
  const bridgeOnDesktop = GUEST_BRIDGE_SANDBOX_FOLDER;
  const outOnDesktop = GUEST_OUT_SANDBOX_FOLDER;
  const appDir = input.appDir;
  const appMapping =
    appDir === undefined || appDir === ""
      ? ""
      : `\n    <MappedFolder>\n      <HostFolder>${escapeXml(appDir)}</HostFolder>\n      <SandboxFolder>${escapeXml(GUEST_APP_SANDBOX_FOLDER)}</SandboxFolder>\n      <ReadOnly>true</ReadOnly>\n    </MappedFolder>`;
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
      <SandboxFolder>${escapeXml(GUEST_BRIDGE_SANDBOX_FOLDER)}</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escapeXml(input.outputDir)}</HostFolder>
      <SandboxFolder>${escapeXml(GUEST_OUT_SANDBOX_FOLDER)}</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>${appMapping}
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

/**
 * 带**回执载荷**的 guest 命令结果（CDP 通道要读 resp 里的 port / running / text / elements）。
 * 与 GuestCommandResult 的区别只是多了 resp：像素命令的语义是「事件已送出」，没什么可读的。
 */
export type GuestCommandReply =
  | { ok: true; resp: Record<string, unknown> }
  | { ok: false; error: string };

/** 带 JPEG 兄弟文件的 guest 命令结果（cdp-shot 与像素截图共用） */
export type GuestShotReply =
  | { ok: true; jpeg: Uint8Array; resp: Record<string, unknown> }
  | { ok: false; error: string };

export interface SandboxDeps {
  /** userData/computer-use：session.wsb 与 out/（读写映射的宿主侧）都落这里 */
  computerUseDir: string;
  /** guest-bridge 目录（内含 orbita-guest-bridge.exe）。开发 = 仓库 guest-bridge/bin；打包 = resources/guest-bridge */
  bridgeDir: string;
  /** WindowsSandbox.exe 绝对路径（index.ts 用 capability.windowsSandboxExePath() 解出） */
  sandboxExePath: string;
  /**
   * 打包产物目录（`<repo>/dist/win-unpacked`）。**默认不传**：主进程的沙箱不需要它，
   * 只有 scripts/sandbox-ui-smoke.mjs（打包版 UI 冒烟）传——把待验收的产物只读映射进
   * 沙箱桌面的 orbita-app/。
   *
   * 不传 / 目录不存在时 .wsb 少一条映射，沙箱照常起（不能因为没出包就连「看一眼桌面」
   * 都用不了），但日志里会明说「没找到打包产物」。
   */
  appDir?: string;
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
  /**
   * 优雅关闭给多久：「关窗 + 替他按下确认框的 Ok」之后等这批 PID 自己消失。
   * 默认 25_000——真机实测从确认到 vmwp / vmmemWindowsSandbox 退出要 9~12 秒，
   * 留足确认框交互的余量；测试传小值。
   */
  gracefulCloseMs?: number;
  /**
   * 观测沙箱侧进程（镜像名 + PID），只读。
   *
   * 2026-10-23（Windows 更新后的新沙箱架构）实测：`WindowsSandbox.exe` 只是启动器——
   * 它把 VM 交给 WindowsSandboxServer 后 **0 秒就以 code 0 退出**，真正占内存的是
   * Server / RemoteSession / vmwp 三类进程。于是老办法（杀 launcher 的进程树）失效：
   * stop 时那个 child 早就没了。这里改成「启动前记基线、stop 时按新出现的进程收」，
   * 仍然**不按镜像名杀**——只碰我们自己启动后新出现的那些。
   * 带镜像名是为了挑出 RemoteSession 去**优雅关窗**（强杀它会从宿主泄漏 VM）。
   * 生产在 index.ts 用 tasklist 接；不接就只有旧架构的路径。
   */
  listSandboxProcesses?: () => SandboxProcessInfo[];
  /**
   * 关掉沙箱窗口：关窗 + 替用户按下沙箱自己的确认框（用 UI Automation 直接 Invoke Ok；
   * SendKeys 的 Enter 真机实测按不掉它）。光发 CloseMainWindow 会停在确认框上，没人按
   * 就等于没关，最后退回强杀而泄漏 VM。生产在 index.ts 跑 close-window-script.ts 生成的
   * 脚本。不发就只有强杀链——强杀会杀掉窗口进程却把 VM 留给宿主（2026-10-23 实测，各 ~3.5GB）。
   */
  closeSandboxWindow?: (pid: number) => void;
}

/**
 * stop() 发起 kill 之后等多久还没确认退出就升级杀。
 * 2026-10-14 真机咬两次：原来的 3 秒兜底定时器直接宣布 off，而进程根本没死——UI 显示
 * 「未启动」，宿主却留着 ~2GB 的孤儿 VM（第二次得按 PID 手动清）。
 */
const STOP_FALLBACK_MS = 3_000;
/** 升级杀之后再等多久仍不退出就收尾（并留下「进程可能未退出」的痕迹） */
const STOP_ESCALATION_MS = 5_000;
/**
 * 优雅关窗（关窗 + 替用户按确认框的 Ok）之后等多久：
 * 2026-10-23 真机实测，确认框按下之后 RemoteSession → Server → vmwp → vmmemWindowsSandbox
 * 全部退出要 9~12 秒；这里给到 25 秒——以前给 15 秒时，确认框没人按（弹出到被关掉的那段时间
 * 也算在内）会卡在窗口上直接超时，白等一轮才退回强杀。
 */
const STOP_GRACEFUL_MS = 25_000;
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
  /** start 前观测到的沙箱侧进程 PID（新架构下 stop 用它算「我们这只沙箱」） */
  private baselinePids: number[] = [];
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
    // 映射落点由 .wsb 的 <SandboxFolder> 写死，与宿主目录末段名无关——这里不再有
    // 「末段名带空格会切坏 junction」的闸门（路径不再进命令串）
    const outputDir = join(this.deps.computerUseDir, "out");

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
      // 打包产物映射（可选）：只有目录真的存在才写进 .wsb——映射一个不存在的宿主目录
      // 会让整个 MappedFolder 失败、沙箱根本起不来。缺产物时把下一步说清楚（写日志，
      // 因为沙箱本身没错，不该把它挡成启动失败）。
      const appDir = this.deps.appDir;
      const appMapped = appDir !== undefined && appDir !== "" && fileExists(appDir);
      if (appDir !== undefined && appDir !== "" && !appMapped) {
        this.log(
          `没有找到打包产物（${appDir}），本次沙箱不带 UI 冒烟映射——` +
            "要验打包版能否启动渲染，先在仓库根跑 bun run dist:win（出 dist/win-unpacked）再启动沙箱",
        );
      }
      await writeTextAtomic(
        wsbPath,
        renderWsbXml({ bridgeDir: this.deps.bridgeDir, outputDir, ...(appMapped ? { appDir } : {}) }),
      );
      if (appMapped) this.log(`打包产物已只读映射进沙箱：${appDir} → ${COMPUTER_USE_GUEST_APP_EXE}`);

      // 新架构：启动器 spawn 后很快 exit 0，沙箱活在 Server/RemoteSession/vmwp 里。
      // 基线要在 spawn **之前**记——spawn 之后它们就开始出现
      this.baselinePids = (this.deps.listSandboxProcesses?.() ?? []).map((process) => process.pid);
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
    const generation = this.generation;
    this.transition("stopping");
    this.cleanup();
    const child = this.child;
    if (child === null) {
      // 新架构（2026-10-23 Windows 更新后）：启动器在 starting 阶段就 exit 0 了，我们手上早就
      // 没有 child，可 VM 还在 WindowsSandboxServer / RemoteSession / vmwp 里跑。按「启动前
      // 基线 → 现在」的差集认我们自己那只，异步收尾（宣布 off 同样要有退出证据）。
      void this.stopOrphans(generation);
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

  /**
   * CDP 命令的通用下发（PR3 的 sandbox_* 工具组走它）。与 guestCommand 同一道闸门：
   * 只有 running 才发得出去。**回执载荷原样带回**（cdp 层自己读 port / running / text 等字段）。
   */
  async guestCommandReply(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<GuestCommandReply> {
    const gate = this.notRunning("沙箱里的浏览器操作");
    if (gate !== null) return gate;
    try {
      const resp = await sendGuestCommand(
        this.outDir(),
        command,
        fields,
        this.deps.guestTimeoutMs ?? GUEST_COMMAND_TIMEOUT_MS,
      );
      return { ok: true, resp };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * 带 JPEG 兄弟文件的 CDP 命令（cdp-shot）。与 screenshot 同一道闸门、同一套文件名闸门。
   */
  async guestShot(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<GuestShotReply> {
    const gate = this.notRunning("沙箱里的浏览器操作");
    if (gate !== null) return gate;
    try {
      const shot = await fetchGuestShot(
        this.outDir(),
        command,
        fields,
        this.deps.guestTimeoutMs ?? GUEST_COMMAND_TIMEOUT_MS,
      );
      return { ok: true, jpeg: shot.jpeg, resp: shot.resp };
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
    } else {
      // 新架构：启动器早退了，沙箱活在 Server / RemoteSession / vmwp 里。应用正在退，
      // 没人听推送也来不及轮询——把「关窗 + 按确认框 Ok」一次性发出去就完事：真机实测
      // 9~12 秒内整条链（RemoteSession → Server → vmwp → vmmem）自行退出，VM 内存随之释放。
      // **这里不能强杀**：taskkill /F 打掉 RemoteSession 会把 vmwp + 3.5GB 的 VM 留给宿主，
      // 泄漏攒多了会报「与该服务器建立的会话太多」，连新沙箱都起不来。
      if (!this.closeSandboxWindowGracefully()) this.killOrphans(this.newSandboxProcesses());
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
   * 新架构下属于我们这只沙箱的进程：**启动前基线之外**的那些。
   *
   * 为什么是差集而不是镜像名：仓规禁按进程名杀（同机可能有别人的沙箱 / 用户自己的 VM），
   * 差值把「我们 spawn 之后才出现」钉死在这一局的范围内。基线没记（没接
   * listSandboxProcesses）时它返回空——旧架构路径完全不受影响。
   */
  private newSandboxProcesses(): SandboxProcessInfo[] {
    const list = this.deps.listSandboxProcesses;
    if (list === undefined) return [];
    const baseline = new Set(this.baselinePids);
    const seen = new Set<number>();
    const fresh: SandboxProcessInfo[] = [];
    for (const process of list()) {
      if (baseline.has(process.pid) || seen.has(process.pid)) continue;
      seen.add(process.pid);
      fresh.push(process);
    }
    return fresh;
  }

  private newSandboxPids(): number[] {
    return this.newSandboxProcesses().map((process) => process.pid);
  }

  /**
   * 给这只沙箱的 RemoteSession 窗口发「关窗 + 按 Ok」那一个动作。
   * 返回 true = 真的发出去了（此时应等它自己退出，不要强杀）。
   *
   * 注意它不只是 WM_CLOSE：关窗会弹沙箱自己的确认框，确认框没人按就永远不关，
   * 所以 deps 实现里带着「激活 + 校验前台 PID + 发 Enter」（见 close-window-script.ts）。
   */
  private closeSandboxWindowGracefully(): boolean {
    const close = this.deps.closeSandboxWindow;
    if (close === undefined) return false;
    const window = this.newSandboxProcesses().find((process) => isRemoteSessionImage(process.image));
    if (window === undefined) return false;
    this.log(`关闭沙箱窗口（pid ${window.pid}，UIA 按下确认框的 Ok）：等它自己收 VM（强杀会把 VM 留给宿主）`);
    try {
      close(window.pid);
      return true;
    } catch {
      // 发不出去就退回强杀链：宁可退化成旧行为，也不能让「关闭」本身失效
      this.log(`关窗脚本没发出去（pid ${window.pid}），退回强杀`);
      return false;
    }
  }

  private killOrphans(processes: readonly SandboxProcessInfo[]): void {
    if (processes.length === 0) return;
    const killTreeByPid = this.deps.killTreeByPid;
    const pids = processes.map((process) => process.pid);
    if (killTreeByPid === undefined) {
      this.log(`宿主里还有沙箱进程 ${pids.join(", ")}，但没有接 killTreeByPid，杀不了——按 PID 手动结束它`);
      return;
    }
    this.log(`按基线差集终止沙箱进程：${pids.join(", ")}`);
    for (const pid of pids) killTreeByPid(pid);
  }

  /**
   * stop() 的新架构收尾链（child 已经为 null），三级：
   *   a. **优雅关窗**：关 RemoteSession 的窗口并按下确认框的 Ok，等整条链自己退（VM 关要 10s±）；
   *   b. 没等到 → 原有的强杀链（杀 → 等 → 升级再杀 → 再等）；
   *   c. 仍不消失 → 留痕后 off。
   *
   * 为什么先优雅：2026-10-23 真机验收发现，直接 taskkill 能杀掉 Server / RemoteSession，
   * **但 VM 不退**——vmwp.exe + vmmemWindowsSandbox（3.4GB）留了两分钟以上，
   * 而 vmwp 自己 taskkill 是拒绝访问。等于「关窗但泄漏 VM」。
   *
   * 与旧路径同一条纪律：**宣布 off 必须有退出证据**。
   */
  private async stopOrphans(generation: number): Promise<void> {
    const isCurrent = (): boolean => generation === this.generation && this.phase() === "stopping";
    let pids = this.newSandboxPids();
    if (pids.length === 0) {
      // 一只都没起来（或已经被系统回收）：没有要等的证据，直接收尾
      if (isCurrent()) this.transition("off");
      return;
    }
    if (this.closeSandboxWindowGracefully()) {
      const gracefulMs = this.deps.gracefulCloseMs ?? STOP_GRACEFUL_MS;
      if (await this.waitPidsGone(pids, gracefulMs, generation)) {
        if (isCurrent()) this.transition("off");
        return;
      }
      if (!isCurrent()) return;
      // 优雅关闭没生效（窗口卡住 / 用户拒绝 / 没接 closeSandboxWindow）：退回强杀链
      pids = this.newSandboxPids();
      if (pids.length === 0) {
        this.transition("off");
        return;
      }
      this.log(`优雅关闭 ${gracefulMs}ms 没等到沙箱退出（pid ${pids.join(", ")}），退回强杀`);
    }
    this.killOrphans(this.newSandboxProcesses());
    if (await this.waitPidsGone(pids, this.deps.killFallbackMs ?? STOP_FALLBACK_MS, generation)) {
      if (isCurrent()) this.transition("off");
      return;
    }
    if (!isCurrent()) return;
    // 升级：重新取一次差集——上一轮杀的过程中可能有新进程接上来（RemoteSession 会重起）
    pids = this.newSandboxPids();
    if (pids.length === 0) {
      this.transition("off");
      return;
    }
    this.log(`沙箱进程 ${pids.join(", ")} 没有退出，升级：再按 PID 杀一次进程树`);
    this.killOrphans(this.newSandboxProcesses());
    if (await this.waitPidsGone(pids, this.deps.killEscalationMs ?? STOP_ESCALATION_MS, generation)) {
      if (isCurrent()) this.transition("off");
      return;
    }
    if (!isCurrent()) return;
    this.log(
      `沙箱进程可能未退出：${pids.join(", ")}——状态收尾为 off，但宿主里可能留着孤儿 VM：` +
        "任务管理器里若见 WindowsSandboxRemoteSession / vmwp 占着内存，按 PID 手动结束它",
    );
    this.transition("off");
  }

  /** 等到这批 PID 全部消失（true）或窗口到点（false）；换了一局就立刻放弃 */
  private async waitPidsGone(pids: readonly number[], timeoutMs: number, generation: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const alive = (): number => {
      const current = new Set(this.newSandboxPids());
      return pids.reduce((count, pid) => (current.has(pid) ? count + 1 : count), 0);
    };
    for (;;) {
      if (alive() === 0) return true;
      if (Date.now() >= deadline || generation !== this.generation) return false;
      await sleep(Math.min(EXIT_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 1)));
    }
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
      // 2026-10-23 Windows 更新后的新沙箱架构（真机实测）：WindowsSandbox.exe 只是启动器，
      // 它把 VM 交给 WindowsSandboxServer 后 **0 秒就以 0 退出**，而 guest 桥那边还在正常
      // 启动（实测桥随后就通告就绪）。旧代码把「启动器退出」当成「窗口关了」，于是明明起
      // 得来的沙箱被判 error。所以 code 0 / null 只记一笔、继续等桥；非 0 才是真失败。
      if (code === 0 || code === null) {
        this.log(`沙箱启动器已退出（code ${code ?? "null"}）——新架构由 WindowsSandboxServer 接管，继续等 guest 桥就绪`);
        return;
      }
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
