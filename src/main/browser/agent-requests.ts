/**
 * agent 浏览器工具请求（browserRequest）→ 在会话自己的 agent tab 上执行 → 回执载荷。
 *
 * 观察走 Electron 内建的 CDP（`webContents.debugger`），不引第三方浏览器库：
 *   observe   `Accessibility.getFullAXTree` → page-outline.ts 排成大纲
 *   extract   `Runtime.evaluate` 页内取 innerText 与链接 → page-text.ts 规整分段
 *   screenshot `Page.captureScreenshot` → 缩放压 JPEG。**不用 `capturePage()`**：窗口没显示过
 *              （agent 在后台用浏览器是常态）时它报 "Current display surface not available"，
 *              后台 tab 报 UnknownVizError；CDP 截图在隐藏窗口、后台 tab 都拍得到真内容
 *              （2026-09-27 在主进程里实测五种窗口 / 视图状态）。
 * 每个 CDP 命令都有超时：卡死的页面不能把 agent 的一轮拖死。
 */
import { nativeImage, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import type { BrowserTabSummary, BrowserToolOutcome, BrowserToolRequest } from "../../shared/browser.ts";
import { availableDownloadPath } from "./downloads.ts";
import { resolveAddressOrSearch } from "./address.ts";
import { looksLikeLocalPath, resolveLocalPage } from "./local-file.ts";
import { pathToFileURL } from "node:url";
import { formatAxOutline, type AxNode } from "./page-outline.ts";
import { extractScript, formatExtract, type PageRaw } from "./page-text.ts";
import { describeDownload, pageUrl, type BrowserSandbox, type BrowserTab } from "./sandbox.ts";

/** 页面加载最多等这么久；到点不算失败，如实说「还在加载」（慢站的正文往往已经可读） */
const NAVIGATE_TIMEOUT_MS = 45_000;
/** 加载完成后再等一小会：单页应用（Scopus 就是）在 load 之后才渲染结果 */
const SETTLE_MS = 800;
const CDP_TIMEOUT_MS = 10_000;
const OBSERVE_DEFAULT_LINES = 250;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_JPEG_QUALITY = 75;
/** 导航触发了下载：再等它下完，最多 2 分钟（论文 PDF 通常几秒到几十秒） */
const DOWNLOAD_WAIT_MS = 120_000;

export async function applyBrowserRequest(
  sandbox: BrowserSandbox,
  sessionId: string,
  request: BrowserToolRequest,
): Promise<BrowserToolOutcome> {
  if (request.action === "tabs") {
    await sandbox.agentTab(sessionId);
    return { ok: true, text: describeTabs(sandbox.visibleTabs(sessionId)), card: { tabId: "", url: "", title: "" } };
  }
  // 读取类工具可以读「你的」tab（只读）；其余一律作用于自己的 agent tab
  const readsUser = "tab" in request && request.tab === "user";
  const tab = readsUser ? await sandbox.userTab() : await sandbox.agentTab(sessionId);
  const outcome = await sandbox.runOnTab(tab, async (): Promise<BrowserToolOutcome> => {
    if (!sandbox.isLive(tab)) return { ok: false, error: "The browser tab was closed. Call the tool again to reopen it." };
    const contents = tab.view.webContents;
    try {
      if (request.action === "handoff") return await handoff(sandbox, tab, contents, request);
      if (request.action === "navigate") {
        return looksLikeLocalPath(request.url)
          ? await openLocalPage(tab, contents, request.url, await sandbox.sessionRoots(sessionId))
          : await navigate(sandbox, tab, contents, request.url);
      }
      if (pageUrl(contents) === "") {
        return {
          ok: false,
          error: readsUser
            ? "The user's tab is empty — they have not opened anything in it."
            : "Your browser tab has no page yet. Call browser_navigate first (or browser_tabs to see what the user has open).",
        };
      }
      if (request.action === "observe") return await observe(tab, contents, request.maxNodes);
      if (request.action === "extract") return await extract(tab, contents, request);
      return await screenshot(tab, contents, request.save === true ? sandbox.screenshotDir(sessionId) : null);
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  // 这期间下完、还没告诉过 agent 的文件（导航以外触发的，或上一次没等到的）：附在结果末尾
  if (!outcome.ok) return outcome;
  const finished = await sandbox.takeFinishedDownloads(tab);
  return finished.length === 0 ? outcome : { ...outcome, text: [outcome.text, ...finished].join("\n") };
}

async function handoff(
  sandbox: BrowserSandbox,
  tab: BrowserTab,
  contents: WebContents,
  request: Extract<BrowserToolRequest, { action: "handoff" }>,
): Promise<BrowserToolOutcome> {
  const result = await sandbox.beginHandoff(tab, request.toolCallId, request.reason);
  const where = pageUrl(contents) === "" ? "The tab is still empty." : `Current page: ${pageUrl(contents)} (${contents.getTitle()}).`;
  const text =
    result === "done"
      ? `The user handed the browser back after: "${request.reason}". ${where} ` +
        "The page has probably changed — observe or extract it again before continuing."
      : `The user did not complete: "${request.reason}" (they cancelled, or the turn was stopped). ${where} ` +
        "Do not ask again right away; tell the user what you need and why.";
  return { ok: true, text, card: { ...card(tab, contents), handoff: result } };
}

async function navigate(
  sandbox: BrowserSandbox,
  tab: BrowserTab,
  contents: WebContents,
  input: string,
): Promise<BrowserToolOutcome> {
  const target = resolveAddressOrSearch(input);
  if (target === null) {
    return { ok: false, error: `"${input}" cannot be opened. Only http(s) addresses or search words are allowed.` };
  }
  const url = target.url;
  tab.lastStatus = null;
  const since = Date.now();
  const outcome = await loadWithin(contents, url, NAVIGATE_TIMEOUT_MS);
  // 链接指向文件：导航被下载替换，页面留在原处。loadURL 此时报 ERR_ABORTED 或 ERR_FAILED
  // （实测：被 Content-Disposition 改成下载的 PDF 报 ERR_FAILED）——不能据此判失败，
  // 先认领这次导航触发的下载、等它下完再回
  const replaced = outcome.kind === "failed" || outcome.aborted;
  const download = await claimDownload(sandbox, tab, since, replaced);
  if (download !== undefined) {
    const done = await Promise.race([download.finished, delay(DOWNLOAD_WAIT_MS).then(() => null)]);
    if (done === null) {
      return { ok: true, text: `Still downloading after ${DOWNLOAD_WAIT_MS / 1000}s: ${url} → ${download.path}`, card: card(tab, contents) };
    }
    download.reported = true;
    return { ok: true, text: describeDownload(download, done), card: card(tab, contents) };
  }
  if (outcome.kind === "failed") {
    return { ok: false, error: `Could not load ${url}: ${outcome.reason}` };
  }
  if (outcome.kind === "loaded") await delay(SETTLE_MS);
  const lines = [
    ...(target.search !== null ? [`Searched Google for "${target.search}".`] : []),
    outcome.kind === "timeout"
      ? `Still loading after ${NAVIGATE_TIMEOUT_MS / 1000}s: ${pageUrl(contents)} — the content may be partial.`
      : `Loaded ${pageUrl(contents)}${tab.lastStatus !== null ? ` (HTTP ${tab.lastStatus})` : ""}`,
    `Title: ${contents.getTitle()}`,
  ];
  if (tab.lastStatus === 401 || tab.lastStatus === 403) {
    lines.push("The site refused access — this page may need the user to sign in or be on an authorized network.");
  }
  return { ok: true, text: lines.join("\n"), card: card(tab, contents) };
}

/**
 * loadURL 的三种结局：加载完成 / 失败（DNS、连接被拒…）/ 到点还在加载。
 * ERR_ABORTED（-3）不是失败：它是这次导航被页面自己的后续导航替换了（JS 重定向、SSO 跳转），
 * 等新的那次加载落定再说。
 */
/**
 * 打开本会话目录里的本地网页（agent 写的 HTML 预览）。白名单与判定在 local-file.ts；
 * 这里只加载并报结果。file:// 页面照样在隔离 partition 里、照样无 preload。
 */
async function openLocalPage(
  tab: BrowserTab,
  contents: WebContents,
  input: string,
  roots: readonly string[],
): Promise<BrowserToolOutcome> {
  const resolved = await resolveLocalPage(input, roots);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const url = pathToFileURL(resolved.path).href;
  const outcome = await loadWithin(contents, url, NAVIGATE_TIMEOUT_MS);
  if (outcome.kind === "failed") return { ok: false, error: `Could not open ${resolved.path}: ${outcome.reason}` };
  await delay(SETTLE_MS);
  return {
    ok: true,
    text:
      `Opened ${resolved.path} in your browser tab.\nTitle: ${contents.getTitle()}\n` +
      "The user sees it only if they open the built-in browser (globe icon on the right rail) and switch to your tab — " +
      "tell them. After editing the file, call browser_navigate with the same path again to reload it.",
    card: card(tab, contents),
  };
}

/** 导航开始之后这个 tab 触发的下载；导航被替换（aborted）时下载事件可能稍晚一拍到，多等一小会 */
async function claimDownload(sandbox: BrowserSandbox, tab: BrowserTab, since: number, aborted: boolean) {
  const found = sandbox.downloadSince(tab, since);
  if (found !== undefined || !aborted) return found;
  await delay(1500);
  return sandbox.downloadSince(tab, since);
}

async function loadWithin(
  contents: WebContents,
  url: string,
  timeoutMs: number,
): Promise<{ kind: "loaded"; aborted: boolean } | { kind: "timeout"; aborted: boolean } | { kind: "failed"; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  const loaded = contents.loadURL(url).then(
    () => ({ kind: "loaded" as const, aborted: false }),
    (cause: unknown) => {
      const code = (cause as { code?: unknown }).code;
      if (code === "ERR_ABORTED") return { kind: "aborted" as const };
      return { kind: "failed" as const, reason: typeof code === "string" ? code : String(cause) };
    },
  );
  const first = await Promise.race([loaded, delay(timeoutMs).then(() => ({ kind: "timeout" as const, aborted: false }))]);
  if (first.kind !== "aborted") return first;
  const rest = Math.max(0, deadline - Date.now());
  if (!contents.isLoading()) return { kind: "loaded", aborted: true };
  return Promise.race([
    new Promise<{ kind: "loaded"; aborted: boolean }>((resolve) =>
      contents.once("did-stop-loading", () => resolve({ kind: "loaded", aborted: true })),
    ),
    delay(rest).then(() => ({ kind: "timeout" as const, aborted: true })),
  ]);
}

async function observe(tab: BrowserTab, contents: WebContents, maxNodes: number | undefined): Promise<BrowserToolOutcome> {
  const result = (await cdp(contents, "Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
  const limit = clampInt(maxNodes ?? OBSERVE_DEFAULT_LINES, 20, 600);
  const outline = formatAxOutline(result.nodes ?? [], limit);
  const text = [
    `URL: ${pageUrl(contents)}`,
    `Title: ${contents.getTitle()}`,
    outline.text === ""
      ? "The page exposes no structure yet (it may still be loading)."
      : ["<page-outline untrusted>", outline.text, "</page-outline>"].join("\n"),
    ...(outline.omitted > 0
      ? [`${outline.omitted} more lines omitted — raise maxNodes, or use browser_extract to read the text.`]
      : []),
  ].join("\n");
  return { ok: true, text, card: card(tab, contents) };
}

async function extract(
  tab: BrowserTab,
  contents: WebContents,
  request: Extract<BrowserToolRequest, { action: "extract" }>,
): Promise<BrowserToolOutcome> {
  const result = (await cdp(contents, "Runtime.evaluate", {
    expression: extractScript(request.links === true),
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails !== undefined) throw new Error("The page did not let its text be read.");
  const raw = asPageRaw(result.result?.value);
  const text = formatExtract({ url: pageUrl(contents), title: contents.getTitle() }, raw, request);
  return { ok: true, text, card: card(tab, contents) };
}

/**
 * 截图。默认只给模型看（压缩 JPEG 进上下文）；save 时另把原图（PNG，未缩放）存进会话工作台
 * `screenshots/`，结果给路径——用户想留的参考图、要递给用户看的图都从这份文件走。
 */
async function screenshot(tab: BrowserTab, contents: WebContents, saveDir: string | null): Promise<BrowserToolOutcome> {
  const shot = (await cdp(contents, "Page.captureScreenshot", { format: "png" })) as { data?: unknown };
  const png = typeof shot.data === "string" ? Buffer.from(shot.data, "base64") : null;
  let image = png === null ? null : nativeImage.createFromBuffer(png);
  if (png === null || image === null || image.isEmpty()) {
    throw new Error("The page has not rendered anything yet. Try again after it finishes loading.");
  }
  let saved = "";
  if (saveDir !== null) {
    await mkdir(saveDir, { recursive: true });
    const path = availableDownloadPath(saveDir, screenshotName(pageUrl(contents)));
    await writeFile(path, png);
    saved = ` Saved the full-resolution image to ${path}.`;
  }
  const size = image.getSize();
  if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: "good" });
  const { width, height } = image.getSize();
  return {
    ok: true,
    text:
      `Screenshot of ${pageUrl(contents)} (${contents.getTitle()}), ${width}×${height}, visible part of the page only. ` +
      (saved === ""
        ? "This screenshot was NOT saved to disk and the user only sees it inside a collapsed tool row. To show it " +
          "to the user, call browser_screenshot again with save: true — the result gives the saved path — then " +
          "call show_image with that exact path. Never guess a path."
        : `${saved.trim()} To show it to the user, call show_image with this path.`),
    image: { data: image.toJPEG(SCREENSHOT_JPEG_QUALITY).toString("base64"), mimeType: "image/jpeg" },
    card: card(tab, contents),
  };
}

/** 懒 attach 调试器；页面崩溃或被别的调试器抢走后下次调用自己重连。每条命令带超时 */
async function cdp(contents: WebContents, method: string, params?: object): Promise<unknown> {
  const debuggerApi = contents.debugger;
  if (!debuggerApi.isAttached()) {
    try {
      debuggerApi.attach("1.3");
    } catch (cause) {
      throw new Error(`Could not inspect the page (${cause instanceof Error ? cause.message : String(cause)}).`);
    }
  }
  return withTimeout(debuggerApi.sendCommand(method, params), CDP_TIMEOUT_MS, "The page did not respond in time.");
}

/** `screenshots/` 里的文件名：时间 + 站点，同一分钟里重名交给 availableDownloadPath 加序号 */
function screenshotName(url: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || host;
  } catch {
    // 空页 / 非法地址：用默认名
  }
  return `${stamp}-${host}.png`;
}

/** browser_tabs 的正文：你的 tab 与自己的 tab 各一行，标出哪个在交接中 */
export function describeTabs(tabs: readonly BrowserTabSummary[]): string {
  const lines = tabs.map((tab) => {
    const who = tab.owner.kind === "user" ? "The user's tab (read with tab: \"user\")" : "Your tab";
    const page = tab.url === "" ? "empty" : `${tab.title === "" ? "(untitled)" : tab.title} — ${tab.url}`;
    return `- ${who}: ${page}${tab.loading ? " (loading)" : ""}${tab.handoff !== undefined ? " (handed to the user)" : ""}`;
  });
  return [
    "Open browser tabs:",
    ...lines,
    "If the user already has the page you need open (often signed in through a library or proxy address), " +
      "read it with tab: \"user\" instead of starting over; to act on it, open the same address in your own tab — " +
      "the sign-in is shared.",
  ].join("\n");
}

function asPageRaw(value: unknown): PageRaw {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = typeof record["text"] === "string" ? record["text"] : "";
  const links = Array.isArray(record["links"])
    ? record["links"].filter(
        (item): item is [string, string] =>
          Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string",
      )
    : [];
  return { text, links };
}

function card(tab: BrowserTab, contents: WebContents) {
  return { tabId: tab.id, url: pageUrl(contents), title: contents.getTitle() };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(Number.isFinite(value) ? value : min), min), max);
}
