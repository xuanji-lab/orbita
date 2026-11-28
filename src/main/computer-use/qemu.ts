/**
 * P3 的第三个后端：每会话一台真 Linux 桌面 VM（QEMU + WHPX），**agent 能通过工具操作它**。
 *
 * 与 Windows 桥（guest-bridge/，C#）不是同一套东西，也不该是：那边靠 UI Automation 读控件树、
 * 靠 SendInput 注入输入、靠 PrintWindow 截窗口；Linux guest 里这三个一个都没有对应物。
 * 这里只用 Linux 侧自带的原语，全部由 guest 里一个小 CGI 提供（scripts/p3-desktop/desk-cgi.sh）：
 *   screenshot  scrot 整屏 → PNG
 *   click/move/scroll/type/key  xdotool（X11 的 XTEST 注入）
 *   win-list    xdotool search + getwindowgeometry
 *   exec        guest 里的 shell（诊断与后续工具用；这一版没接成工具）
 * 传输是 HTTP over QEMU hostfwd（见 qemu-guest.ts 头注释里的取舍）。
 *
 * **能力降级必须是显式的**：L3 没有 UIA、没有 PrintWindow 的等价位、CDP 车道也没接。
 * 三条路径在这里就拒，并且**把替代路径写进同一句话**——模型看不见 UI，只回「不支持」
 * 它只会重试同一个动作。capabilities 声明与本文件里的实现同源（见每个字段的注释）。
 *
 * 粒度：**一台 VM 一块桌面**（desktopScope: "shared"）。per-session 的 VM 池要先用
 * 会话 id 分配实例，而当前启动入口（设置页的按钮）没有会话上下文——那是下一刀的事，
 * 现在按事实声明 shared，别把「计划里的形状」写进能力里。
 */
