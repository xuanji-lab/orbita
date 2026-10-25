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
  GUEST_COMMAND_TIMEOUT_MS,
  screenshotPointToNative,
  type ComputerUseAudit,
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
  "computer_uia",
] as const;

/** 交互类工具共同的底线：沙箱里也是用户的环境，别替用户做不可逆的事 */
const CONSEQUENCES =
  "Do not buy, pay, send, publish, delete or change account settings unless the user asked for exactly that.";

/** 交接指引：沙箱里碰到登录 / 验证码，只能请用户来 */
const HANDOFF_HINT =
  "The sandbox is isolated: it has no sign-in state of the user's and you cannot solve a CAPTCHA in it. " +
  "If a page needs either, stop and tell the user what to do — do not guess credentials.";

/**
 * 分工与抢占：这两句进**每个** computer_* 的描述，因为模型看不到 UI、也想不到「另一个会话
 * 正占着这个桌面」。不写的话它会用像素工具做网页任务（慢且脆），或者在被占用时立刻重试
 * （正是 lease.ts 最不该发生的事）。
 */
const SCOPE =
  "Use this for **desktop GUI tasks** on the sandbox desktop. For web pages prefer the sandbox_* tools (DOM " +
  "level, they drive the sandbox's Edge) or the host browser_* tools — they are faster and steadier than " +
  "pixels. ";

const BUSY =
  "The sandbox desktop belongs to **one session at a time** (pixel tools share the single screen and the " +
  "foreground focus): if the result says another session holds it, do not retry — wait for that session's " +
  "turn to end, or ask the user which session should drive the sandbox. **The sandbox_* web tools do not " +
  "queue**: each session drives its own Edge instance, so for web tasks use sandbox_* instead of waiting on " +
  "the desktop. ";

/** 「先截图」的拒绝语：模型只有这一条路看见沙箱，说清楚它该先干什么 */
const NEEDS_SCREENSHOT =
  "No screenshot yet in this turn: call computer_screenshot first. Coordinates are pixels of that image, " +
  "and the image is what tells you where anything is.";

/**
 * broker 的兜底超时：必须比主进程等 guest 命令的 GUEST_COMMAND_TIMEOUT_MS（45s）更长。
 * broker 默认 30s 会抢在主进程之前超时：主进程还在等桥（win+r 黑窗实测 req 要 8–20s
 * 才对 guest 可见），agent 先拿到「主进程没有在 30 秒内回执」，把一次真的成功了
 * 的动作判成失败——模型看到失败会重做同一个动作（browser-tools.ts 导航同款考量）。
 * 取主进程线 + 15s 余量：主进程自己的超时会回带人话的错误，broker 这条只兑「主进程
 * 失联」。常量在 shared/computer-use.ts（agent 进程不能 import 主进程模块）。
 */
