/**
 * L3（Linux 桌面 VM）的 guest 服务客户端。**不 import electron，node --test 可直接跑。**
 *
 * 对端是 guest 里的 CGI（scripts/p3-desktop/desk-cgi.sh，随镜像装进去）：
 *   POST /cgi-bin/desk，体是每行一个 `k=v`（第一行 `cmd=…`，文本一律 base64，令牌 `t=…`）
 *   回执：application/json 的 {ok:true,…} / {ok:false,error:"…"}；截图是 image/png 的原始字节。
 *
 * 为什么不是「让 guest 说 Windows 桥那套 TCP 行协议」：那套协议要 guest 侧解析 JSON
 * （文本、数组、转义），而 guest 里只有一个 POSIX sh 的 CGI。这里的 settle 是**两端都最便宜**
 * 的形状——宿主这边拼 kv 行与解析 JSON 都是一行，guest 那边 `sed -n "s/^k=//p"` 就能取字段。
 * 命令语义仍然走 `computerUseGuestCommands` 那一套（映射在 qemu.ts），所以工具层看不见差别。
 *
 * 传输为什么是 HTTP（而不是串口 / SSH / virtio-serial）：
 *   - 8250 串口没有流控，整行灌进去会丢字符（P3-1 实测），当不了控制通道；
 *   - SSH（dropbear）要宿主自带一个 ssh 客户端，每条命令一次握手，还多一层转义；
 *   - virtio-serial 要 guest 里再起一个读设备的进程，等于再造一条私有协议；
 *   - HTTP 只需要 BusyBox 的 httpd + 一个 CGI 脚本，一条现成通路：QEMU 的
 *     `hostfwd=tcp:127.0.0.1:<端口>-:8080` 把 guest 的 8080 映到宿主回环（P3-2 的 RFB 同款）。
 */
import http from "node:http";

/** 一个 guest 服务的地址与令牌（每次起 VM 现生成，见 qemu-vm.ts 的 orbita_token=） */
export interface GuestDeskChannel {
  port: number;
  token: string;
}

export interface DeskReply {
  ok: boolean;
  /** 回执里的其余扁平字段（字段名与 CGI 一一对应） */
  fields: Record<string, unknown>;
  /** ok:false 时给模型读的人话（CGI 的原话，宿主不改写） */
  error?: string;
}

export interface DeskShot {
  png: Buffer;
  width: number;
  height: number;
}

/** 请求体：一行一个 key=value。值不转义（文本都 base64 过），所以含 \n 的值必须先编码 */
function encodeBody(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}=${String(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 文本 → base64（CGI 侧 `base64 -d`）。打字与按键都走这条，绕开 shell 的引号与转义 */
export function deskText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

interface RawReply {
  status: number;
  contentType: string;
  body: Buffer;
}

/** 一条 POST。连接不上 / 超时都归一成「服务没应答」这一类，由调用方翻成人话 */
function post(channel: GuestDeskChannel, body: string, timeoutMs: number): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: channel.port,
        method: "POST",
        path: "/cgi-bin/desk",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        },
        agent: false,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error(`guest 服务 ${timeoutMs}ms 没有回应（127.0.0.1:${channel.port}）`));
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** 服务没应答时给模型/用户的那句话。**点名端口**：同一台机器上可能开着别的实例 */
export function guestUnreachableMessage(channel: GuestDeskChannel, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return (
    `L3 桌面 VM 里的服务没有应答（宿主 127.0.0.1:${channel.port}）：${reason}。` +
    "这台 VM 可能没起来、已经退出，或者 guest 里的 orbita-desk 服务没启动" +
    "（日志在镜像目录的 logs/ 下：qemu-*.log 与 serial-*.log）。"
  );
}

