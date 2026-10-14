/**
 * agent 在自己 tab 上的交互：点击、输入、按键、滚动、后退 / 前进
 * （browser_click / browser_type / browser_press / browser_scroll，browser_navigate 的 back / forward）。
 *
 * 输入一律走 CDP 的**可信输入**（Input.dispatchMouseEvent / dispatchKeyEvent / insertText）：页面收到的
 * 事件 isTrusted = true，与真人操作走同一条路——React 受控输入、防机器人检测都认。页内脚本
 * （Runtime.callFunctionOn）只做定位（滚进视口、取中心点、查遮挡）、清空字段与 `<select>` 选项这几件
 * 可信输入做不到或做不稳的事。
 *
 * 定位二选一：元素引用（page-outline.ts 发的 ref → backendDOMNodeId）或截图坐标（screenshot-geometry.ts
 * 换算）。后台 tab、从没显示过的窗口里一样能操作：焦点模拟（Emulation.setFocusEmulationEnabled）让
 * 页面以为自己有焦点，聚焦与输入照常生效。
 *
 * 本模块对 electron 只有类型依赖，其中的纯函数（describeScroll 等）可被 node --test 直接加载。
 */
import type { Event as ElectronEvent, WebContents, WebContentsDidStartNavigationEventParams } from "electron";
import type { BrowserScrollDirection, BrowserTarget, BrowserToolRequest } from "../../shared/browser.ts";
import { cdp, delay } from "./cdp.ts";
import { parseKeyCombo, type KeyStroke } from "./keys.ts";
import { toCssPoint, type ShotGeometry } from "./screenshot-geometry.ts";
import type { ElementRefs } from "./page-outline.ts";

/** 交互需要的 tab 状态：引用表与最近一次截图的几何（sandbox.ts 的 BrowserTab 结构上满足） */
export interface InteractiveTab {
  refs: ElementRefs;
  shot: ShotGeometry | null;
}

/** 动作之后给页面一点反应时间（脚本渲染、下拉展开、导航起步） */
const ACTION_SETTLE_MS = 350;
/** 动作触发了导航：最多等这么久加载完；到点不算失败，如实说还在加载 */
const ACTION_LOAD_TIMEOUT_MS = 30_000;
/** 加载完再等一小会：单页应用在 load 之后才渲染内容（与导航同一个值） */
const PAGE_SETTLE_MS = 800;
/** 滚轮滚动是平滑动画：每隔 SCROLL_POLL_MS 读一次位置，停下就报，最多等 SCROLL_SETTLE_MS */
const SCROLL_SETTLE_MS = 1500;
const SCROLL_POLL_MS = 150;
/** 一「屏」滚多少：留 20% 重叠，上下文不断 */
const SCROLL_PAGE_FRACTION = 0.8;
/** 解析引用时拿到的页内对象归到这个组，动作结束整组释放 */
const OBJECT_GROUP = "orbita-action";

// ── 动作 ──────────────────────────────────────────────────────────────

export async function click(contents: WebContents, tab: InteractiveTab, target: BrowserTarget): Promise<string> {
  await enableFocus(contents);
  if ("ref" in target) {
    const ref = normalizeRef(target.ref);
    const located = await locateRef(contents, tab, ref);
    if (located.covered !== null) {
      throw new Error(
        `${ref} ${located.label} is covered by ${located.covered} — probably a cookie banner, dialog or overlay. ` +
          "Close or accept it first (observe the page to find its button). Click by x/y only if you are sure.",
      );
    }
    await mouseClick(contents, located.x, located.y);
    return `Clicked ${ref} ${located.label}.`;
  }
  const point = cssPoint(tab, target.x, target.y);
  const what = await elementAt(contents, point);
  await mouseClick(contents, point.x, point.y);
  return `Clicked at (${Math.round(target.x)}, ${Math.round(target.y)}) on ${what}.`;
}

