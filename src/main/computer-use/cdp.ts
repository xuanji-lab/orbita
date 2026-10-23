/**
 * 沙箱内 Edge 的 CDP 通道 —— 宿主侧那一层（PR3）。
 *
 * 分工：**CDP 的 WebSocket 只在 guest 里**（桥 ↔ 同机的 Edge），宿主看不见 socket。
 * 宿主这一层的活只有三件：
 *   ① 把 `sandbox_*` 动作翻成一条 `cdp-*` 语义命令（`guestCommandReply`，一次文件往返）；
 *   ② 管「这一局沙箱里 Edge 起没起」的会话级缓存（`started`）——桥是真相，这里只是
 *      省掉每条命令前的一次 cdp-status 往返；缓存错了会自愈（命令报「没有在运行」时清掉重试一次）；
 *   ③ 上传 / 下载的文件搬运：宿主把用户文件拷进映射目录、把下载落点（映射目录的宿主侧）
 *      翻成模型能直接读的路径。二进制从不进 resp JSON。
 *
 * 失败一律回 `{ok:false, error}` 且是**给模型读的人话**：它看不见 UI，只有这句话能让它
 * 换道——CDP 不可用时必须显式说「可以改用 computer_screenshot / computer_click 像素工具」。
 * 降级永远是模型的决定，不做静默切换：静默切换会让它以为自己在点 DOM，实际在点像素。
 *
 * 为什么不做裸 CDP 转发、为什么截图走兄弟文件、为什么不给模型 cdp-eval：写在
 * shared/computer-use.ts 与 guest-bridge/Cdp.cs 的头部注释里（跟着代码走，别在仓外找）。
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  COMPUTER_USE_GUEST_DOWNLOAD_DIR,
  COMPUTER_USE_GUEST_UPLOAD_DIR,
  COMPUTER_USE_SHOT_MAX_WIDTH,
  computerUseGuestCommands,
  type ComputerUseGuestCommand,
  type ComputerUseToolOutcome,
  type ComputerUseToolRequest,
  type SandboxElement,
} from "../../shared/computer-use.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";

/**
 * 这一层真正要的那两个能力。**收窄成接口而不是直接吃 SandboxController**：
 * 回执组装是纯翻译，测试注入一个假桥就够，不必起状态机、不必碰文件协议
 * （SandboxController 结构上满足它，生产直接传实例）。
 */
export interface CdpGuest {
  guestCommandReply(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandReply>;
  guestShot(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestShotReply>;
}

/** 沙箱里的 Edge 没有在运行（桥 / 状态机都可能这么说）。用文案判定，不引错误码 */
function isNotRunning(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("没有在运行") || message.includes("没有启动");
}

/** 降级指引：只有模型看得到它，不写这句它就会重试同一个动作 */
const FALLBACK_HINT =
  "If CDP keeps failing, fall back to the pixel tools: computer_screenshot to see the sandbox desktop, " +
  "computer_click / computer_type / computer_key to drive it. They do not need Edge's debugging port.";

/** 把底层失败翻成带下一步的人话（已经带了指引就不再叠一遍） */
function browserFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("computer_screenshot") || message.includes("computer_click")) return message;
  return `${message}. ${FALLBACK_HINT}`;
}

/**
 * 一局沙箱里的浏览器会话。应用级单例（沙箱是应用级一份，不按会话分）：
 * 多个会话同时使唤它时，命令按到达顺序执行——这正是「一个沙箱」的语义。
 *
 * `outDir` 是**宿主侧**的映射输出目录（`<userData>/computer-use/out`）：上传落
 * `out/upload`、下载落 `out/downloads`，与 guest 的 `C:\orbita-out` 是同一份目录。
 */
export class CdpSession {
  private readonly guest: CdpGuest;
  private readonly outDir: string;
  /**
   * 这一局里 Edge 起没起。**只是缓存**：桥自己知道真相（cdp-status）。
   * 缓存过期（沙箱重启 / 用户关掉了 Edge 窗口）时，命令会报「没有在运行」，
   * call() 清掉它重试一次——所以这里不需要任何生命周期钩子。
   */
  private started = false;

  constructor(guest: CdpGuest, outDir: string) {
    this.guest = guest;
    this.outDir = outDir;
  }

