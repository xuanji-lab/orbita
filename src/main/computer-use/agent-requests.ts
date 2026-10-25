/**
 * agent 的 computer use 工具请求（computerUseRequest）→ 沙箱 guest 桥 → 回执载荷。
 *
 * **沙箱与文件协议全在主进程**（SandboxController，browserRequest 同一条边界）：
 * agent 进程不碰沙箱、不碰 out/cmd，它那边只剩「工具定义 → requestId 问答」一层薄包装。
 * 沙箱是应用级一份（不按会话分）——多个会话同时使唤它时，事件按到达顺序注入，这正是
 * 「一个桌面」的语义。**浏览器车道不同**：sandbox_* 在 v1.5-1 起按会话各用一个 Edge 实例
 * （main/computer-use/cdp.ts），会话 id 在那里是路由键，不只是日志。宿主侧仍然按轮拿租约，
 * 本刀不动租约的资源切分。
 *
 * **坐标换算不在这里**：模型给的是它看到的那张截图的像素，换算在工具层做
 * （agent/computer-tools.ts 存下最近一次截图的几何），到这一层全是沙箱物理像素。
 * 这里只做三件事：动作 → guest 命令、回执 → 给模型的人话、「沙箱没在跑」→ 一句
 * 模型能转告用户的话（启沙箱是用户在设置页按的按钮，模型自己按不了）。
 *
 * 任何路径都必须回执：挂着不回的话 agent 进程里那次工具调用会一直等下去
 * （terminalRequest / readTaskRequest 同一条纪律）。
 */
import {
  computerUseGuestCommands,
  type ComputerUseGuestCommand,
  type ComputerUseScreenshotResult,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
  type ComputerUseUiaAction,
  type ComputerUseUiaActResult,
  type ComputerUseUiaListResult,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
} from "../../shared/computer-use.ts";
import type { GuestCommandResult } from "./sandbox.ts";

/**
 * 这一层真正要的那几个能力。**收窄成接口而不是直接吃 SandboxController**：
 * 回执组装是纯翻译，测试注入一个只有这几个方法的假沙箱就够，不必起状态机、
 * 不必碰文件协议（SandboxController 结构上满足它，生产环境直接传实例）。
 */