export async function typeText(
  contents: WebContents,
  tab: InteractiveTab,
  request: Extract<BrowserToolRequest, { action: "type" }>,
): Promise<string> {
  await enableFocus(contents);
  let into: string;
  let clearedEditable = false;
  if (request.ref !== undefined) {
    const ref = normalizeRef(request.ref);
    const objectId = await resolveRef(contents, tab, ref);
    const prepared = readRecord(await callOn(contents, objectId, PREPARE_TYPING_FN, [request.clear !== false]));
    if (prepared["kind"] === "select") {
      const chosen = readRecord(await callOn(contents, objectId, SELECT_OPTION_FN, [request.text]));
      if (typeof chosen["selected"] === "string") return `Selected "${chosen["selected"]}" in ${ref}.`;
      const options = Array.isArray(chosen["options"]) ? chosen["options"].filter((o): o is string => typeof o === "string") : [];
      throw new Error(
        `${ref} is a dropdown with no option matching "${request.text}".` +
          (options.length > 0 ? ` Its options: ${options.map((o) => `"${o}"`).join(", ")}.` : ""),
      );
    }
    const failure = typingFailure(prepared, ref);
    if (failure !== null) throw new Error(failure);
    into = `${ref} ${str(prepared["label"])}`;
    clearedEditable = prepared["kind"] === "editable" && request.clear !== false;
  } else {
    const focused = readRecord(await evaluate(contents, FOCUSED_FIELD_JS));
    const failure = typingFailure(focused, "the focused element");
    if (failure !== null) throw new Error(failure);
    into = str(focused["label"]);
  }
  if (request.text !== "") await cdp(contents, "Input.insertText", { text: request.text });
  // 清空富文本框（contenteditable）靠「全选 + 输入替换」；要清成空就补一下删除键
  else if (clearedEditable) await pressStroke(contents, DELETE_KEY);
  const value = await evaluate(contents, FOCUSED_VALUE_JS);
  const reads = typeof value === "string" ? ` It now reads: "${clip(value, 160)}".` : "";
  if (request.submit === true) {
    await pressStroke(contents, ENTER_KEY);
    return `Typed ${request.text.length} characters into ${into} and pressed Enter.${reads}`;
  }
  return `Typed ${request.text.length} characters into ${into}.${reads}`;
}

export async function press(contents: WebContents, request: Extract<BrowserToolRequest, { action: "press" }>): Promise<string> {
  const stroke = parseKeyCombo(request.key, process.platform);
  if ("error" in stroke) throw new Error(stroke.error);
  await enableFocus(contents);
  const times = clampInt(request.repeat ?? 1, 1, 20);
  for (let i = 0; i < times; i += 1) await pressStroke(contents, stroke);
  return `Pressed ${request.key.trim()}${times > 1 ? ` ×${times}` : ""}.`;
}

export async function scroll(
  contents: WebContents,
  tab: InteractiveTab,
  request: Extract<BrowserToolRequest, { action: "scroll" }>,
): Promise<string> {
  let point: { x: number; y: number };
  if (request.target === undefined) {
    const size = readRecord(await evaluate(contents, "({ width: innerWidth, height: innerHeight })"));
    point = { x: num(size["width"]) / 2, y: num(size["height"]) / 2 };
  } else if ("ref" in request.target) {
    const located = await locateRef(contents, tab, normalizeRef(request.target.ref));
    point = { x: located.x, y: located.y };
  } else {
    point = cssPoint(tab, request.target.x, request.target.y);
  }
  const before = readScrollState(await evaluate(contents, scrollProbe(point)));
  const amount = Math.min(Math.max(request.amount ?? 1, 0.25), 10);
  const vertical = request.direction === "up" || request.direction === "down";
  const sign = request.direction === "up" || request.direction === "left" ? -1 : 1;
  const distance = Math.round((vertical ? before.viewHeight : before.viewWidth) * SCROLL_PAGE_FRACTION * amount) * sign;
  await cdp(contents, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await cdp(contents, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: vertical ? 0 : distance,
    deltaY: vertical ? distance : 0,
  });
  // 平滑滚动是动画：等位置连续两次读数不变再报（最多等到 SCROLL_SETTLE_MS）
  let after = before;
  for (let waited = 0; waited < SCROLL_SETTLE_MS; waited += SCROLL_POLL_MS) {
    await delay(SCROLL_POLL_MS);
    const next = readScrollState(await evaluate(contents, scrollProbe(point)));
    const settled = waited > 0 && next.top === after.top && next.left === after.left;
    after = next;
    if (settled) break;
  }
  // 截图坐标只对拍摄时的整页位置成立：整页滚过就作废，逼模型重新截图再点坐标。
  // 只滚了页面里的一个面板不作废——面板本身没动，接着在同一点滚是常态（2026-09-28 实测被这条绊过）
  if (after.page && (after.top !== before.top || after.left !== before.left)) tab.shot = null;
  return describeScroll(before, after, request.direction);
}