/** 发一条命令并解析 JSON 回执。**ok:false 不抛异常**：那是 guest 给模型的人话，要原样往上带 */
export async function deskCommand(
  channel: GuestDeskChannel,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<DeskReply> {
  const payload = { ...fields, t: channel.token };
  let raw: RawReply;
  try {
    raw = await post(channel, encodeBody(payload), timeoutMs);
  } catch (cause) {
    return { ok: false, fields: {}, error: guestUnreachableMessage(channel, cause) };
  }
  if (raw.status !== 200) {
    return { ok: false, fields: {}, error: `guest 服务回了 HTTP ${raw.status}（127.0.0.1:${channel.port}）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body.toString("utf8"));
  } catch {
    const snippet = raw.body.toString("utf8").slice(0, 200);
    return { ok: false, fields: {}, error: `guest 服务的回执不是 JSON：${snippet}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, fields: {}, error: "guest 服务的回执不是对象" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["ok"] !== true) {
    const error = record["error"];
    return {
      ok: false,
      fields: record,
      error: typeof error === "string" && error !== "" ? error : "guest 服务拒绝了这条命令（没有给原因）",
    };
  }
  return { ok: true, fields: record };
}

/**
 * PNG 的宽高。**按 IHDR 读，不信任 guest 自报的数字**：回图宽是坐标换算的唯一依据
 * （screenshotPointToNative），信错了就是「点击落在别处」。
 */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  // 89 50 4E 47 0D 0A 1A 0A
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** 要一张整屏截图。`thumb` 是 scrot 的百分比缩放（宿主按 maxWidth 算好再传） */
export async function deskScreenshot(
  channel: GuestDeskChannel,
  options: { thumbPercent?: number } = {},
  timeoutMs = 30_000,
): Promise<DeskShot> {
  const fields: Record<string, unknown> = { cmd: "shot", t: channel.token };
  if (options.thumbPercent !== undefined) fields.thumb = options.thumbPercent;
  let raw: RawReply;
  try {
    raw = await post(channel, encodeBody(fields), timeoutMs);
  } catch (cause) {
    throw new Error(guestUnreachableMessage(channel, cause));
  }
  if (raw.status !== 200) throw new Error(`guest 服务回了 HTTP ${raw.status}（要截图时）`);
  if (!raw.contentType.startsWith("image/")) {
    // CGI 出错时回的是 JSON（ok:false）——把那句话原样带出来，别只报「不是图」
    let reason = raw.body.toString("utf8").slice(0, 300);
    try {
      const parsed = JSON.parse(raw.body.toString("utf8")) as Record<string, unknown>;
      if (typeof parsed["error"] === "string") reason = parsed["error"];
    } catch {
      // 不是 JSON 就用原文片段
    }
    throw new Error(`guest 没给出截图：${reason}`);
  }
  const size = pngSize(raw.body);
  if (size === null) throw new Error("guest 回的截图不是合法 PNG（PNG 头不对）");
  return { png: raw.body, ...size };
}

/**
 * 等 guest 服务就绪：`ping` 回 ok 且桌面在（xfwm4 在跑）。
 *
 * 为什么要等「桌面在」而不只是「端口在听」：httpd 是 OpenRC 的 default 级服务，
 * 它可能比 X 会话早几秒起来。那时截图会是一张纯色的空屏——模型会拿着一张「黑屏」
 * 开始点，然后在错误的坐标上乱点。冷启到桌面实测 8–9 秒（P3-2），预算给到 90 秒。
 */
/**
 * 等桌面**画出来**（不只是进程在）。
 *
 * 判据是截图本身的体积：纯色 PNG（会话刚起来、root 窗口还没画壁纸/图标）实测 ~4.8KiB，
 * 有壁纸与面板的桌面 100KiB 以上——差一个数量级，不怕抖动。为什么不用「某个窗口存在」：
 * 面板窗口在图标还没画的时候就已经 mapping 了（实测），它答不了这个问题。
 * 等不到也不失败：返回时如实说画面还是空的，交给上层/模型自己看第一张图。
 */
export async function waitForPaintedDesktop(
  channel: GuestDeskChannel,
  options: { timeoutMs?: number; minBytes?: number; intervalMs?: number } = {},
): Promise<{ painted: boolean; bytes: number }> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const minBytes = options.minBytes ?? 20_000;
  const intervalMs = options.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  for (;;) {
    try {
      const shot = await deskScreenshot(channel, {}, 15_000);
      bytes = shot.png.length;
      if (bytes >= minBytes) return { painted: true, bytes };
    } catch {
      // 截不到图就继续等：这一步是「等到好看为止」，不是命令本身
    }
    if (Date.now() >= deadline) return { painted: false, bytes };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForDesk(
  channel: GuestDeskChannel,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ width: number; height: number; version?: string }> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let lastError = "还没试过";
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error("等 guest 服务就绪时被取消");
    const reply = await deskCommand(channel, { cmd: "ping" }, 5_000);
    if (reply.ok) {
      const width = reply.fields["w"];
      const height = reply.fields["h"];
      const desktop = reply.fields["desktop"];
      if (desktop === 1 && typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
        const version = reply.fields["version"];
        return { width, height, ...(typeof version === "string" ? { version } : {}) };
      }
      lastError = desktop === 1 ? "桌面尺寸不对" : "桌面还没起来（xfwm4 不在）";
    } else {
      lastError = reply.error ?? "没有原因";
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等不到 L3 桌面服务（${Math.round(timeoutMs / 1000)}s）：${lastError}`);
}
