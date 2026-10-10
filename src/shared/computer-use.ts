/**
 * computer use（Windows 沙箱隔离环境）契约 —— IPC 四层的第 1 层。
 *
 * 定位（2026-10 终审裁决）：v1 的 computer use = **Windows Sandbox 里的网页自动化**。
 * agent 的输入注入发生在沙箱会话内部（guest 桥），宿主只发 HTTP，完全不碰用户桌面
 * 的焦点与键鼠。隔离路线与 guest 桥协议的完整论证见调研文档
 * `computer-use-isolation.md`（Anthropic demo 的 Windows 同构：.wsb + MappedFolder
 * 挂 guest 桥 + LogonCommand 启动 + NAT 直连）。
 *
 * 宿主↔guest 协议 v1（宿主在 src/main/computer-use/ 实现，guest 桥是独立 exe，两边必须严格一致）：
 *   - 宿主 HTTP 服务监听 52740，只绑 Windows Sandbox NAT 的 vEthernet 接口 IP（禁 0.0.0.0）；
 *   - token = 每次沙箱会话随机 32 字节 hex，写进 .wsb 的 LogonCommand 参数；
 *     双向所有请求都要求 `Authorization: Bearer <token>`，不对即 401；
 *   - guest 起来后 `POST http://<宿主vEthernet IP>:52740/register`，header 带 token，
 *     body `{ "port": <guest 监听端口> }` → 200 `{"ok":true}`；宿主从 socket remoteAddress 记下 guest IP；
 *   - 宿主随后调 guest：`GET http://<guestIP>:<port>/screenshot?maxWidth=1280`
 *     → `image/jpeg` + 响应头 `X-Native-Width` / `X-Native-Height`（原始桌面尺寸）。
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
  /** 生成 .wsb 并启动沙箱；状态机 off→starting，register 成功→running，60s 超时→error */
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

/** 宿主 HTTP 服务端口（guest 桥往这里 register） */
export const COMPUTER_USE_HOST_PORT = 52740;
/** guest 桥的默认监听端口（.wsb LogonCommand 里的 --listen-port；register 时 guest 会如实再报一次） */
export const COMPUTER_USE_GUEST_PORT = 52741;
/** guest 桥在沙箱内的落点（.wsb 用 junction 把映射目录并到这里，协议按这个路径执行） */
export const COMPUTER_USE_GUEST_BRIDGE_DIR = "C:\\orbita-bridge";
/** 输出目录在沙箱内的落点（读写映射：桥写在这里，沙箱销毁后宿主目录里仍在——产物回传通道） */
export const COMPUTER_USE_GUEST_OUT_DIR = "C:\\orbita-out";

// ── 沙箱状态机 ────────────────────────────────────────────────────────

export type SandboxState = "off" | "starting" | "running" | "stopping" | "error";

/**
 * 沙箱状态机的一帧。迁移：
 *   off → start() → starting → guest register 成功 → running
 *                            ↘ 60s 没等到 register / spawn 失败 → error
 *   running → stop() / 用户关掉沙箱窗口 → (stopping) → off
 *   error → stop() 回 off，或直接 start() 重试。
 * 应用每次启动都从 off 开始（沙箱不跨应用存活），renderer 冷启动可直接按 off 画。
 */
export type SandboxStatus =
  | { state: "off" }
  | { state: "starting"; startedAt: number }
  | { state: "running"; startedAt: number; guestIp: string; guestPort: number }
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