export async function goHistory(contents: WebContents, direction: "back" | "forward"): Promise<string> {
  const history = contents.navigationHistory;
  if (direction === "back" ? !history.canGoBack() : !history.canGoForward()) {
    throw new Error(`There is no ${direction === "back" ? "earlier" : "later"} page in your tab's history.`);
  }
  if (direction === "back") history.goBack();
  else history.goForward();
  return direction === "back" ? "Went back one page." : "Went forward one page.";
}

/**
 * 跑一个动作并看它有没有换页：动作引起了跨文档导航就等加载完（≤30 秒）；没有就给页面一点反应时间。
 * 顺带收走动作期间页面弹出的对话框（见 guardDialogs）。
 *
 * 「起步」与「换成了新页面」分开记：点一个 PDF 链接时导航起了步，却被下载替换、页面原地不动——
 * 这时不能告诉模型「换页了、引用作废」。只有主框架真的提交了新文档（did-navigate）才算换页。
 */
export async function watchPageChange<T>(
  contents: WebContents,
  action: () => Promise<T>,
): Promise<{ value: T; navigated: boolean; loading: boolean; dialogs: string[] }> {
  let started = false;
  let navigated = false;
  const onStart = (details: ElectronEvent<WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) started = true;
  };
  const onCommit = (): void => {
    navigated = true;
  };
  contents.on("did-start-navigation", onStart);
  contents.on("did-navigate", onCommit);
  try {
    const value = await action();
    await delay(ACTION_SETTLE_MS);
    // 导航中往旧文档里跑脚本可能卡到超时：只在没有导航时收对话框（换了页，旧页的对话框也跟着没了）
    const dialogs = started ? [] : await takeDialogs(contents);
    if (!started && !contents.isLoading()) return { value, navigated, loading: false, dialogs };
    const stopped = await waitForStop(contents, ACTION_LOAD_TIMEOUT_MS);
    if (stopped) await delay(PAGE_SETTLE_MS);
    return { value, navigated, loading: !stopped, dialogs };
  } finally {
    contents.off("did-start-navigation", onStart);
    contents.off("did-navigate", onCommit);
    // 引用解析出的页内对象整组释放；页面已经换了的话这条会失败，无所谓
    await cdp(contents, "Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }
}

/**
 * agent tab 里的 alert / confirm / prompt 一律自动关掉（confirm 答「取消」、prompt 答空），消息记下来
 * 报给模型——Playwright 的默认同款。不拦的话 Electron 会弹原生模态框：落在用户屏幕上，或者挂在
 * 隐藏的沙盒窗口上没人看得见，页面的脚本线程就此卡住，之后每个工具调用都超时。
 * 新文档靠 addScriptToEvaluateOnNewDocument，当前文档当场补一次；调试器断开（页面崩溃）后重新注册。
 * 注意：Chromium 150 起 addScriptToEvaluateOnNewDocument 必须先在同 session Page.enable，
 * 否则返回成功却静默不生效（2026-10-14 隔离实例 A/B 实测）。
 *
 * **从没加载过任何页面的视图跳过**：它还没有渲染进程，任何 CDP 命令（连
 * addScriptToEvaluateOnNewDocument 都算）都不回，只能等超时——2026-09-28 实测：第一次导航前先装护栏，
 * 整个 tab 就卡死了。调用方在第一次导航落定后再调一次。
 */
export async function guardDialogs(contents: WebContents): Promise<void> {
  if (contents.getURL() === "") return;
  if (!guarded.has(contents) || !contents.debugger.isAttached()) {
    await cdp(contents, "Page.enable");
    await cdp(contents, "Page.addScriptToEvaluateOnNewDocument", { source: DIALOG_GUARD_JS });
    if (!guarded.has(contents)) contents.debugger.once("detach", () => guarded.delete(contents));
    guarded.add(contents);
  }
  await evaluate(contents, DIALOG_GUARD_JS).catch(() => undefined);
}

const guarded = new WeakSet<WebContents>();

// ── 纯函数（node --test 覆盖）────────────────────────────────────────

export interface ScrollState {
  top: number;
  left: number;
  height: number;
  width: number;
  viewHeight: number;
  viewWidth: number;
  /** 滚的是整页，还是页面里一个自带滚动条的面板 */
  page: boolean;
  label: string;
}

/** 滚动结果给模型的一句话：滚到了哪、是不是到头了、没动的话可能是什么原因 */
export function describeScroll(before: ScrollState, after: ScrollState, direction: BrowserScrollDirection): string {
  const vertical = direction === "up" || direction === "down";
  const where = after.page ? "the page" : `the panel ${after.label}`;
  const position = vertical ? after.top : after.left;
  const range = Math.max(0, vertical ? after.height - after.viewHeight : after.width - after.viewWidth);
  const moved = vertical ? after.top - before.top : after.left - before.left;
  if (Math.abs(moved) < 1) {
    const edge = direction === "down" ? "bottom" : direction === "up" ? "top" : direction === "left" ? "left edge" : "right edge";
    return (
      `Nothing moved: ${where} is already at the ${edge}, or the part you want scrolls separately ` +
      "(pass ref or x/y of something inside that panel)."
    );
  }
  const percent = range === 0 ? 100 : Math.round(Math.min(100, Math.max(0, (position / range) * 100)));
  const axis = vertical ? "down" : "across";
  const end =
    position >= range - 2 ? (vertical ? " — reached the bottom." : " — reached the right edge.") : position <= 1 ? " — back at the start." : ".";
  return `Scrolled ${where} ${direction}: now ${percent}% ${axis} (${Math.round(position)} of ${Math.round(range)} px)${end}`;
}

/** 定位 / 输入准备脚本的失败 → 给模型的一句话；成功回 null */
export function typingFailure(result: Record<string, unknown>, what: string): string | null {
  const error = result["error"];
  if (error === undefined) return null;
  const label = typeof result["label"] === "string" && result["label"] !== "" ? ` ${result["label"]}` : "";
  switch (error) {
    case "password":
      return (
        `${what}${label} is a password field. Never type credentials: call request_user_action and let the user ` +
        "sign in themselves."
      );
    case "nothing":
      return "Nothing on the page has focus. Pass ref, or click the field first.";
    case "not-editable":
      return `${what}${label} is not a text field. Pass the ref of an input, or click the field first.`;
    case "readonly":
      return `${what}${label} is disabled or read-only.`;
    case "gone":
      return `${what} is no longer on the page. Call browser_observe again.`;
    default:
      return `Could not type into ${what}${label}.`;
  }
}

// ── 内部 ──────────────────────────────────────────────────────────────

const ENTER_KEY: KeyStroke = { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r", commands: [] };
const DELETE_KEY: KeyStroke = { key: "Delete", code: "Delete", keyCode: 46, modifiers: 0, text: "", commands: [] };

/** 模型有时照抄大纲里的整段 `[ref=e12]`：只取引用本身 */
function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\[?ref=/, "").replace(/\]$/, "");
}