import {
  COMPUTER_USE_DEFAULT_ALLOW_NETWORK,
  COMPUTER_USE_DESKTOP_KEY,
  computerUseGuestCommands,
  sessionDesktopKey,
  type ComputerUseGuestCommand,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type ComputerUseUiaActResult,
  type ComputerUseUiaAction,
  type ComputerUseUiaListResult,
  type ComputerUseWindowInfo,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { cuTexts } from "./ui-language.ts";
import {
  sandboxNotRunningText,
  type SandboxCapabilities,
  type SandboxProvider,
  type SandboxProviderId,
} from "./provider.ts";
import { deskCommand, deskScreenshot, deskText, waitForDesk, waitForPaintedDesktop } from "./qemu-guest.ts";
import { VncPointer, type VncButton } from "./qemu-rfb.ts";
import {
  bootQemuVm,
  pickFreePorts,
  qemuVmPaths,
  stopQemuVm,
  vmAlive,
  type QemuVmHandle,
  type QemuVmPaths,
} from "./qemu-vm.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";

/**
 * QEMU 后端**现在**能做哪些事（只写实现里真的做到了的）。
 *
 *   gui / screenshot  guest 里是 XFCE 桌面，scrot 截整屏 → PNG；
 *   realPointer       有：XTEST 落到 Xvnc 的桌面上（点击、双击、打字、按键都验过）。
 *                     **快点击**（press/release 挨得极近）才留得住 GTK 的弹出菜单，
 *                     见 desk-cgi.sh 的 click 分支；
 *   windows           **没有**：能列窗口（win-list），但没有 PrintWindow 的对等物，
 *                     按窗口拍只能拍到「屏幕上那块像素」（被遮住时是遮挡者的样子）。
 *                     所以拒绝 windowShot，而不是给一张会骗人的图；
 *   uia               **没有**：Linux 侧是 AT-SPI，与 Windows UIA 不通用，本版没接；
 *   cdp               **没接**：guest 里有 chromium，但调试口与 sandbox_* 的接线还没做；
 *   sandboxFiles      没有：QEMU on Windows 没有 9p/virtfs，宿主目录映射不进来；
 *   desktopScope      shared：现在只有一台 VM、一块屏幕（VM 池是下一刀）；
 *   snapshot          none：qcow2 overlay 快照还没接（live savevm 在 WHPX 下不可用）；
 *   evidence          **none**：没有 UIA（读不到控件值），也没有按窗口截图（只有整屏像素）。
 *                     像素动作之后我们没有任何精确读回，`confirmed` / `suspected_noop`
 *                     在这里永远不可能为真——工具层据此降级成 unverifiable，并让模型点完
 *                     自己用 computer_screenshot 看一眼。**不要为了好看改成 window**：
 *                     声明得比实现高就是伪造证据。
 */
export const QEMU_CAPABILITIES: SandboxCapabilities = {
  gui: true,
  realPointer: true,
  screenshot: true,
  windows: false,
  uia: false,
  evidence: "none",
  cdp: false,
  sandboxFiles: false,
  desktopScope: "shared",
  snapshot: "none",
};

/**
 * 三条「这个后端做不到」的拒用文案。**每一条都必须给替代路径**：
 * 模型看不见界面也不知道后端差异，一句「不支持」只会让它原地重试。
 */
export const QEMU_REFUSALS = {
  // getter 而不是常量：这几句会进工具回执，要跟着界面语言走（2026-11-28）
  get uia(): string {
    return cuTexts().qemuRefuseUia;
  },
  get windowShot(): string {
    return cuTexts().qemuRefuseWindowShot;
  },
  get cdp(): string {
    return cuTexts().qemuRefuseCdp;
  },
};

/** 这条后端认的命令（其余一律明拒，并列出认的这几个） */
const SUPPORTED = ["click", "type", "key", "scroll"] as const;

/** 指针输入这一条（RFB）。测试里换成记录器，断言坐标与按钮 */
export interface PointerInput {
  click(x: number, y: number, options: { button?: VncButton; double?: boolean }): Promise<void>;
  scroll(x: number, y: number, notches: number): Promise<void>;
  close(): void;
}

/** 测试/宿主可以换掉的底层动作（生产用真实现；单测里换成假 VM、假指针与本地 HTTP 服务） */
export interface QemuSandboxHooks {
  paths?: QemuVmPaths;
  bootVm?: typeof bootQemuVm;
  stopVm?: typeof stopQemuVm;
  openPointer?: (port: number) => Promise<PointerInput>;
  /**
   * 设置 › 电脑使用 › 允许沙箱出网（每次 start 现读，缺省 = 允许，与
   * effectiveAllowNetwork 同缺省）。false 时 VM 的 `-netdev user` 带 restrict=on，
   * guest 出不了外网；桌面通道（hostfwd）不受影响。
   */
  allowNetwork?: () => boolean | Promise<boolean>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 契约里的按钮名 → RFB 的按钮名。不认识的按左键（与工具层的缺省一致） */
function normaliseButton(value: unknown): VncButton {
  return value === "right" || value === "middle" ? value : "left";
}

export class QemuSandboxProvider implements SandboxProvider {
  readonly id: SandboxProviderId = "qemu";
  readonly capabilities: SandboxCapabilities = QEMU_CAPABILITIES;

  readonly #hooks: QemuSandboxHooks;
  #state: SandboxStatus = { state: "off" };
  #vm: QemuVmHandle | null = null;
  /** guest 的屏幕尺寸（ping 报的 Xvnc 几何）。坐标换算与 maxWidth 都靠它 */
  #screen: { width: number; height: number } | null = null;
  #version = "p3-guestd";

  constructor(hooks: QemuSandboxHooks = {}) {
    this.#hooks = hooks;
  }

  status(): SandboxStatus {
    return this.#state;
  }

  /**
   * 起 VM 并等到桌面在。**失败要把 VM 收掉**：起了一半留下的进程既是资源泄漏，
   * 又会让下一次 start 撞端口。
   */
  async start(): Promise<ComputerUseStartResult> {
    if (this.#state.state === "running") return { ok: true };
    if (this.#state.state === "starting") return { ok: false, error: cuTexts().qemuStarting };
    const paths = this.#hooks.paths ?? qemuVmPaths();
    this.#state = { state: "starting", startedAt: Date.now(), backend: "qemu" };
    let vm: QemuVmHandle | null = null;
    try {
      const ports = await pickFreePorts();
      // 启动时读一次：VM 起好后再改设置不影响这只 VM（与 .wsb 的生效时机同一条纪律）。
      // 读失败按缺省（允许）——与 WSB 控制器那条「读超时按缺省」同一条纪律：
      // 一次读设置失败不该把启动卡死。
      let allowNetwork = COMPUTER_USE_DEFAULT_ALLOW_NETWORK;
      try {
        const wanted = await this.#hooks.allowNetwork?.();
        if (typeof wanted === "boolean") allowNetwork = wanted;
      } catch (cause: unknown) {
        console.warn(
          `[computer-use] 读不到出网开关，按缺省（允许）起 VM：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      vm = (this.#hooks.bootVm ?? bootQemuVm)({ paths, ports, allowNetwork });
      this.#vm = vm;
      // 用 handle 里的端口而不是刚才挑的那一对：以 VM 实际用的为准（测试里两者可以不同）
      const ready = await waitForDesk({ port: vm.ports.desk, token: vm.token }, { timeoutMs: 90_000 });
      this.#screen = { width: ready.width, height: ready.height };
      // 进程都在 ≠ 画面已画出来：会话刚起来的那 1–2 秒里 root 窗口还是一片纯色
      // （实测：纯色 PNG 4.8KiB，有壁纸/图标的桌面 100KiB+）。第一张图是模型唯一的
      // 参照物，它要是空白，模型会拿着一张空屏去「找图标」。所以这里等画出来再报 running。
      await waitForPaintedDesktop({ port: vm.ports.desk, token: vm.token });
      this.#version = ready.version ?? "p3-guestd";
      this.#state = {
        state: "running",
        startedAt: Date.now(),
        bridgeVersion: this.#version,
        backend: "qemu",
      };
      return { ok: true };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (vm !== null) await (this.#hooks.stopVm ?? stopQemuVm)(vm).catch(() => undefined);
      this.#vm = null;
      this.#screen = null;
      this.#state = { state: "error", message, backend: "qemu" };
      return { ok: false, error: message };
    }
  }

  async stop(): Promise<ComputerUseStopResult> {
    const vm = this.#vm;
    this.#vm = null;
    this.#screen = null;
    if (vm === null) {
      this.#state = { state: "off" };
      return { ok: true };
    }
    this.#state = { state: "stopping" };
    try {
      await (this.#hooks.stopVm ?? stopQemuVm)(vm);
      this.#state = { state: "off" };
      return { ok: true };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#state = { state: "error", message, backend: "qemu" };
      return { ok: false, error: cuTexts().qemuStopFailed(message) };
    }
  }

  desktopKey(sessionId: string): string {
    // 声明里是 shared（一台 VM 一块屏幕）：所有会话排队用同一块桌面。
    // 换成 VM 池时这里改成 sessionDesktopKey(sessionId)，与 capabilities 一起改。
    return this.capabilities.desktopScope === "shared" ? COMPUTER_USE_DESKTOP_KEY : sessionDesktopKey(sessionId);
  }

  async screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult> {
    const channel = this.#channel();
    if (channel === null) return { ok: false, error: sandboxNotRunningText() };
    try {
      const screen = this.#screen;
      // scrot 的缩放单位是百分比（会取整，1280 的 50% 是 640）。回图真实尺寸一律以
      // PNG 头为准（deskScreenshot 读 IHDR），所以取整不会让坐标换算错位。
      const thumbPercent =
        maxWidth !== undefined && screen !== null && maxWidth > 0 && maxWidth < screen.width
          ? Math.max(10, Math.round((maxWidth / screen.width) * 100))
          : undefined;
      const shot = await deskScreenshot(channel, { thumbPercent });
      const native = screen ?? { width: shot.width, height: shot.height };
      return {
        ok: true,
        jpegBase64: shot.png.toString("base64"),
        // PNG 不是 JPEG：回执必须说实话，工具层给模型的 mimeType 与设置页的 data URL 都取它
        mime: "image/png",
        width: shot.width,
        height: shot.height,
        nativeWidth: native.width,
        nativeHeight: native.height,
        takenAt: Date.now(),
      };
    } catch (cause: unknown) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** **明拒**：manifest 里 windows=false，理由见 QEMU_REFUSALS.windowShot */
  async windowShot(): Promise<ComputerUseWindowShotResult> {
    return { ok: false, error: QEMU_REFUSALS.windowShot };
  }

  /**
   * 列可见顶层窗口。它不是「按窗口截图」，所以在本后端的 windows=false 之下仍然有用：
   * 按标题拍失败时宿主会拿它列出候选，模型据此知道「桌面上现在有什么」。
   */
  async listWindows(timeoutMs = 5_000): Promise<ComputerUseWindowListResult> {
    const channel = this.#channel();
    if (channel === null) return { ok: false, error: sandboxNotRunningText() };
    const reply = await deskCommand(channel, { cmd: "winlist" }, timeoutMs);
    if (!reply.ok) return { ok: false, error: reply.error ?? cuTexts().qemuListFailed };
    const raw = reply.fields["windows"];
    if (!Array.isArray(raw)) return { ok: false, error: cuTexts().qemuWindowListShape };
    const windows: ComputerUseWindowInfo[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = finiteNumber(record["id"]);
      const title = typeof record["title"] === "string" ? record["title"] : "";
      if (id === undefined || title === "") continue;
      windows.push({
        hwnd: id,
        title,
        // 进程名要从 pid 反查 /proc/<pid>/comm；清单本身不带，先留空串（契约允许）
        process: "",
        className: "",
        x: finiteNumber(record["x"]) ?? 0,
        y: finiteNumber(record["y"]) ?? 0,
        w: finiteNumber(record["w"]) ?? 0,
        h: finiteNumber(record["h"]) ?? 0,
        minimized: false,
        visible: true,
      });
    }
    return { ok: true, windows };
  }

  async uiaList(): Promise<ComputerUseUiaListResult> {
    return { ok: false, error: QEMU_REFUSALS.uia };
  }

  async uiaAct(options: { perform: ComputerUseUiaAction }): Promise<ComputerUseUiaActResult> {
    void options;
    return { ok: false, error: QEMU_REFUSALS.uia };
  }

  async guestCommand(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandReply> {
    const reply = await this.guestCommandReply(command, fields);
    if (reply.ok) return { ok: true, resp: reply.resp };
    return reply;
  }

  /**
   * 像素命令 → guest 的 CGI 字段。**坐标是沙箱物理像素**（工具层已经按截图几何换算过），
   * 这里原样下发；L3 的 X 桌面就是那块屏幕，不需要再缩一次。
   */
  async guestCommandReply(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<GuestCommandReply> {
    const channel = this.#channel();
    if (channel === null) return { ok: false, error: sandboxNotRunningText() };

    switch (command) {
      case computerUseGuestCommands.click: {
        const x = finiteNumber(fields["x"]);
        const y = finiteNumber(fields["y"]);
        if (x === undefined || y === undefined) return { ok: false, error: cuTexts().qemuClickMissing };
        const button = normaliseButton(fields["button"]);
        try {
          const pointer = await this.#pointer();
          await pointer.click(Math.round(x), Math.round(y), { button, double: fields["double"] === true });
          return { ok: true, resp: { at: [x, y], button } };
        } catch (cause: unknown) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }
      case computerUseGuestCommands.type: {
        const text = typeof fields["text"] === "string" ? fields["text"] : "";
        if (text === "") return { ok: false, error: cuTexts().qemuTypeEmpty };
        const reply = await deskCommand(channel, { cmd: "type", b64: deskText(text) }, 60_000);
        return reply.ok ? { ok: true, resp: reply.fields } : { ok: false, error: reply.error ?? cuTexts().qemuTypeFailed };
      }
      case computerUseGuestCommands.key: {
        const key = typeof fields["key"] === "string" ? fields["key"] : "";
        if (key === "") return { ok: false, error: cuTexts().qemuKeyEmpty };
        const reply = await deskCommand(channel, { cmd: "key", b64: deskText(key) }, 20_000);
        return reply.ok ? { ok: true, resp: reply.fields } : { ok: false, error: reply.error ?? cuTexts().qemuKeyFailed };
      }
      case computerUseGuestCommands.scroll: {
        const x = finiteNumber(fields["x"]);
        const y = finiteNumber(fields["y"]);
        const deltaY = finiteNumber(fields["deltaY"]);
        if (x === undefined || y === undefined || deltaY === undefined) {
          return { ok: false, error: cuTexts().qemuScrollMissing };
        }
        try {
          const pointer = await this.#pointer();
          await pointer.scroll(Math.round(x), Math.round(y), Math.round(deltaY));
          return { ok: true, resp: { at: [x, y], deltaY } };
        } catch (cause: unknown) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }
      case computerUseGuestCommands.winList: {
        const list = await this.listWindows();
        if (!list.ok) return { ok: false, error: list.error };
        return { ok: true, resp: { windows: list.windows } };
      }
      default:
        return {
          ok: false,
          error: cuTexts().qemuUnknownCommand(command, SUPPORTED.join(" / ")),
        };
    }
  }

  /** CDP 车道（cdp-shot）专用；L3 没接 */
  async guestShot(command: ComputerUseGuestCommand): Promise<GuestShotReply> {
    void command;
    return { ok: false, error: QEMU_REFUSALS.cdp };
  }

  /**
   * 应用退出时收尾：VM 是我们自己 spawn 的 detached 进程，**必须**在这里停掉，
   * 否则退出 Orbita 之后它还占着内存与端口。pid 不是活的就不动它（可能已经崩了）。
   */
  async dispose(): Promise<void> {
    const vm = this.#vm;
    this.#vm = null;
    if (vm === null) return;
    if (!vmAlive(vm.pid)) {
      this.#state = { state: "off" };
      return;
    }
    await (this.#hooks.stopVm ?? stopQemuVm)(vm).catch(() => undefined);
    this.#state = { state: "off" };
  }

  /**
   * 指针连接（每次点击现开现关，见 qemu-rfb.ts 的说明）。这里也现开：
   * 一条常驻 RFB 会在 guest 的桌面重启后变成死管道，而那时点击会「成功」地打在空气上。
   */
  async #pointer(): Promise<PointerInput> {
    const vm = this.#vm;
    if (vm === null || this.#state.state !== "running") throw new Error(sandboxNotRunningText());
    return (this.#hooks.openPointer ?? VncPointer.connect)(vm.ports.rfb);
  }

  /** 现在这条通道（没在跑 = null） */
  #channel(): { port: number; token: string } | null {
    const vm = this.#vm;
    if (vm === null || this.#state.state !== "running") return null;
    return { port: vm.ports.desk, token: vm.token };
  }
}