export interface ComputerUseGuest {
  screenshot(maxWidth?: number): Promise<ComputerUseScreenshotResult>;
  guestCommand(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandResult>;
  /**
   * 按**窗口**截图（桥 0.9.0 的 win-shot）。hwnd 优先，否则 title 不区分大小写包含匹配。
   * 失败时 error 是桥给出的人话（「这个窗口拍不到…——改用整桌面截图或 computer_screenshot」），
   * 这一层**只追加候选窗口清单**，不改写那句话。
   */
  windowShot(options: {
    hwnd?: number;
    title?: string;
    maxWidth?: number;
  }): Promise<ComputerUseWindowShotResult>;
  /** 可截图的顶层窗口列表（win-list）。按标题拍失败时用它把候选窗口告诉模型 */
  listWindows(timeoutMs?: number): Promise<ComputerUseWindowListResult>;
  /**
   * 列出一个窗口里可动作的控件（桥 0.10.0 的 uia-list）。只读、不抢焦点。
   * 失败时 error 是桥的人话（「没找到标题包含…的窗口」/「目标窗口没有响应（UIA 调用超时…）」），
   * 这一层**不改写**。
   */
  uiaList(options: {
    hwnd?: number;
    title?: string;
    maxItems?: number;
  }): Promise<ComputerUseUiaListResult>;
  /** 对控件执行 UIA 模式（桥 0.10.0 的 uia-act）。不抢前台，所以不占桌面租约 */
  uiaAct(options: {
    hwnd?: number;
    title?: string;
    ref?: number;
    name?: string;
    perform: ComputerUseUiaAction;
    value?: string;
    timeoutMs?: number;
  }): Promise<ComputerUseUiaActResult>;
}

/**
 * 按标题拍失败后列候选窗口的预算。不能吃默认的 45s：那条路刚白等过一次（可能已经超时），
 * 再用一整条命令预算去列清单，agent 那边的 broker（60s）会先放弃——模型只看到「主进程没有回执」，
 * 而候选人话里其实已经有「该传 hwnd 还是换标题」的答案。TCP 通道下这条命令是毫秒级。
 */
const WINDOW_LIST_TIMEOUT_MS = 5_000;

export async function applyComputerUseRequest(
  controller: ComputerUseGuest,
  /**
   * 只用于日志与观测，**不改变任何命令的语义**：沙箱里就一个桌面，同一条 click 无论在谁的
   * 轮次里都只做一件事——「一个会话同一时间用沙箱」由 computer-use/lease.ts 保证（index.ts
   * 先 acquire 再调到这里），不在这一层。带上它是因为真机排查要回答「这一下到底是谁发的」：
   * 租约挡住的是并发，日志回答的是事后归因。
   */
  sessionId: string,
  request: ComputerUseToolRequest,
): Promise<ComputerUseToolOutcome> {
  console.log(`[computer-use] ${sessionId} → ${request.action}`);
  try {
    switch (request.action) {
      case "screenshot": {
        // screenshot + window = 按窗口截图（桥 0.9.0）。它不占桌面租约（理由见
        // shared/computer-use.ts 的 isWindowScreenshotRequest），回执的几何是**窗口**的像素
        if (request.window !== undefined) return await windowShot(controller, request.window, request.maxWidth);
        const shot = await controller.screenshot(request.maxWidth);
        if (!shot.ok) return { ok: false, error: shot.error };
        return {
          ok: true,
          text:
            `Screenshot of the sandbox desktop: the image is ${shot.width}×${shot.height}, the physical screen is ` +
            `${shot.nativeWidth}×${shot.nativeHeight}. Coordinates you pass to computer_click / computer_scroll are ` +
            "pixels of this image. Take a fresh screenshot after every action to see what changed.",
          shot: {
            width: shot.width,
            height: shot.height,
            nativeWidth: shot.nativeWidth,
            nativeHeight: shot.nativeHeight,
            data: shot.jpegBase64,
          },
        };
      }
      case "click": {
        const button = request.button ?? "left";
        const outcome = await controller.guestCommand(computerUseGuestCommands.click, {
          x: request.x,
          y: request.y,
          button,
          double: request.double === true,
        });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        const kind = `${request.double === true ? "double " : ""}${button} click`;
        return {
          ok: true,
          text:
            `Sent a ${kind} at (${request.x}, ${request.y}) on the sandbox desktop. It has been delivered — ` +
            "take a screenshot to see what it did.",
        };
      }
      case "type": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.type, { text: request.text });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text:
            `Typed ${request.text.length} characters into the focused window on the sandbox desktop. ` +
            "Take a screenshot to confirm they landed where you meant.",
        };
      }
      case "key": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.key, { key: request.key });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text: `Pressed ${request.key} on the sandbox desktop. Take a screenshot to confirm.`,
        };
      }
      case "scroll": {
        const outcome = await controller.guestCommand(computerUseGuestCommands.scroll, {
          x: request.x,
          y: request.y,
          deltaY: request.deltaY,
        });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return {
          ok: true,
          text:
            `Scrolled by ${request.deltaY} wheel notch(es) at (${request.x}, ${request.y}) on the sandbox desktop ` +
            "(positive = down). Take a screenshot to see the new position.",
        };
      }
      // ── UIA 车道（桥 0.10.0）：按控件动作，不按坐标、不抢前台 ─────────────
      case "uia-list": {
        const size = request.maxItems === undefined ? {} : { maxItems: request.maxItems };
        const reply = await controller.uiaList({ ...targetOf(request.window), ...size });
        if (!reply.ok) return { ok: false, error: reply.error };
        return { ok: true, text: uiaListText(reply) };
      }
      case "uia-act": {
        const reply = await controller.uiaAct({
          ...targetOf(request.window),
          ...(request.ref === undefined ? {} : { ref: request.ref }),
          ...(request.name === undefined ? {} : { name: request.name }),
          perform: request.perform,
          ...(request.value === undefined ? {} : { value: request.value }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
        if (!reply.ok) return { ok: false, error: reply.error };
        return { ok: true, text: uiaActText(reply) };
      }
      // sandbox_* 动作走 CDP 通道（main/computer-use/cdp.ts），不经过这一层：
      // 它们要一条常驻的 CdpSession（socket / 标签页 / 自动起 Edge），而这里只认沙箱状态机。
      // index.ts 按 isSandboxBrowserAction 分流；走到这里说明分流漏了，宁可报错也不要静默。
      default:
        return {
          ok: false,
          error: `内部错误：${request.action} 应该走 CDP 通道（sandbox_*），不该进像素命令这一层。`,
        };
    }
  } catch (cause: unknown) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 按窗口截图的回执组装（screenshot + window）。
 *
 * 两件额外的事：
 *   ① 失败时**只追加**候选窗口清单，不改写桥那句「这个窗口拍不到（…）——改用整桌面截图或
 *      computer_screenshot」——那是模型唯一的换路指示；
 *   ② 成功时明说「这张图的坐标**不能**用于 computer_click」：窗口图的原点是窗口左上角，
 *      点击要的是整屏物理像素，两者混用会“成功地”点到别处。
 */
async function windowShot(
  controller: ComputerUseGuest,
  target: string | number,
  maxWidth: number | undefined,
): Promise<ComputerUseToolOutcome> {
  const size = maxWidth === undefined ? {} : { maxWidth };
  const options = typeof target === "number" ? { hwnd: target, ...size } : { title: target, ...size };
  const shot = await controller.windowShot(options);
  if (!shot.ok) {
    // 只有「按标题找」才值得列候选：传了 hwnd 就是那个窗口本身拍不到，列清单没有帮助
    const candidates = typeof target === "string" ? await candidateLine(controller) : "";
    return { ok: false, error: shot.error + candidates };
  }
  const restored = shot.restoredFromMinimized
    ? " It had been minimized and has been restored (without taking focus)."
    : "";
  return {
    ok: true,
    text:
      `Screenshot of the window "${shot.title}" (hwnd ${shot.hwnd}) in the sandbox: the image is ` +
      `${shot.width}×${shot.height}, the window itself is ${shot.nativeWidth}×${shot.nativeHeight} physical pixels. ` +
      "It is captured from the window's own surface, so other windows covering it do not matter." +
      restored +
      " Coordinates from THIS image are window pixels, not desktop pixels: do not pass them to " +
      "computer_click — take a normal computer_screenshot (without a window) before clicking.",
    shot: {
      width: shot.width,
      height: shot.height,
      nativeWidth: shot.nativeWidth,
      nativeHeight: shot.nativeHeight,
      data: shot.jpegBase64,
    },
  };
}

/** 候选窗口清单（best effort：列不出来就回空串，绝不让「列清单失败」顶掉真正的失败原因） */
async function candidateLine(controller: ComputerUseGuest): Promise<string> {
  const list = await controller.listWindows(WINDOW_LIST_TIMEOUT_MS).catch(() => null);
  if (list === null || !list.ok) return "";
  const rows = list.windows.slice(0, 12).map((window) => {
    const process = window.process === "" ? "" : ` (${window.process})`;
    const state = window.minimized ? ", minimized" : "";
    return `hwnd ${window.hwnd} "${window.title}"${process}${state}`;
  });
  if (rows.length === 0) return "";
  return (
    "\n\nWindows you can capture right now: " +
    rows.join("; ") +
    ". Pass one of these hwnds, or part of one of these titles, as window."
  );
}

/**
 * 请求里的 window → 桥要的 hwnd / title 两个字段（数字 = hwnd，字符串 = 标题片段）。
 * 空的字符串也照发：让桥回「没找到标题包含「」的窗口」比宿主静默丢掉它更不容易错。
 */
function targetOf(window: string | number | undefined): { hwnd?: number; title?: string } {
  if (window === undefined) return {};
  return typeof window === "number" ? { hwnd: window } : { title: window };
}

/**
 * uia-list 回执 → 给模型读的文本。
 *
 * 一行一个控件（标题行先给窗口与命中数）：模型要拿 ref 或 name 去 uia-act，所以这两个字段
 * 必须在前；patterns / 可用性 / offscreen 决定它该用哪个动作、要不要先滚动。
 * **不输出 JSON**：模型已经能把一行行的「ref · 类型 · 名字」对上去，多一层括号只是多烧 token。
 */
function uiaListText(reply: {
  hwnd: number;
  window: { title: string; className: string };
  items: readonly {
    ref: number;
    name: string;
    controlType: string;
    automationId: string;
    className: string;
    x: number;
    y: number;
    w: number;
    h: number;
    patterns: readonly string[];
    enabled: boolean;
    offscreen: boolean;
  }[];
  truncated: boolean;
}): string {
  const title = reply.window.title === "" ? "(no title)" : reply.window.title;
  const lines = reply.items.map((item) => {
    const name = item.name === "" ? `(automationId ${item.automationId})` : `"${item.name}"`;
    const patterns = item.patterns.length === 0 ? "focus only" : item.patterns.join("/");
    const flags: string[] = [];
    if (!item.enabled) flags.push("disabled");
    if (item.offscreen) flags.push("offscreen");
    const id = item.automationId === "" ? "" : ` id=${item.automationId}`;
    const state = flags.length === 0 ? "" : `, ${flags.join(", ")}`;
    return (
      `${item.ref} · ${item.controlType} ${name} · supports ${patterns}${state} · ` +
      `at ${item.x},${item.y} ${item.w}×${item.h}${id}`
    );
  });
  const header =
    `UI Automation controls in window "${title}" (hwnd ${reply.hwnd}): ${reply.items.length} listed` +
    (reply.truncated ? " (there are more — raise maxItems to see them)" : "") +
    ". Lines are: ref · control type \"name\" · supported patterns · position/size · automationId.";
  const body = lines.length === 0 ? "No actionable controls were found in this window." : lines.join("\n");
  const tail =
    "Act on one with computer_uia (action invoke / setValue / selection / focus, and ref or name). " +
    "These actions go straight into the control: the window does not need the foreground, so the sandbox " +
    "desktop is not taken over and another session can keep using it. Re-list after the window changes — " +
    "refs belong to the latest list. Controls that support no pattern above can only be driven through " +
    "computer_click / computer_type (pixels).";
  return `${header}\n${body}\n\n${tail}`;
}

/** uia-act 成功回执 → 给模型读的文本（含 AutoSetFocus 降级时的抢焦点警告） */
function uiaActText(reply: {
  hwnd: number;
  action: string;
  usedPattern: string;
  name: string;
  controlType: string;
  focused: boolean;
  autoSetFocus: boolean;
  autoSetFocusWarning?: string;
  elapsedMs: number;
}): string {
  const name = reply.name === "" ? "(unnamed control)" : `"${reply.name}"`;
  const verb =
    reply.action === "focus"
      ? "Moved keyboard focus to"
      : reply.action === "setValue"
        ? "Set the text of"
        : reply.action === "selection"
          ? "Selected"
          : "Invoked";
  const head =
    `${verb} ${name} (${reply.controlType}${reply.focused ? ", now focused" : ""}) in window hwnd ${reply.hwnd} ` +
    `through UI Automation (pattern ${reply.usedPattern}, ${reply.elapsedMs}ms). ` +
    (reply.action === "focus"
      ? "You asked for focus, so the keyboard focus moved."
      : "The window did not need the foreground, so the sandbox desktop was not taken over.") +
    " Take a computer_screenshot (window " +
    reply.hwnd +
    ") to see what changed.";
  if (reply.autoSetFocus) return head;
  const warning =
    reply.autoSetFocusWarning ??
    "AutoSetFocus could not be turned off on this system, so this action may have brought the window to the foreground.";
  return `${head}\n\nWarning: ${warning}`;
}