async function resolveRef(contents: WebContents, tab: InteractiveTab, ref: string): Promise<string> {
  const backendNodeId = tab.refs.byRef.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(
      `Unknown ref "${ref}". Refs come from browser_observe on the page currently in your tab — ` +
        "they are gone once it loads a new page. Call browser_observe again.",
    );
  }
  const gone = new Error(`${ref} is no longer on the page (it changed since you observed it). Call browser_observe again.`);
  let resolved: unknown;
  try {
    resolved = await cdp(contents, "DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP });
  } catch {
    throw gone;
  }
  const objectId = readRecord(readRecord(resolved)["object"])["objectId"];
  if (typeof objectId !== "string") throw gone;
  return objectId;
}

/** 引用 → 滚进视口后的中心点（CSS 像素）+ 遮挡检查 */
async function locateRef(
  contents: WebContents,
  tab: InteractiveTab,
  ref: string,
): Promise<{ x: number; y: number; label: string; covered: string | null }> {
  const objectId = await resolveRef(contents, tab, ref);
  const located = readRecord(await callOn(contents, objectId, LOCATE_FN));
  if (located["error"] === "gone") throw new Error(`${ref} is no longer on the page. Call browser_observe again.`);
  if (located["error"] === "hidden") {
    throw new Error(
      `${ref} ${str(located["label"])} is not visible (zero size or hidden). It may sit inside a collapsed menu ` +
        "or tab — open that first.",
    );
  }
  return {
    x: num(located["x"]),
    y: num(located["y"]),
    label: str(located["label"]),
    covered: typeof located["covered"] === "string" ? located["covered"] : null,
  };
}

