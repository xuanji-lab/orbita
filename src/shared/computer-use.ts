/**
 * computer use（Windows 沙箱隔离环境）契约 —— IPC 四层的第 1 层。
 *
 * 定位（2026-10 终审裁决）：v1 的 computer use = **Windows Sandbox 里的网页自动化**。
 * agent 的输入注入发生在沙箱会话内部（guest 桥），宿主完全不碰用户桌面的焦点与键鼠。
 * 隔离路线见调研文档 `computer-use-isolation.md`（Anthropic demo 的 Windows 同构：
 * .wsb + MappedFolder 挂 guest 桥 + LogonCommand 启动）。
 *
 * 宿主↔guest 协议 v1（宿主在 src/main/computer-use/ 实现，guest 桥是独立 exe，两边必须严格一致）：
 *   - 通道 = **映射文件夹里的文件对**，不走网络。反面教材：宿主防火墙把宿主↔沙箱的 TCP 当
 *     不可测（2026-10-10 真机：ICMP 通、TCP 被丢，且随每次启动时好时坏；guest 回连方向更是
 *     稳定被丢），加防火墙规则要提权弹窗，本地优先不接受。而 .wsb 读写映射文件夹双向实时同步、
 *     每次都可靠。
 *   - 命令：宿主写 out/cmd/<名字>.req.json（tmp+rename 原子写）→ 桥轮询执行 →
 *     写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件，先于 resp 落盘）→ 删 req；
 *     宿主读完响应后负责清理 resp / jpg。
 *   - 就绪：桥启动后写 out/bridge.json（tmp+rename）——它出现即代表命令循环已上线。
 *   - 隔离即鉴权：命令目录在宿主用户目录下、沙箱是会话级一次性环境，协议里不再要 token。
 *
 * PR1 范围 = 沙箱生命周期 + renderer 手动「看一眼」截图；pi 工具（agent 驱动）是 PR2/3。
 * preload / renderer 面随 renderer 刀接——契约在此定死，四层照 browser 域的模式铺。
 *
 * 调用方：
 *   renderer   → computerUseProbe / Start / Stop / Screenshot（renderer 发起、主进程执行）
 *   主进程     → computerUseStatus（状态机每次迁移推给 renderer，单向）
 *   agent 进程 → PR2/3 才经 request-broker 接进来，本文件先不定义那对通道
 */

export const computerUseChannels = {
  /** 能力探测（全部只读）：Windows 版本、沙箱功能状态、可执行文件在不在。不就绪时结果里给手动开启指引 */
  computerUseProbe: "computer-use:probe",
  /** 生成 .wsb 并启动沙箱；状态机 off→starting，bridge.json 就绪→running，超时→error */
  computerUseStart: "computer-use:start",
  /** 停止沙箱（杀掉我们 spawn 的 WindowsSandbox.exe，沙箱内全部状态丢弃）。幂等 */
  computerUseStop: "computer-use:stop",
  /** 对沙箱桌面截一张（guest 桥执行），maxWidth 控制回图宽度 */
  computerUseScreenshot: "computer-use:screenshot",
  /** 主进程 → renderer：沙箱状态机每次迁移推一次最新 SandboxStatus */
  computerUseStatus: "computer-use:status",
} as const;

export type ComputerUseChannel = (typeof computerUseChannels)[keyof typeof computerUseChannels];

// ── 协议常量（宿主与 guest 桥共用的数字/路径，改动即破坏两端）──────────────

/** guest 桥在沙箱内的落点（.wsb 用 junction 把映射目录并到这里，协议按这个路径执行） */
export const COMPUTER_USE_GUEST_BRIDGE_DIR = "C:\\orbita-bridge";
/** 输出目录在沙箱内的落点（读写映射：桥写在这里，沙箱销毁后宿主目录里仍在——产物回传通道） */
export const COMPUTER_USE_GUEST_OUT_DIR = "C:\\orbita-out";
/** 桥的地址通告文件名（落在 out 目录下；宿主轮询它等桥上线） */
export const BRIDGE_INFO_FILE = "bridge.json";
/** 命令目录名（out 目录下；宿主写 req、桥写 resp 的地方） */
export const COMPUTER_USE_CMD_DIR = "cmd";

// ── 沙箱状态机 ────────────────────────────────────────────────────────

export type SandboxState = "off" | "starting" | "running" | "stopping" | "error";

/**
 * 沙箱状态机的一帧。迁移：
 *   off → start() → starting → guest 桥 bridge.json 就绪 → running
 *                            ↘ 超时没等到通告 / spawn 失败 → error
 *   running → stop() / 用户关掉沙箱窗口 → (stopping) → off
 *   error → stop() 回 off，或直接 start() 重试。
 * 应用每次启动都从 off 开始（沙箱不跨应用存活），renderer 冷启动可直接按 off 画。
 */
export type SandboxStatus =
  | { state: "off" }
  | { state: "starting"; startedAt: number }
  | { state: "running"; startedAt: number; bridgeVersion: string }
  | { state: "stopping" }
  | { state: "error"; message: string };

// ── 能力探测（全部只读；绝不自动执行提权命令）────────────────────────────

/**
 * Windows 版本档位（reg query 的 EditionID 归一化）。沙箱只有 Pro / Enterprise / Education 有
 * （官方明确 Home 不支持）；未知归 unknown，按不支持处理并如实告诉用户。
 */
export type WindowsEdition = "pro" | "enterprise" | "education" | "home" | "unknown";

/** 「Windows 沙箱」可选功能的状态——由 WindowsSandbox.exe 存在性推导（非提权进程查不了 DISM，错误 740）；unknown 留作契约兼容，当前实现不产出 */
export type SandboxFeatureState = "enabled" | "disabled" | "unknown";

/** computerUseProbe 的结果。guidance 是给用户看的手动操作指引（弹窗文案），ready 时为 null */
export interface ComputerUseProbeResult {
  /** 是不是 Windows（非 Windows 平台一切免谈） */
  platformOk: boolean;
  edition: WindowsEdition;
  /** 版本档位支持沙箱（pro / enterprise / education） */
  editionOk: boolean;
  featureState: SandboxFeatureState;
  /** WindowsSandbox.exe 存在（System32 下） */
  sandboxExeFound: boolean;
  /** 四项全过。false 时看 guidance */
  ready: boolean;
  /** 不能就绪时的手动操作指引（含「启用或关闭 Windows 功能」路径与提权命令文本——只给文案，绝不代跑） */
  guidance: string | null;
}

// ── 四个 IPC 入口的载荷 ───────────────────────────────────────────────

export type ComputerUseStartResult = { ok: true } | { ok: false; error: string };

export type ComputerUseStopResult = { ok: true } | { ok: false; error: string };

/**
 * computerUseScreenshot 的回执：guest 桥按 maxWidth 缩放后的 JPEG + 原始桌面尺寸。
 * nativeWidth/Height 是**沙箱桌面**的原始像素（模型换算点击坐标要用它与回图的比值）；
 * takenAt 是宿主收到图的时刻（毫秒），renderer 可拿来判图的新旧。
 */
export type ComputerUseScreenshotResult =
  | { ok: true; jpegBase64: string; nativeWidth: number; nativeHeight: number; takenAt: number }
  | { ok: false; error: string };
