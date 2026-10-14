/**
 * agent 的 computer use 工具组 —— Windows 沙箱桌面上的像素操作（截图 / 点击 / 打字 /
 * 按键 / 滚动）。PR2 的 agent 侧那一半。
 *
 * 这一层**只是翻译**：参数 → computerUseRequest → 等 computerUseResult → pi 工具结果。
 * 沙箱、文件协议、SendInput 全在主进程与 guest 桥里（main/computer-use/），agent 进程
 * 碰不到——换内核时只重写这个文件（browser-tools.ts 同款边界）。
 *
 * **坐标换算在这里**：模型看到的是截图那张图（guest 按长边缩到 maxWidth 以内），它给的
 * 坐标是图里的像素，而 SendInput 要的是沙箱物理屏的像素。两张图的比例只有这一层知道
 * （它刚把图交给模型），所以换算必须在这儿做，并把物理像素下发下去。换算的几何来自
 * **本工具组最近一次截图**——没有截图就点击一律当场拒绝，不去猜、不去用上一次的旧图
 * （屏幕可能已经翻页 / 换窗，拿旧比例点等于替模型点了个它没看见的地方）。
 *
 * 工具组随会话每一轮新建（runtime 的开轮装配），所以「最近一次截图」的生命周期就是
 * 这一轮：模型在这一轮里先截图再动手，跨轮要重新截。这正是我们要的纪律——
 * 每轮动手前先看一眼屏幕。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import {
  COMPUTER_USE_SHOT_MAX_WIDTH,
  screenshotPointToNative,
  type ComputerUseButton,
  type ComputerUseShotGeometry,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
} from "../shared/computer-use.ts";

/** call 成功时的回执形状：失败在 call 里就抛成 Error 了，工具拿到的一定是这一支 */
type ComputerUseSuccess = Extract<ComputerUseToolOutcome, { ok: true }>;

/** 工具名（权限档描述与测试认这一份；runtime 在开轮时把它讲给模型听） */
export const COMPUTER_USE_TOOL_NAMES = [
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
] as const;

/** 交互类工具共同的底线：沙箱里也是用户的环境，别替用户做不可逆的事 */
const CONSEQUENCES =
  "Do not buy, pay, send, publish, delete or change account settings unless the user asked for exactly that.";

/** 交接指引：沙箱里碰到登录 / 验证码，只能请用户来 */
const HANDOFF_HINT =
  "The sandbox is isolated: it has no sign-in state of the user's and you cannot solve a CAPTCHA in it. " +
  "If a page needs either, stop and tell the user what to do — do not guess credentials.";

/** 「先截图」的拒绝语：模型只有这一条路看见沙箱，说清楚它该先干什么 */
const NEEDS_SCREENSHOT =
  "No screenshot yet in this turn: call computer_screenshot first. Coordinates are pixels of that image, " +
  "and the image is what tells you where anything is.";