  /** 起 Edge（幂等，桥那边已起就直接回现状）。只有 navigate 会走它 */
  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    const status = await this.guest.guestCommandReply(computerUseGuestCommands.cdpStatus, {});
    if (!status.ok) throw new Error(status.error);
    if (status.resp.running === true) {
      this.started = true;
      return;
    }
    const start = await this.guest.guestCommandReply(computerUseGuestCommands.cdpStart, {});
    if (!start.ok) throw new Error(start.error);
    this.started = true;
  }

  /** 要求已经打开过页面：任何非导航命令都先过这一关（不去替模型起一个 about:blank） */
  private async ensureOpen(): Promise<void> {
    if (this.started) return;
    const status = await this.guest.guestCommandReply(computerUseGuestCommands.cdpStatus, {});
    if (!status.ok) throw new Error(status.error);
    if (status.resp.running === true) {
      this.started = true;
      return;
    }
    throw new Error(
      "沙箱里的浏览器还没有打开任何页面。先调用 sandbox_navigate 打开一个网址——它会把 Edge 拉起来，"
      + "之后 sandbox_observe / sandbox_click 才能用。CDP 起不来时再退回 computer_screenshot 像素工具",
    );
  }

  private async send(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await this.guest.guestCommandReply(command, fields);
    if (!resp.ok) throw new Error(resp.error);
    return resp.resp;
  }

  /**
   * 发一条 CDP 命令。
   *   mode "nav"  → 没起就先 cdp-start（模型不需要知道有这一步）
   *   mode "open" → 没起就报「先 sandbox_navigate」（不替模型起空白页）
   * 命令报「没有在运行」时清缓存重试**一次**：场景是沙箱重启 / 用户关掉了 Edge 窗口，
   * 缓存还是旧的；不重试的话模型会收到一条本可以自愈的失败。
   */
  async call(
    command: ComputerUseGuestCommand,
    fields: Record<string, unknown>,
    mode: "nav" | "open",
  ): Promise<Record<string, unknown>> {
    if (mode === "nav") await this.ensureStarted();
    else await this.ensureOpen();
    try {
      return await this.send(command, fields);
    } catch (cause: unknown) {
      if (!isNotRunning(cause)) throw cause;
      this.started = false;
      if (mode === "nav") await this.ensureStarted();
      else await this.ensureOpen();
      return await this.send(command, fields);
    }
  }

  /** 页面截图（走兄弟 .jpg，回执里只有文件名；字节经 IPC 送出去是 base64） */
  async shot(maxWidth: number): Promise<{ jpeg: Uint8Array; resp: Record<string, unknown> }> {
    await this.ensureOpen();
    const result = await this.guest.guestShot(computerUseGuestCommands.cdpShot, { maxWidth });
    if (!result.ok) throw new Error(result.error);
    return { jpeg: result.jpeg, resp: result.resp };
  }

  /**
   * 上传前的搬运：把宿主文件拷进映射目录的 upload/ 子目录，回 guest 侧绝对路径。
   *
   * 为什么由宿主搬而不是直接用 guest 路径：`DOM.setFileInputFiles` 能读 guest 里任意文件，
   * 桥的白名单只认 `C:\orbita-out\upload\`；宿主的映射目录就是那个目录，所以「拷进去」
   * 同时完成了白名单与「模型给的宿主任意路径」这两件事。文件名带时间戳，避免同名覆盖。
   */
  async prepareUpload(hostPath: string): Promise<{ guestPath: string; fileName: string }> {
    let info;
    try {
      info = await stat(hostPath);
    } catch {
      throw new Error(`找不到要上传的文件：${hostPath}`);
    }
    if (!info.isFile()) throw new Error(`这不是一个文件：${hostPath}`);
    if (info.size === 0) throw new Error(`这个文件是空的（0 字节）：${hostPath}`);

    const base = win32.basename(hostPath);
    const safe = base.replace(/[\\/:*?"<>|]/g, "_");
    if (safe === "") throw new Error(`文件名不可用：${hostPath}`);
    const name = `${Date.now()}-${safe}`;
    const dir = join(this.outDir, "upload");
    await mkdir(dir, { recursive: true });
    await copyFile(hostPath, join(dir, name));
    return { guestPath: `${COMPUTER_USE_GUEST_UPLOAD_DIR}\\${name}`, fileName: base };
  }

  /**
   * 下载前的落点：映射目录的 downloads/<标签>/。`sub` 只当**子目录名**用（模型不该
   * 决定 guest 绝对路径），非法字符一律回落到时间戳。
   */
  async prepareDownload(sub: string | undefined): Promise<{ guestDir: string; hostDir: string }> {
    const label = sub !== undefined && /^[A-Za-z0-9._-]{1,40}$/.test(sub) ? sub : String(Date.now());
    const hostDir = join(this.outDir, "downloads", label);
    await mkdir(hostDir, { recursive: true });
    return { guestDir: `${COMPUTER_USE_GUEST_DOWNLOAD_DIR}\\${label}`, hostDir };
  }

  /**
   * 把 guest 回执里的文件名翻成宿主绝对路径。文件名是**不可信输入**（网页决定它叫什么）：
   * 只取末段、拒掉 `..`，拼不出来的就跳过——与截图文件名同一类闸门。
   *
   * 映射目录同步有一点点延迟，所以这里轮询到文件出现（最多 5 秒）；等不到也把
   * 理论路径回给模型（guest 已经确认写进去了，只是宿主这侧还没看见）。
   */
  async resolveDownloads(hostDir: string, names: string[]): Promise<string[]> {
    const paths: string[] = [];
    const deadline = Date.now() + 5_000;
    for (const raw of names) {
      const name = win32.basename(raw);
      if (name === "" || name === "." || name === ".." || name.includes("..")) continue;
      const full = join(hostDir, name);
      for (;;) {
        try {
          const info = await stat(full);
          if (info.isFile()) break;
        } catch {
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      paths.push(full);
    }
    // 回执里的文件名一个都不合法时，退回目录清单（至少让模型知道下载目录在哪）
    if (paths.length === 0) {
      const listed = await readdir(hostDir).catch(() => [] as string[]);
      for (const name of listed) paths.push(join(hostDir, name));
    }
    return paths;
  }
}

// ── 动作翻译：sandbox_* → cdp-* → 给模型读的正文 ─────────────────────────────

/**
 * `sandbox_*` 动作的宿主侧实现。只读动作（observe / extract / wait / screenshot）
 * 与写动作（click / type / upload / download）都走这里；权限分档在工具层
 * （shared/permission.ts），到这一层已经决定过了。
 *
 * PR4 的确认卡接在工具层与 broker 之间（写动作的 request 里已经带 element 人话），
 * 这一层不需要知道「有没有人按过确认」。
 */
export async function applySandboxBrowserRequest(
  cdp: CdpSession,
  request: ComputerUseToolRequest,
): Promise<ComputerUseToolOutcome> {
  try {
    switch (request.action) {
      case "sandbox-navigate": {
        const resp = await cdp.call(
          computerUseGuestCommands.cdpNav,
          {
            url: request.url,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          },
          "nav",
        );
        const url = text(resp["url"]);
        const title = text(resp["title"]);
        const warning = text(resp["warning"]);
        const ms = number(resp["ms"]);
        return {
          ok: true,
          text:
            `Opened ${url === "" ? request.url : url}${title === "" ? "" : ` ("${title}")`} in the sandbox browser` +
            `${ms === undefined ? "" : ` in ${ms} ms`}. ${warning === "" ? "" : `${warning} `}` +
            "Call sandbox_observe to see what is on the page; its selectors stay valid until the page navigates. " +
            "This browser is the isolated sandbox one — it has none of the user's sign-in state and no CAPTCHA help.",
        };
      }
      case "sandbox-observe": {
        const resp = await cdp.call(
          computerUseGuestCommands.cdpObserve,
          request.maxElements === undefined ? {} : { maxElements: request.maxElements },
          "open",
        );
        const elements = parseElements(resp["elements"]);
        const body = text(resp["text"]).trim();
        const total = number(resp["totalTextLength"]);
        const truncated = resp["truncated"] === true;
        const list =
          elements.length === 0
            ? "(no interactive elements matched — the page may still be loading: sandbox_wait for a selector, " +
              "or sandbox_screenshot to look at it)"
            : elements.map(formatElement).join("\n");
        return {
          ok: true,
          text:
            `URL: ${text(resp["url"])}\nTitle: ${text(resp["title"])}\n\n` +
            `${body === "" ? "(the page has no visible text)" : body}\n\n` +
            `Interactive elements (${elements.length}):\n${list}` +
            (truncated && total !== undefined ? `\n\n[page text truncated: showing ${body.length} of ${total} characters]` : "") +
            "\n\nPass a selector to sandbox_click / sandbox_type / sandbox_extract. Selectors are positional and " +
            "expire when the page navigates — observe again after a navigation.",
        };
      }
      case "sandbox-click": {
        const resp = await cdp.call(computerUseGuestCommands.cdpClick, { selector: request.selector }, "open");
        const tag = text(resp["tag"]);
        const label = text(resp["text"]);
        return {
          ok: true,
          text:
            `Clicked ${tag === "" ? "the element" : `<${tag}>`}${label === "" ? "" : ` "${label}"`} ` +
            `(selector ${request.selector}) at (${number(resp["x"]) ?? "?"}, ${number(resp["y"]) ?? "?"}). ` +
            `The page is now at ${text(resp["url"])}. Call sandbox_observe to see what changed — ` +
            "selectors from before the click may no longer match.",
        };
      }
      case "sandbox-type": {
        const resp = await cdp.call(
          computerUseGuestCommands.cdpType,
          {
            selector: request.selector,
            text: request.text,
            submit: request.submit === true,
            clear: request.clear !== false,
          },
          "open",
        );
        const value = text(resp["value"]);
        const submitted = resp["submitted"] === true;
        return {
          ok: true,
          text:
            `Typed ${request.text.length} character(s) into ${request.selector}` +
            `${request.clear === false ? " (appended, the old value was kept)" : ""}. ` +
            `The field now holds "${value.length > 120 ? `${value.slice(0, 120)}…` : value}".` +
            (submitted ? " Enter was pressed to submit." : "") +
            " Call sandbox_observe (or sandbox_wait for the next page) to see the result.",
        };
      }
      case "sandbox-extract": {
        const resp = await cdp.call(
          computerUseGuestCommands.cdpExtract,
          request.selector === undefined ? {} : { selector: request.selector },
          "open",
        );
        const body = text(resp["text"]);
        const total = number(resp["totalLength"]);
        const truncated = resp["truncated"] === true;
        const warning = text(resp["warning"]);
        if (body === "" && warning === "" && request.selector === undefined) {
          return { ok: true, text: "The page has no visible text (it may still be loading — try sandbox_wait)." };
        }
        return {
          ok: true,
          text:
            (body === "" ? "(no text matched)" : body) +
            (warning === "" ? "" : `\n\n[${warning}]`) +
            (total === undefined
              ? ""
              : `\n\n[${total} character(s) in total${truncated ? `, showing the first ${body.length}` : ""}]`),
        };
      }
      case "sandbox-wait": {
        const fields: Record<string, unknown> = {};
        if (request.selector !== undefined) fields["selector"] = request.selector;
        if (request.ms !== undefined) fields["ms"] = request.ms;
        if (request.timeoutMs !== undefined) fields["timeoutMs"] = request.timeoutMs;
        const resp = await cdp.call(computerUseGuestCommands.cdpWait, fields, "open");
        const appeared = resp["appeared"] === true;
        const waitedMs = number(resp["waitedMs"]);
        const waited = waitedMs === undefined ? "a while" : `${waitedMs} ms`;
        if (request.selector === undefined) {
          return { ok: true, text: `Waited ${waited}. The page has had time to settle — sandbox_observe it now.` };
        }
        if (appeared) {
          return {
            ok: true,
            text: `Element ${request.selector} appeared after ${waited}. Call sandbox_observe to get its selector and neighbours.`,
          };
        }
        return {
          ok: true,
          text:
            `Element ${request.selector} did not appear within ${waited}. Either the selector is wrong ` +
            "(sandbox_observe shows the ones that exist) or the page needs more time (call sandbox_wait again, " +
            "or sandbox_screenshot to see what is on screen).",
        };
      }
      case "sandbox-screenshot": {
        const maxWidth = request.maxWidth ?? COMPUTER_USE_SHOT_MAX_WIDTH;
        const shot = await cdp.shot(maxWidth);
        const width = number(shot.resp["width"]);
        const height = number(shot.resp["height"]);
        const nativeWidth = number(shot.resp["nativeWidth"]);
        const nativeHeight = number(shot.resp["nativeHeight"]);
        if (width === undefined || height === undefined || nativeWidth === undefined || nativeHeight === undefined) {
          throw new Error("cdp-shot 的回执缺尺寸字段（width / height / nativeWidth / nativeHeight）");
        }
        return {
          ok: true,
          text:
            `Screenshot of the page at ${text(shot.resp["url"])}${text(shot.resp["title"]) === "" ? "" : ` ("${text(shot.resp["title"])}")`}: ` +
            `the image is ${width}×${height}, the page viewport is ${nativeWidth}×${nativeHeight} CSS pixels. ` +
            "Prefer sandbox_observe / sandbox_click (DOM level) over reading things off the image; " +
            "computer_click can also hit the Edge window as a last resort, but it has no idea what is under the pointer.",
          shot: {
            data: Buffer.from(shot.jpeg).toString("base64"),
            width,
            height,
            nativeWidth,
            nativeHeight,
          },
        };
      }
      case "sandbox-upload": {
        const prepared = await cdp.prepareUpload(request.path);
        const resp = await cdp.call(
          computerUseGuestCommands.cdpUpload,
          { selector: request.selector, path: prepared.guestPath },
          "open",
        );
        return {
          ok: true,
          text:
            `Attached "${prepared.fileName}" to the file input ${request.selector} ` +
            `(the page sees it as "${text(resp["fileName"])}"). ` +
            "The file was copied into the sandbox's mapped folder first — the original on the host is untouched. " +
            "If the page needs a submit button pressed, do that with sandbox_click.",
        };
      }
      case "sandbox-download": {
        const target = await cdp.prepareDownload(request.dir);
        const resp = await cdp.call(
          computerUseGuestCommands.cdpDownload,
          { selector: request.selector, dir: target.guestDir },
          "open",
        );
        const names = stringArray(resp["files"]);
        const paths = await cdp.resolveDownloads(target.hostDir, names);
        if (paths.length === 0) {
          return {
            ok: true,
            text:
              `Clicked ${request.selector} but no file landed in the download folder (${target.hostDir}) within 20 s. ` +
              "The link may open a page instead of downloading one — sandbox_observe it, or check sandbox_screenshot.",
          };
        }
        return {
          ok: true,
          text:
            `Downloaded ${paths.length} file(s) by clicking ${request.selector}. They are on the host at:\n` +
            paths.map((path) => `- ${path}`).join("\n") +
            "\nUse them directly with your file tools (read_pdf, read, …).",
        };
      }
      default:
        return {
          ok: false,
          error: `内部错误：${request.action} 不是 sandbox_* 浏览器动作，不该进 CDP 通道。`,
        };
    }
  } catch (cause: unknown) {
    return { ok: false, error: browserFailure(cause) };
  }
}

// ── resp 字段的宽容读取（guest 是扁平小对象，字段缺了不该让整条命令崩）──────────

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** cdp-observe 的 elements：字段对不上就跳过（不同桥版本不应该让整个 observe 失效） */
function parseElements(value: unknown): SandboxElement[] {
  if (!Array.isArray(value)) return [];
  const elements: SandboxElement[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const selector = text(record["selector"]);
    if (selector === "") continue;
    elements.push({
      selector,
      tag: text(record["tag"]),
      text: text(record["text"]),
      x: number(record["x"]) ?? 0,
      y: number(record["y"]) ?? 0,
      role: text(record["role"]),
      editable: record["editable"] === true,
    });
  }
  return elements;
}

function formatElement(element: SandboxElement): string {
  const role = element.role === "" ? "" : ` role=${element.role}`;
  const editable = element.editable ? " [editable]" : "";
  const label = element.text === "" ? "" : ` "${element.text}"`;
  return `- ${element.tag}${role}${editable}: selector ${element.selector}${label} at (${element.x}, ${element.y})`;
}