function cssPoint(tab: InteractiveTab, x: number, y: number): { x: number; y: number } {
  if (tab.shot === null) {
    throw new Error(
      "x/y are pixels in your latest full screenshot of this tab, and there is none for the current view " +
        "(the page changed or scrolled since). Call browser_screenshot first.",
    );
  }
  const point = toCssPoint(tab.shot, x, y);
  if (point === null) {
    throw new Error(`(${x}, ${y}) is outside your latest screenshot, which is ${tab.shot.width}×${tab.shot.height}.`);
  }
  return point;
}

async function elementAt(contents: WebContents, point: { x: number; y: number }): Promise<string> {
  const described = await evaluate(
    contents,
    `(() => { ${DESCRIBE_JS} return describe(document.elementFromPoint(${point.x}, ${point.y})); })()`,
  );
  return typeof described === "string" ? described : "the page";
}

async function mouseClick(contents: WebContents, x: number, y: number): Promise<void> {
  await cdp(contents, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp(contents, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(contents, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressStroke(contents: WebContents, stroke: KeyStroke): Promise<void> {
  const base = {
    key: stroke.key,
    code: stroke.code,
    windowsVirtualKeyCode: stroke.keyCode,
    nativeVirtualKeyCode: stroke.keyCode,
    modifiers: stroke.modifiers,
  };
  await cdp(contents, "Input.dispatchKeyEvent", {
    ...base,
    type: stroke.text === "" ? "rawKeyDown" : "keyDown",
    ...(stroke.text === "" ? {} : { text: stroke.text, unmodifiedText: stroke.text }),
    ...(stroke.commands.length === 0 ? {} : { commands: stroke.commands }),
  });
  await cdp(contents, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

/** 焦点模拟：后台 tab / 隐藏窗口里的页面也以为自己有焦点——聚焦、输入、:focus 样式照常 */
async function enableFocus(contents: WebContents): Promise<void> {
  await cdp(contents, "Emulation.setFocusEmulationEnabled", { enabled: true });
}

async function takeDialogs(contents: WebContents): Promise<string[]> {
  const taken = await evaluate(contents, "(window.__orbitaDialogs || []).splice(0)").catch(() => []);
  return Array.isArray(taken) ? taken.filter((item): item is string => typeof item === "string") : [];
}

function waitForStop(contents: WebContents, ms: number): Promise<boolean> {
  if (!contents.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      contents.off("did-stop-loading", done);
      resolve(false);
    }, ms);
    contents.once("did-stop-loading", done);
  });
}

async function callOn(contents: WebContents, objectId: string, declaration: string, args: unknown[] = []): Promise<unknown> {
  const result = readRecord(
    await cdp(contents, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: declaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    }),
  );
  if (result["exceptionDetails"] !== undefined) throw new Error("The page did not let the element be used.");
  return readRecord(result["result"])["value"];
}

async function evaluate(contents: WebContents, expression: string): Promise<unknown> {
  const result = readRecord(await cdp(contents, "Runtime.evaluate", { expression, returnByValue: true }));
  if (result["exceptionDetails"] !== undefined) throw new Error("The page did not respond to the script.");
  return readRecord(result["result"])["value"];
}

function readScrollState(value: unknown): ScrollState {
  const record = readRecord(value);
  return {
    top: num(record["top"]),
    left: num(record["left"]),
    height: num(record["height"]),
    width: num(record["width"]),
    viewHeight: num(record["viewHeight"]),
    viewWidth: num(record["viewWidth"]),
    page: record["page"] !== false,
    label: str(record["label"]),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(Number.isFinite(value) ? value : min), min), max);
}

// ── 页内脚本（在网页里执行，必须自包含）────────────────────────────────

/** 给模型看的元素短描述：`<button#search> "Search"` */
const DESCRIBE_JS = `
function describe(node) {
  if (!node || !node.tagName) return "the page";
  const tag = node.tagName.toLowerCase();
  const type = tag === "input" && node.type ? "[type=" + node.type + "]" : "";
  const raw = node.getAttribute("aria-label") || (tag === "input" || tag === "textarea" ? node.placeholder || node.name || "" : node.innerText || node.title || node.getAttribute("alt") || "");
  const text = String(raw).replace(/\\s+/g, " ").trim().slice(0, 60);
  return "<" + tag + type + (node.id ? "#" + node.id : "") + ">" + (text ? ' "' + text + '"' : "");
}`;

/** this = 引用的节点。滚进视口正中，取可见的第一块矩形的中心，查那一点是不是被别的元素盖住 */
const LOCATE_FN = `function () {
  ${DESCRIBE_JS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return { error: "gone" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const vw = window.innerWidth, vh = window.innerHeight;
  const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return { error: "hidden", label: describe(el) };
  const r = rects.find((c) => c.bottom > 0 && c.right > 0 && c.top < vh && c.left < vw) || rects[0];
  const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
  const root = el.getRootNode();
  const hit = typeof root.elementFromPoint === "function" ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
  const label = hit && hit.closest ? hit.closest("label") : null;
  const ok = !hit || hit === el || el.contains(hit) || hit.contains(el) || (label !== null && label.control === el);
  return { x, y, label: describe(el), covered: ok ? null : describe(hit) };
}`;

/**
 * this = 引用的节点，参数 clear。聚焦要输入的字段（引用落在包装元素上时找里面的输入框），
 * clear 时清空：输入框走原生 value setter + input 事件（React 受控组件认这条），富文本框全选
 * （随后的 insertText 替换选区）。不清空就把光标放到末尾。密码框拒绝。
 */
const PREPARE_TYPING_FN = `function (clear) {
  ${DESCRIBE_JS}
  let el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return { error: "gone" };
  if (el.tagName === "SELECT") return { kind: "select" };
  const isField = (n) => n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement;
  if (!isField(el) && !el.isContentEditable) {
    const inner = el.querySelector("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable='true']");
    if (!inner) return { error: "not-editable", label: describe(el) };
    el = inner;
  }
  if (el instanceof HTMLInputElement && el.type === "password") return { error: "password", label: describe(el) };
  if (el.disabled || el.readOnly) return { error: "readonly", label: describe(el) };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  el.focus();
  const selection = window.getSelection();
  if (isField(el)) {
    if (clear && el.value !== "") {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (!clear) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* email / number 不支持选区 */ }
    }
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return { kind: isField(el) ? "field" : "editable", label: describe(el) };
}`;

/** this = `<select>`，参数 = 选项文字。先按显示文字全等、再按 value、最后按包含；触发 input + change */
const SELECT_OPTION_FN = `function (text) {
  const want = String(text).trim().toLowerCase();
  const options = Array.from(this.options);
  const label = (o) => o.label.replace(/\\s+/g, " ").trim();
  const match =
    options.find((o) => label(o).toLowerCase() === want) ||
    options.find((o) => o.value.toLowerCase() === want) ||
    (want !== "" ? options.find((o) => label(o).toLowerCase().includes(want)) : undefined);
  if (!match || match.disabled) return { options: options.filter((o) => !o.disabled).slice(0, 40).map(label) };
  this.focus();
  this.value = match.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: label(match) };
}`;

/** 不带 ref 输入时：当前焦点（穿进 shadow root）是不是能输入的东西。iframe 放行——焦点在框里时输入会落进去 */
const FOCUSED_FIELD_JS = `(() => {
  ${DESCRIBE_JS}
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { error: "nothing" };
  if (a.tagName === "IFRAME") return { label: describe(a) };
  if (a instanceof HTMLInputElement && a.type === "password") return { error: "password", label: describe(a) };
  const editable = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a.isContentEditable;
  if (!editable) return { error: "not-editable", label: describe(a) };
  if (a.disabled || a.readOnly) return { error: "readonly", label: describe(a) };
  return { label: describe(a) };
})()`;

/** 输入之后焦点字段里现在是什么（自动补全、输入掩码会改写输入）；读不到回 null */
const FOCUSED_VALUE_JS = `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return null;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return a.value;
  return a.isContentEditable ? a.innerText : null;
})()`;

/** 这一点下面最近的可滚动容器（没有就是整页）的滚动位置 */
function scrollProbe(point: { x: number; y: number }): string {
  return `(() => {
  ${DESCRIBE_JS}
  const root = document.scrollingElement || document.documentElement;
  let n = document.elementFromPoint(${point.x}, ${point.y});
  while (n && n !== document.body && n !== document.documentElement) {
    const s = getComputedStyle(n);
    const scrollable = /(auto|scroll|overlay)/.test(s.overflowY + " " + s.overflowX) &&
      (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1);
    if (scrollable) break;
    n = n.parentElement;
  }
  const panel = n && n !== document.body && n !== document.documentElement ? n : null;
  const box = panel || root;
  return {
    top: box.scrollTop, left: box.scrollLeft, height: box.scrollHeight, width: box.scrollWidth,
    viewHeight: panel ? panel.clientHeight : innerHeight, viewWidth: panel ? panel.clientWidth : innerWidth,
    page: panel === null, label: panel ? describe(panel) : "",
  };
})()`;
}

/** agent tab 的对话框护栏（见 guardDialogs）。重复执行无副作用 */
const DIALOG_GUARD_JS = `(() => {
  if (window.__orbitaDialogs) return;
  const seen = [];
  Object.defineProperty(window, "__orbitaDialogs", { value: seen });
  const note = (kind, message) => { if (seen.length < 20) seen.push(kind + ": " + String(message === undefined ? "" : message).slice(0, 300)); };
  window.alert = function (message) { note("alert", message); };
  window.confirm = function (message) { note("confirm", message); return false; };
  window.prompt = function (message) { note("prompt", message); return null; };
})()`;