export function createComputerUseTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  /**
   * 本工具组最近一次截图的几何（回图尺寸 + 物理屏尺寸）。null = 这一轮还没截过图，
   * 此时一切带坐标的操作都拒绝（NEEDS_SCREENSHOT）。
   */
  let lastShot: ComputerUseShotGeometry | null = null;

  /**
   * 发请求并等回执；**这一轮被停掉（signal abort）就立刻放手**——pi 等工具返回才结束
   * 一轮，不放手的话「停止」按钮会失灵（browser-tools.ts 同款）。
   */
  const call = async (
    request: ComputerUseToolRequest,
    signal: AbortSignal | undefined,
  ): Promise<ComputerUseSuccess> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<ComputerUseToolOutcome>({ type: "computerUseRequest", sessionId, request });
    const result =
      signal === undefined
        ? await pending
        : await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
            ),
          ]);
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  /**
   * 模型给的图像坐标 → 沙箱物理像素。越界 / 没截图都当场报错：**这两种情况都说明模型
   * 对屏幕的心智模型是错的**，悄悄钳到边缘只会让它以为点对了。
   */
  const nativePoint = (x: number, y: number): { x: number; y: number } => {
    const shot = lastShot;
    if (shot === null) throw new Error(NEEDS_SCREENSHOT);
    const point = screenshotPointToNative(shot, x, y);
    if (point === null) {
      throw new Error(
        `(${x}, ${y}) is outside the screenshot you last took (${shot.width}×${shot.height} pixels): ` +
          "take a fresh screenshot and use coordinates from that image.",
      );
    }
    return point;
  };

  /**
   * 滚动的落点：x、y 都给了就换算；都没给就用屏幕正中（正中也要先有截图才知道屏幕
   * 多大）；只给一个算错——半个坐标没有意义，静默补另一半等于替模型猜。
   */
  const scrollTarget = (args: Record<string, unknown>): { x: number; y: number } => {
    const x = numberOf(args["x"]);
    const y = numberOf(args["y"]);
    if (x !== undefined && y !== undefined) return nativePoint(x, y);
    if (x !== undefined || y !== undefined) {
      throw new Error("Pass both x and y, or neither (neither = the middle of the screen).");
    }
    const shot = lastShot;
    if (shot === null) throw new Error(NEEDS_SCREENSHOT);
    const center = screenshotPointToNative(shot, shot.width / 2, shot.height / 2);
    if (center === null) throw new Error(NEEDS_SCREENSHOT); // 图正中永远在图内，这里只是让类型收口
    return center;
  };

  const screenshot: ToolDefinition = {
    name: "computer_screenshot",
    label: "computer_screenshot",
    description:
      "Take a screenshot of the Windows sandbox desktop (an isolated copy of Windows that the user started " +
      "for you). **Start here and come back here after every action**: this image is the only way you can see " +
      "the sandbox, and the coordinates you pass to computer_click / computer_scroll are pixels of this image. " +
      "The image is scaled down (its size is in the result); do not assume it is the physical screen size. " +
      "The sandbox starts empty: no user data, no sign-in state, and its image is a bare Windows — notepad is " +
      "not installed (cmd.exe and msedge are). If the result says the sandbox is not running, tell the user to " +
      "start it in Settings › Experimental features › Computer use; do not retry.",
    parameters: { type: "object", properties: {}, required: [] } as never,
    async execute(_toolCallId, _params, signal) {
      const result = await call({ action: "screenshot", maxWidth: COMPUTER_USE_SHOT_MAX_WIDTH }, signal);
      const shot = result.shot;
      if (shot === undefined) throw new Error("截图回执里没有图（主进程与契约不一致）");
      lastShot = shot;
      return {
        content: [
          { type: "text" as const, text: result.text },
          { type: "image" as const, data: shot.data, mimeType: "image/jpeg" as const },
        ],
        details: undefined,
      };
    },
  };

  const click: ToolDefinition = {
    name: "computer_click",
    label: "computer_click",
    description:
      "Click a point on the sandbox desktop, by x, y pixels of your latest computer_screenshot. It moves the " +
      "pointer there and presses — whatever is under that point receives it, so take a screenshot first and " +
      "click on what you actually see. Nothing but the fact that it was sent comes back: take another " +
      "screenshot to see what happened. " +
      CONSEQUENCES +
      " " +
      HANDOFF_HINT,
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal pixel in your latest computer_screenshot." },
        y: { type: "number", description: "Vertical pixel in your latest computer_screenshot." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button. Defaults to left.",
        },
        double: { type: "boolean", description: "Double-click instead of a single click. Defaults to false." },
      },
      required: ["x", "y"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const x = numberOf(args["x"]);
      const y = numberOf(args["y"]);
      if (x === undefined || y === undefined) {
        throw new Error("Pass x and y — pixels in your latest computer_screenshot.");
      }
      const point = nativePoint(x, y);
      const button = buttonOf(args["button"]);
      const result = await call(
        {
          action: "click",
          x: point.x,
          y: point.y,
          ...(button === undefined ? {} : { button }),
          ...(args["double"] === true ? { double: true } : {}),
        },
        signal,
      );
      return { content: [{ type: "text" as const, text: result.text }], details: undefined };
    },
  };

  const type: ToolDefinition = {
    name: "computer_type",
    label: "computer_type",
    description:
      "Type text into whatever has focus on the sandbox desktop. **Click the target first** with " +
      "computer_click — a window or dialog that just opened does not always have focus, and text typed into " +
      "an unfocused desktop is silently dropped. " +
      "Goes in as Unicode, so Chinese and symbols work. If typed characters do not appear at all, do not keep " +
      "retrying the same box: the win+r Run box in this sandbox swallows them (its Cancel button does not " +
      "respond either) — press escape and use the taskbar search box instead (click it, type the name, enter). " +
      "Keys that are not text (Enter, Tab, arrows, shortcuts) go through computer_key instead. " +
      "Take a screenshot afterwards to confirm it landed where you meant. Never type passwords, one-time " +
      "codes or other credentials — ask the user instead. " +
      CONSEQUENCES,
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text to type." } },
      required: ["text"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const text = (params as Record<string, unknown> | undefined)?.["text"];
      if (typeof text !== "string") throw new Error("text is required");
      const result = await call({ action: "type", text }, signal);
      return { content: [{ type: "text" as const, text: result.text }], details: undefined };
    },
  };

  const key: ToolDefinition = {
    name: "computer_key",
    label: "computer_key",
    description:
      "Press a key or a key combination on the sandbox desktop: enter, tab, escape, backspace, delete, home, " +
      "end, pageup, pagedown, up / down / left / right, f1–f12, ctrl+a, alt+f4, ctrl+shift+s… " +
      "It goes to the focused window — click the window first. Take a screenshot afterwards to confirm. " +
      "This is how you open things from the desktop itself. **Prefer the taskbar search box**: click it, type " +
      "the program name (cmd, msedge — the image is a bare Windows and notepad is not installed), press " +
      "enter. **Do not use the win+r Run box**: in this sandbox click reaches it but typed characters do not " +
      "land in it (and its Cancel button does not respond). If you already opened it and typing did nothing, " +
      "do not retry that box — press escape and use the taskbar search box instead. " +
      CONSEQUENCES,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Key name, with modifiers joined by "+": "enter", "ctrl+a", "alt+f4".' },
      },
      required: ["key"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const keyName = (params as Record<string, unknown> | undefined)?.["key"];
      if (typeof keyName !== "string" || keyName.trim() === "") throw new Error("key is required");
      const result = await call({ action: "key", key: keyName.trim() }, signal);
      return { content: [{ type: "text" as const, text: result.text }], details: undefined };
    },
  };

  const scroll: ToolDefinition = {
    name: "computer_scroll",
    label: "computer_scroll",
    description:
      "Scroll at a point on the sandbox desktop, by x, y pixels of your latest computer_screenshot. The point " +
      "decides which pane scrolls — pass the x, y of the list or page you mean (omitted = the middle of the " +
      "screen). deltaY is a number of wheel notches: positive scrolls down, negative up (3 is about nine " +
      "lines). Take a screenshot afterwards to see the new position.",
    parameters: {
      type: "object",
      properties: {
        deltaY: { type: "number", description: "Wheel notches; positive scrolls down (3 ≈ nine lines)." },
        x: { type: "number", description: "Horizontal pixel in your latest computer_screenshot. Defaults to the middle." },
        y: { type: "number", description: "Vertical pixel in your latest computer_screenshot. Defaults to the middle." },
      },
      required: ["deltaY"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const deltaY = numberOf(args["deltaY"]);
      if (deltaY === undefined) throw new Error("deltaY is required (positive scrolls down).");
      const notches = Math.round(deltaY);
      const result = await call({ action: "scroll", ...scrollTarget(args), deltaY: notches }, signal);
      return { content: [{ type: "text" as const, text: result.text }], details: undefined };
    },
  };

  return [screenshot, click, type, key, scroll];
}

/** 模型偶尔把数字写成字符串（"120"）：认；其余一律当没给 */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function buttonOf(value: unknown): ComputerUseButton | undefined {
  return value === "left" || value === "right" || value === "middle" ? value : undefined;
}