const BROKER_TIMEOUT_MS = GUEST_COMMAND_TIMEOUT_MS + 15_000;

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
  /**
   * 审计载荷（details.computerUse）：动作 + 模型给的原始入参 + 时刻。**只给 UI 与
   * 日志**，不入模型上下文。入参记的是模型给的那份（图像坐标 / 原文本），不是换算后
   * 下发到 guest 的那份——回看的人要的是「它以为自己点了哪里、打了什么」。
   */
  const audit = (args: Record<string, unknown>, action: ComputerUseAudit["action"]): ComputerUseAudit => ({
    action,
    args,
    at: Date.now(),
  });

  const call = async (
    request: ComputerUseToolRequest,
    signal: AbortSignal | undefined,
  ): Promise<ComputerUseSuccess> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<ComputerUseToolOutcome>(
      { type: "computerUseRequest", sessionId, request },
      BROKER_TIMEOUT_MS,
    );
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
      SCOPE +
      BUSY +
      "Take a screenshot of the Windows sandbox desktop (an isolated copy of Windows that the user started " +
      "for you). **Start here and come back here after every action**: this image is the only way you can see " +
      "the sandbox, and the coordinates you pass to computer_click / computer_scroll are pixels of this image. " +
      "The image is scaled down (its size is in the result); do not assume it is the physical screen size. " +
      "**Pass window (part of a window title) or hwnd to capture only that window**: that works even when other " +
      "windows cover it and it does not take focus, so it is the cheap way to check on a window you are not " +
      "driving. A window image's pixels are window pixels, not desktop pixels: take a normal screenshot (no " +
      "window) before clicking. " +
      "The sandbox starts empty: no user data, no sign-in state, and its image is a bare Windows — notepad is " +
      "not installed (cmd.exe and msedge are). If the result says the sandbox is not running, tell the user to " +
      "start it in Settings › Experimental features › Computer use; do not retry.",
    parameters: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description:
            "Part of the target window's title (case-insensitive). Captures only that window, even if covered.",
        },
        hwnd: {
          type: "number",
          description: "Target window handle (wins over window). Comes from a previous window screenshot result.",
        },
      },
      required: [],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const hwnd = numberOf(args["hwnd"]);
      const title = typeof args["window"] === "string" ? args["window"].trim() : "";
      const target = hwnd !== undefined ? hwnd : title === "" ? undefined : title;
      const request: ComputerUseToolRequest =
        target === undefined
          ? { action: "screenshot", maxWidth: COMPUTER_USE_SHOT_MAX_WIDTH }
          : { action: "screenshot", maxWidth: COMPUTER_USE_SHOT_MAX_WIDTH, window: target };
      const result = await call(request, signal);
      const shot = result.shot;
      if (shot === undefined) throw new Error("截图回执里没有图（主进程与契约不一致）");
      // 只拍窗口时**不更新** lastShot：那张图的原点是窗口左上角，而 click 要的是整屏物理像素。
      // 更新了它，下一次 computer_click 会看起来「成功」却点到另一个地方——静默错位比报错更坏。
      if (target === undefined) lastShot = shot;
      return {
        content: [
          { type: "text" as const, text: result.text },
          { type: "image" as const, data: shot.data, mimeType: "image/jpeg" as const },
        ],
        details: { computerUse: audit({ maxWidth: COMPUTER_USE_SHOT_MAX_WIDTH }, "screenshot") },
      };
    },
  };

  const click: ToolDefinition = {
    name: "computer_click",
    label: "computer_click",
    description:
      SCOPE +
      BUSY +
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
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { computerUse: audit({ x, y, ...(button === undefined ? {} : { button }), ...(args["double"] === true ? { double: true } : {}) }, "click") },
      };
    },
  };

  const type: ToolDefinition = {
    name: "computer_type",
    label: "computer_type",
    description:
      SCOPE +
      BUSY +
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
      return {
        content: [{ type: "text" as const, text: result.text }],
        // 明文留在 details / 转录（JSONL 保留明文）；renderer 默认折叠显示
        details: { computerUse: audit({ text }, "type") },
      };
    },
  };

  const key: ToolDefinition = {
    name: "computer_key",
    label: "computer_key",
    description:
      SCOPE +
      BUSY +
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
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { computerUse: audit({ key: keyName.trim() }, "key") },
      };
    },
  };

  const scroll: ToolDefinition = {
    name: "computer_scroll",
    label: "computer_scroll",
    description:
      SCOPE +
      BUSY +
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
      const target = scrollTarget(args);
      const result = await call({ action: "scroll", ...target, deltaY: notches }, signal);
      return {
        content: [{ type: "text" as const, text: result.text }],
        // 入参里没有 x/y = 滚屏幕正中（工具层的缺省），审计照实记缺省
        details: {
          computerUse: audit(
            { ...(numberOf(args["x"]) === undefined ? {} : { x: numberOf(args["x"]) }), ...(numberOf(args["y"]) === undefined ? {} : { y: numberOf(args["y"]) }), deltaY: notches },
            "scroll",
          ),
        },
      };
    },
  };

  const uia: ToolDefinition = {
    name: "computer_uia",
    label: "computer_uia",
    description:
      SCOPE +
      "Drive a window's controls through UI Automation instead of pixels: list them, then invoke a button, set an " +
      "input's text, select a list/tab item, or move focus. **This does not need the window in the foreground and " +
      "does not take the sandbox desktop away from another session** (the bridge turns AutoSetFocus off), so it is " +
      "the right way to drive a background window. Start with action \"list\" (read-only) to get refs and names, then " +
      "act on one by ref (or name). A ref belongs to the latest list of that window; re-list after the window changes " +
      "(page navigation, a new dialog). Actions: invoke (buttons, links, menu items, tabs), setValue (text boxes and " +
      "documents — sets the value directly, no IME needed), selection (list items, tab items), focus (only this one " +
      "moves the keyboard focus). If a control does not support the action you asked for, the result says which ones " +
      "it supports: fall back to computer_click / computer_type on pixels for those. Window and hwnd come from " +
      "computer_screenshot or a previous result. " +
      CONSEQUENCES +
      " " +
      HANDOFF_HINT,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "invoke", "setValue", "selection", "focus"],
          description:
            "list = read the window's controls (read-only); the rest act on the control given by ref or name.",
        },
        window: {
          type: "string",
          description: "Part of the target window's title (case-insensitive). Needed with hwnd absent.",
        },
        hwnd: {
          type: "number",
          description: "Target window handle (wins over window). Comes from a previous screenshot/result.",
        },
        ref: {
          type: "number",
          description: "Control ref from the latest list of that window. Wins over name.",
        },
        name: {
          type: "string",
          description: "Part of the control's accessible name (case-insensitive). Exact match preferred.",
        },
        value: {
          type: "string",
          description: "New text for action setValue (empty string clears the field).",
        },
        maxItems: {
          type: "number",
          description: "How many controls list returns (default 60).",
        },
      },
      required: ["action"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const spelled = typeof args["action"] === "string" ? args["action"].trim().toLowerCase() : "";
      // setValue 的规范写法是小驼峰：比较前先还原（否则它会被当成未知动作拒掉）
      const rawAction = spelled === "setvalue" ? "setValue" : spelled;
      const hwnd = numberOf(args["hwnd"]);
      const title = typeof args["window"] === "string" ? args["window"].trim() : "";
      const target = hwnd !== undefined ? hwnd : title === "" ? undefined : title;
      if (target === undefined) {
        throw new Error(
          "Pass window (part of the target window's title) or hwnd — take one from computer_screenshot or a previous result.",
        );
      }
      if (rawAction === "list") {
        // 描述里写的是 default 60，所以这里**总是**显式下发：不写的话桥的缺省是 200，
        // 模型看到一句「default 60」却收到 200 行，工具描述就成了假话。
        const maxItems = numberOf(args["maxItems"]) ?? 60;
        const result = await call(
          { action: "uia-list", window: target, maxItems: Math.round(maxItems) },
          signal,
        );
        return { content: [{ type: "text" as const, text: result.text }], details: undefined };
      }
      if (rawAction !== "invoke" && rawAction !== "setValue" && rawAction !== "selection" && rawAction !== "focus") {
        throw new Error('action must be one of: list, invoke, setValue, selection, focus.');
      }
      const ref = numberOf(args["ref"]);
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (ref === undefined && name === "") {
        throw new Error(
          "Pass ref (from the latest list of that window) or name (part of the control's accessible name).",
        );
      }
      if (ref !== undefined && (!Number.isInteger(ref) || ref <= 0)) {
        throw new Error("ref must be a positive integer from the latest list of that window.");
      }
      const value = args["value"];
      if (rawAction === "setValue" && typeof value !== "string") {
        throw new Error("setValue needs value: the text to write into the control (empty string clears it).");
      }
      const result = await call(
        {
          action: "uia-act",
          window: target,
          ...(ref === undefined ? {} : { ref: Math.round(ref) }),
          ...(name === "" ? {} : { name }),
          perform: rawAction,
          ...(typeof value === "string" ? { value } : {}),
        },
        signal,
      );
      return { content: [{ type: "text" as const, text: result.text }], details: undefined };
    },
  };

  return [screenshot, click, type, key, scroll, uia];
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
