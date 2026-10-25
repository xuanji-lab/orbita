/**
 * guest 桥的命令客户端 —— 两条通道，一条语义。
 *
 * 0.8.0 起 **TCP 优先**（桥在 bridge.json 里通告 port / token / ipv4）：宿主主动连进 guest，
 * 一条连接复用到底，一次往返毫秒级。为什么换：文件协议每一跳的传播实测 2.9–7.5 秒
 * （2026-10-25 真机计量，guest 内部处理只有毫秒级），于是每个 sandbox_* 工具都天然背 8–10 秒
 * 的下限；而同一天的隔离沙箱实验里宿主→guest 的 TCP 是握手 30ms、小包中位 1ms、64KB 往返 2–6ms，
 * 两侧都不用动防火墙。
 *
 * 文件协议是**回退通道**，一条行为都没删（老桥只有它）：
 *   宿主写 out/cmd/<名字>.req.json（tmp+rename 原子写）→ 桥轮询执行 →
 *   写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件，先于 resp 落盘）→ 删 req。
 *   宿主读到响应后负责清理 resp / jpg。名字里带递增序号，桥按名字排序处理。
 *
 * 两条通道的回执形状完全一样（都过同一个 parseResp / 同一套错误文案），调用方一个字都不用改。
 *
 * 注意 host→guest 方向开机有 ~20 秒热身期（实测）：桥通告了不代表命令通道已通，
 * TCP 也可能连不上（那就会回退文件协议），就绪握手（pingGuest）必须在截图之前完成
 * （sandbox.ts 的启动链保证这个顺序）。
 */
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, win32 } from "node:path";
import {
  BRIDGE_INFO_FILE,
  BRIDGE_TCP_CONNECT_TIMEOUT_MS,
  BRIDGE_TCP_COOLDOWN_MS,
  bridgeTcpHello,
  COMPUTER_USE_CMD_DIR,
  computerUseGuestCommands,
  computerUseGuestTimeoutMs,
  GUEST_COMMAND_TIMEOUT_MS,
  type GuestTcpChannel,
} from "../../shared/computer-use.ts";
import { parseBridgeInfo } from "./bridge-ready.ts";

export interface GuestScreenshot {
  jpeg: Uint8Array;
  /** 回图尺寸（按 maxWidth 缩过的那张图） */
  width: number;
  height: number;
  /** 沙箱物理屏尺寸 */
  nativeWidth: number;
  nativeHeight: number;
}

/**
 * 一条「带 JPEG 兄弟文件」的命令的回执（像素截图与页面截图共用同一条通道）。
 * resp 是桥给的**其余扁平字段**（url / title / 尺寸…），调用方按自己的命令验字段。
 */
export interface GuestShot {
  jpeg: Uint8Array;
  resp: Record<string, unknown>;
}

/**
/**
 * resp 里的 jpeg 字段必须是**纯文件名**（`cmd-000001.jpg` 这种），不许带目录、不许有 `..`。
 *
 * 为什么必须有这一关：resp 是 guest 进程写的内容，是整条协议里**唯一的不可信输入**。
 * 直接 `join(cmdDir, jpegName)` 的话，被攻陷 / 被换掉的 guest 回一个
 * `..\..\Users\<me>\.ssh\id_ed25519`，宿主就会替它把任意文件读出来、base64 之后
 * 经 IPC 送进 renderer（2026-10-14 审查意见 A）。
 *
 * 用 `win32.basename` 而不是 posix 的：宿主的路径规则是 Windows，`..\..\x` 在 posix
 * 眼里只是一个普通文件名（不含 `/`），只有 win32 才认反斜杠。
 */
export function isPlainScreenshotFileName(name: string): boolean {
  return name !== "" && name === win32.basename(name) && !name.includes("..");
}

/**
 * 桥不应答时的放弃线已上提到 shared/computer-use.ts，**按命令类分两条**：
 * 像素 / 桌面命令 GUEST_COMMAND_TIMEOUT_MS（45s），浏览器命令 COMPUTER_USE_CDP_TIMEOUT_MS（70s）。
 * 取哪条由 computerUseGuestTimeoutMs 决定（agent 侧的 broker 兜底也按它排，注释与理由在那边）。
 */

/** 等响应文件的轮询节奏（映射文件夹同步即时，这只是读盘节奏） */
const RESP_POLL_INTERVAL_MS = 200;

/** 进程内单调递增序号（每次沙箱会话 out/cmd 会被清空，不会撞上一局的文件） */
let commandSeq = 0;

/**
 * 新一局沙箱开始：命令序号归零。
 *
 * 为什么必须有它：guest 桥的轮询是**直探下一个序号的文件名**（`cmd-<6 位>.req.json`，
 * 见 guest-bridge/Program.cs 的 PollOnce），它从 1 起数。宿主计数器要是接着上一局的
 * 数字往下走（模块级变量不随沙箱重启归零），桥的快路径就永远落空，得等 4 秒一次的
 * 全量枚举对齐——那正是「开机第一条命令平白慢 4 秒」。沙箱每次 start() 都把 out/cmd
 * 整个删掉（sandbox.ts），所以序号回到 1 不会撞上任何旧文件。
 */
export function resetGuestCommandSeq(): void {
  commandSeq = 0;
  closeTcpState();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Resp = Record<string, unknown>;

function parseResp(raw: string): Resp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 半截文件（桥是原子写，极小概率撞上同步抖动）——下轮再读
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (typeof (parsed as Resp).ok !== "boolean") return null;
  return parsed as Resp;
}

// ── TCP 命令通道（桥 0.8.0）：优先走它，任何一步失败都回退文件协议 ────────────
//
// 协议与常量在 shared/computer-use.ts（bridgeTcpFields / bridgeTcpHello）。这里的职责只有：
//   1. 从 out/bridge.json 读出通道（老桥没有 port → null → 纯文件协议，行为与改动前一致）；
//   2. 多网卡逐个连（每个 1.5s 含握手），成功就复用这条连接；
//   3. 失败进 10s 冷却，这期间直接走文件协议——不在每条命令上反复撞超时；
//   4. 把「已发出去但没等到回执」与「根本没发出去」分开：前者**不许重放**（一次点击不能
//      变成两下），后者可以安全、透明地回退。

/** 一条在飞请求的等待者 */
interface PendingTcpRequest {
  resolve: (message: Record<string, unknown>) => void;
  reject: (cause: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * TCP 失败的三种形态，区别只在一个问题：**这条命令发出去了吗**。
 *   undispatched —— 没发出去（连不上 / 握手被拒 / 写失败）：可以安全地回退文件协议；
 *   timeout      —— 发出去了但没等到回执：不许重放，报一句能照着做的话并进入冷却；
 *   closed       —— 发出去了、连接断了：同上。
 */
type TcpFailureKind = "undispatched" | "timeout" | "closed";

class TcpFailure extends Error {
  readonly kind: TcpFailureKind;

  constructor(kind: TcpFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

type TcpAttempt =
  | { kind: "reply"; resp: Resp; jpegInline?: Uint8Array }
  | { kind: "fallback"; reason: string }
  | { kind: "failed"; error: Error };

/** 一条复用到底的连接（一行一条 JSON；回执按 id 对号，多请求可以同时在飞） */
class GuestTcpLink {
  readonly socket: Socket;
  private buffer = "";
  private readonly pending = new Map<number, PendingTcpRequest>();
  private helloWaiter: PendingTcpRequest | null = null;
  private closedReason: string | null = null;
  private nextId = 0;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (cause: Error) => this.fail(`连接出错：${cause.message}`));
    socket.on("close", () => this.fail("连接被关"));
  }

  /** 首行 hello + token，等桥回 hello-ok；失败一律算「没发出去」（此时还没有命令在飞） */
  async handshake(token: string, timeoutMs: number): Promise<void> {
    if (this.closedReason !== null) throw new TcpFailure("undispatched", this.closedReason);
    const reply = this.waitForHello(timeoutMs);
    try {
      this.socket.write(`${JSON.stringify({ t: bridgeTcpHello.type, token })}\n`);
    } catch (cause) {
      throw new TcpFailure("undispatched", cause instanceof Error ? cause.message : String(cause));
    }
    const message = await reply;
    const type = message["t"];
    if (type === bridgeTcpHello.ok) return;
    throw new TcpFailure(
      "undispatched",
      type === bridgeTcpHello.fail ? "桥回 hello-fail（令牌不符）" : `桥的握手回执异常：${String(type)}`,
    );
  }

  request(
    command: string,
    fields: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) return Promise.reject(new TcpFailure("undispatched", this.closedReason));
    const id = (this.nextId += 1);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 读超时：连接已经不可信，扭断它；这条命令**不重放**
        this.pending.delete(id);
        reject(new TcpFailure("timeout", `读回执超时（${timeoutMs}ms）`));
        this.destroy(`读回执超时 ${timeoutMs}ms`);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ id, command, fields })}\n`);
      } catch (cause) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new TcpFailure("undispatched", cause instanceof Error ? cause.message : String(cause)));
        this.destroy("写入失败");
      }
    });
  }

  close(): void {
    this.destroy("客户端关闭连接");
  }

  private waitForHello(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        reject(new TcpFailure("undispatched", `握手超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.helloWaiter = { resolve, reject, timer };
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line !== "") this.onLine(line);
    }
    // 单帧上限：被换掉的 guest 不该能把宿主的主进程内存吃掉
    if (this.buffer.length > 16 * 1024 * 1024) this.destroy("单帧超过 16MB");
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // 不是合法 JSON 的行只能忽略（断帧由超时兜底）
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    const id = message["id"];
    if (typeof id === "number") {
      const wait = this.pending.get(id);
      if (wait !== undefined) {
        this.pending.delete(id);
        clearTimeout(wait.timer);
        wait.resolve(message);
        return;
      }
    }
    const hello = this.helloWaiter;
    if (hello !== null) {
      this.helloWaiter = null;
      clearTimeout(hello.timer);
      hello.resolve(message);
    }
  }

  private destroy(reason: string): void {
    try {
      this.socket.destroy();
    } catch {
      // 已经断了
    }
    this.fail(reason);
  }

  /** 连接不可用了：所有在飞请求都按「发出去了但没回执」结算 */
  private fail(reason: string): void {
    if (this.closedReason === null) this.closedReason = reason;
    for (const [id, wait] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(wait.timer);
      wait.reject(new TcpFailure("closed", reason));
    }
    const hello = this.helloWaiter;
    if (hello !== null) {
      this.helloWaiter = null;
      clearTimeout(hello.timer);
      hello.reject(new TcpFailure("undispatched", reason));
    }
  }
}

/** 一局沙箱的通道状态（resetGuestCommandSeq / 换 outDir 时整体作废） */
interface TcpChannelState {
  outDir: string;
  channel: GuestTcpChannel | null;
  link: GuestTcpLink | null;
  cooldownUntil: number;
  /** 上一次打出来的通道日志（同一个结论不重复刷屏）；空串 = 还没打过 */
  loggedChannel: string;
}

let tcpState: TcpChannelState | null = null;

function closeTcpState(): void {
  if (tcpState !== null && tcpState.link !== null) tcpState.link.close();
  tcpState = null;
}

async function readTcpChannel(outDir: string): Promise<GuestTcpChannel | null> {
  try {
    const raw = await readFile(join(outDir, BRIDGE_INFO_FILE), "utf8");
    return parseBridgeInfo(raw)?.tcp ?? null;
  } catch {
    return null; // 桥还没写通告 / 映射目录还没同步：当老桥，走文件协议
  }
}

/**
 * 取（或建）通道状态。`channel` 为空时**每次都重读 bridge.json**：那是宿主本地的一张小文件，
 * 代价可忽略，而好处是桥重启换了端口 / 老桥升级成 0.8.0 后下一条命令就能用上 TCP。
 */
async function channelStateFor(outDir: string): Promise<TcpChannelState> {
  if (tcpState === null || tcpState.outDir !== outDir) {
    closeTcpState();
    tcpState = { outDir, channel: null, link: null, cooldownUntil: 0, loggedChannel: "" };
  }
  const state = tcpState;
  if (state.channel === null) state.channel = await readTcpChannel(outDir);
  return state;
}

/** 通道选择日志：一行，同样的结论不重复打（排障时一眼看出走的哪条） */
function logChannel(state: TcpChannelState, line: string): void {
  if (state.loggedChannel === line) return;
  state.loggedChannel = line;
  console.log(`[computer-use] 通道：${line}`);
}

/** 连一个地址（含 TCP 握手）；超时 / 出错都回 null（换下一个地址） */
function connectOnce(address: string, port: number, timeoutMs: number): Promise<Socket | null> {
  return new Promise<Socket | null>((resolve) => {
    const socket = connect({ host: address, port });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (value: Socket | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.removeListener("error", onError);
      if (value === null) socket.destroy();
      resolve(value);
    };
    const onError = (): void => finish(null);
    socket.once("error", onError);
    socket.once("connect", () => {
      // 建连成功之后错误交给 GuestTcpLink；这里留一个空监听，保证 await 期间不会因无监听而抛
      socket.on("error", () => {});
      finish(socket);
    });
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** 按 bridge.json 的 ipv4 顺序逐个连（每个 1.5s 含握手）；全失败回原因，调用方回退文件协议 */
async function connectTcpLink(
  channel: GuestTcpChannel,
): Promise<{ link: GuestTcpLink; address: string } | { reason: string }> {
  const reasons: string[] = [];
  for (const address of channel.ipv4) {
    const socket = await connectOnce(address, channel.port, BRIDGE_TCP_CONNECT_TIMEOUT_MS);
    if (socket === null) {
      reasons.push(`${address}:${channel.port} 连不上`);
      continue;
    }
    const link = new GuestTcpLink(socket);
    try {
      await link.handshake(channel.token, BRIDGE_TCP_CONNECT_TIMEOUT_MS);
      return { link, address: `${address}:${channel.port}` };
    } catch (cause) {
      link.close();
      const why = cause instanceof Error ? cause.message : String(cause);
      reasons.push(`${address}:${channel.port} ${why}`);
    }
  }
  return { reason: reasons.length === 0 ? "bridge.json 的 ipv4 是空的" : reasons.join("；") };
}

function parseTcpResp(value: unknown): Resp | null {
  if (typeof value !== "object" || value === null) return null;
  if (typeof (value as Resp).ok !== "boolean") return null;
  return value as Resp;
}

function decodeJpegInline(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** 进冷却：这一小段时间所有命令直接走文件协议（理由见 BRIDGE_TCP_COOLDOWN_MS） */
function enterCooldown(state: TcpChannelState): void {
  state.cooldownUntil = Date.now() + BRIDGE_TCP_COOLDOWN_MS;
  state.channel = null; // 下次重读 bridge.json：桥重启会换端口 / 换令牌
}

function tcpUnavailable(state: TcpChannelState, reason: string): TcpAttempt {
  enterCooldown(state);
  logChannel(state, `文件（TCP 不可用：${reason}；${Math.round(BRIDGE_TCP_COOLDOWN_MS / 1000)}s 内不再试）`);
  return { kind: "fallback", reason };
}

/**
 * 「发出去了但没回执」那句人话。超时沿用文件协议同一套文案（下一步该怎么试完全一样）；
 * 连接断了则说清「下一条命令起自动走文件通道」——模型看不见 UI，一句话得能照着做。
 */
export function tcpChannelFailureMessage(command: string, failure: TcpFailure, timeoutMs: number): string {
  if (failure.kind === "timeout") return guestTimeoutMessage(command, timeoutMs);
  return (
    `沙箱的命令通道中断了（${command} 走 TCP 时${failure.message}）——` +
    "下一条命令起会自动走文件通道；可以直接重试，或先用 computer_screenshot 确认桌面还在不在"
  );
}

async function sendGuestCommandOverTcp(
  outDir: string,
  command: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<TcpAttempt> {
  const state = await channelStateFor(outDir);
  const channel = state.channel;
  if (channel === null) {
    logChannel(state, "文件（TCP 不可用：bridge.json 里没有 port / token / ipv4）");
    return { kind: "fallback", reason: "老桥（bridge.json 无 TCP 字段）" };
  }
  if (Date.now() < state.cooldownUntil) {
    const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    logChannel(state, `文件（TCP 冷却中，${left}s 后再试）`);
    return { kind: "fallback", reason: "TCP 冷却中" };
  }
  if (state.link === null) {
    const opened = await connectTcpLink(channel);
    if ("reason" in opened) return tcpUnavailable(state, opened.reason);
    state.link = opened.link;
    logChannel(state, `TCP ${opened.address}`);
  }
  const link = state.link;
  try {
    const message = await link.request(command, fields, timeoutMs);
    const resp = parseTcpResp(message["resp"]);
    if (resp === null) throw new TcpFailure("closed", "回执缺 resp 或 ok 字段");
    const jpegInline = decodeJpegInline(message["jpegBase64"]);
    return { kind: "reply", resp, ...(jpegInline === undefined ? {} : { jpegInline }) };
  } catch (cause) {
    const failure =
      cause instanceof TcpFailure
        ? cause
        : new TcpFailure("closed", cause instanceof Error ? cause.message : String(cause));
    state.link = null;
    link.close();
    enterCooldown(state);
    if (failure.kind === "undispatched") {
      // 没发出去：这条命令可以安全地走文件协议（上层拿到的结果与纯文件协议完全一样）
      logChannel(state, `文件（TCP 不可用：${failure.message}；${Math.round(BRIDGE_TCP_COOLDOWN_MS / 1000)}s 内不再试）`);
      return { kind: "fallback", reason: failure.message };
    }
    // 已经发出去了：**不重放**——宁可报一次错，也不能让一次点击悄悄变成两下
    logChannel(
      state,
      `文件（${command} 的 TCP 回执丢了：${failure.message}；下一条命令起 ${Math.round(BRIDGE_TCP_COOLDOWN_MS / 1000)}s 内走文件）`,
    );
    return { kind: "failed", error: new Error(tcpChannelFailureMessage(command, failure, timeoutMs)) };
  }
}

/**
 * 一次命令往返的结果。`file` 非空 = 走的是文件协议，调用方按原有纪律读兄弟文件与清理；
 * `file` 为空 = 走的是 TCP，截图已经在 `jpegInline` 里（映射目录里没有任何残留）。
 */
interface GuestReply {
  resp: Resp;
  /** TCP 回执里内联的 JPEG（文件协议没有：它走同名 .jpg 兄弟文件） */
  jpegInline?: Uint8Array;
  /** 文件协议路径的清理信息；TCP 路径为 null */
  file: { cmdDir: string; baseName: string } | null;
}

/**
 * **TCP 优先，失败回退文件协议**。两条通道拿到的 resp 形状完全一样，上层感知不到区别。
 * 抛错：超时 / 桥回的错误响应（原话）/ TCP 回执丢了（不重放）。
 */
async function sendGuestCommandRaw(
  outDir: string,
  command: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<GuestReply> {
  const attempt = await sendGuestCommandOverTcp(outDir, command, fields, timeoutMs);
  if (attempt.kind === "failed") throw attempt.error;
  if (attempt.kind === "reply") {
    if (attempt.resp.ok === false) {
      const message = typeof attempt.resp.error === "string" ? attempt.resp.error : "guest 桥执行失败（没给原因）";
      throw new Error(message);
    }
    return {
      resp: attempt.resp,
      ...(attempt.jpegInline === undefined ? {} : { jpegInline: attempt.jpegInline }),
      file: null,
    };
  }

  // ── 以下是改动前的文件协议，一条行为都没变（它是回退通道）──
  commandSeq += 1;
  const baseName = `cmd-${String(commandSeq).padStart(6, "0")}`;
  const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
  const reqTmp = join(cmdDir, `${baseName}.tmp`);
  const reqPath = join(cmdDir, `${baseName}.req.json`);
  const respPath = join(cmdDir, `${baseName}.resp.json`);

  // tmp + rename：桥轮询读目录，不许它读到半截请求
  await mkdir(cmdDir, { recursive: true });
  // tmp + rename：桥轮询读目录，不许它读到半截请求
  await writeFile(reqTmp, JSON.stringify({ seq: commandSeq, command, ...fields }), "utf8");
  await rename(reqTmp, reqPath);

  const cleanup = async (jpgName?: string): Promise<void> => {
    // 清理是尽力而为：残留文件不影响协议（名字不重），下次会话 start() 会整个清掉
    await rm(reqPath, { force: true }).catch(() => {});
    await rm(respPath, { force: true }).catch(() => {});
    if (jpgName !== undefined) await rm(join(cmdDir, jpgName), { force: true }).catch(() => {});
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let raw: string | null = null;
    try {
      raw = await readFile(respPath, "utf8");
    } catch {
      // 还没写好，继续等
    }
    if (raw !== null) {
      const resp = parseResp(raw);
      if (resp !== null) {
        if (resp.ok === false) {
          const message = typeof resp.error === "string" ? resp.error : "guest 桥执行失败（没给原因）";
          await cleanup();
          throw new Error(message);
        }
        return { resp, file: { cmdDir, baseName } };
      }
    }
    if (Date.now() >= deadline) {
      await cleanup();
      throw new Error(guestTimeoutMessage(command, timeoutMs));
    }
    await sleep(RESP_POLL_INTERVAL_MS);
  }
}

/**
 * 桥不应答时的那句话。**必须能照着做**：模型看不见 UI，一句「没有响应」它只能重试同一个动作。
 *
 * 浏览器命令与像素命令的下一步不同（前者能查会话状态、能退回像素工具；后者只能先截图看桌面），
 * 所以按命令分两支。两句话都没有「没有在运行 / 没有启动」这类字眼：宿主靠那两个词做
 * 「缓存过期」自愈（cdp.ts 的 isNotRunning），超时不是那个语义，不该触发重试。
 */
export function guestTimeoutMessage(command: string, timeoutMs: number): string {
  // 测试里会传 300ms 这种值：不足一秒就按毫秒说，别把预算写成「超时 0s」
  const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
  if (command.startsWith("cdp-")) {
    return (
      `沙箱里的浏览器没有响应（${command} 超时 ${budget}）——可能是浏览器卡住了：` +
      "用 cdp-status 确认会话状态，或改用 computer_screenshot / computer_click 像素工具"
    );
  }
  return (
    `沙箱里的桌面没有响应（${command} 超时 ${budget}）——也许是沙箱卡住了或正在重置：` +
    "先用 computer_screenshot 确认桌面状态，必要时重启沙箱"
  );
}

/**
 * 通用命令往返：写 req → 等 resp → 清理。回执是桥给的扁平 JSON（`ok` 已保证为 true）。
 * 所有失败以 Error 抛出（消息已是人话，调用方直接展示）。
 *
 * 超时缺省按**命令类**取（`computerUseGuestTimeoutMs`）：cdp-* 要容下 guest 里 40s 的
 * worker 杀线 + 那句话走回宿主的一跳（实测 8–19s），像素命令仍是 45s。
 *
 * 截图那条单独走 fetchGuestScreenshot：它除了 resp 还要读同名 .jpg 兄弟文件。
 */
export async function sendGuestCommand(
  outDir: string,
  command: string,
  fields: Record<string, unknown> = {},
  timeoutMs: number = computerUseGuestTimeoutMs(command),
): Promise<Record<string, unknown>> {
  const reply = await sendGuestCommandRaw(outDir, command, fields, timeoutMs);
  if (reply.file !== null) {
    const { cmdDir, baseName } = reply.file;
    await rm(join(cmdDir, `${baseName}.req.json`), { force: true }).catch(() => {});
    await rm(join(cmdDir, `${baseName}.resp.json`), { force: true }).catch(() => {});
  }
  return reply.resp;
}

/**
 * 就绪探针：桥通告了 bridge.json ≠ 命令通道已通（host→guest 有开机热身期）。
 * start() 必须在宣布 running 之前等到 ping 应答。
 */
export async function pingGuest(outDir: string, timeoutMs: number): Promise<void> {
  const resp = await sendGuestCommand(outDir, computerUseGuestCommands.ping, {}, timeoutMs);
  if (resp.ok !== true) throw new Error("guest 桥的 ping 响应畸形");
}

/**
 * 向 guest 桥要一张**桌面**截图（像素路径，固定用 45s 那条线）。
 * 所有失败都以 Error 抛出（消息已是人话，调用方直接展示）：
 * 超时 / 桥回的错误命令响应 / 响应缺字段 / 文件名非法 / JPEG 缺失。
 */
export async function fetchGuestScreenshot(
  outDir: string,
  maxWidth: number,
  timeoutMs: number = GUEST_COMMAND_TIMEOUT_MS,
): Promise<GuestScreenshot> {
  const shot = await fetchGuestShot(
    outDir,
    computerUseGuestCommands.screenshot,
    { maxWidth },
    timeoutMs,
  );

  const nativeWidth = shot.resp.nativeWidth;
  const nativeHeight = shot.resp.nativeHeight;
  const width = shot.resp.width;
  const height = shot.resp.height;
  if (
    typeof nativeWidth !== "number" ||
    typeof nativeHeight !== "number" ||
    nativeWidth <= 0 ||
    nativeHeight <= 0 ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("guest 桥的截图响应缺字段（width / height / nativeWidth / nativeHeight / jpeg）");
  }

  return { jpeg: shot.jpeg, width, height, nativeWidth, nativeHeight };
}

/**
 * 带同名 `.jpg` 兄弟文件的命令（像素截图与 cdp-shot 共用）：resp 里只放**纯文件名**，
 * 二进制不进 JSON。读盘前过 isPlainScreenshotFileName 那道闸门（resp 是整条协议里唯一的
 * 不可信输入，被换掉的 guest 可以回一个 `..\..\Users\<me>\.ssh\id_ed25519`）。
 */
export async function fetchGuestShot(
  outDir: string,
  command: string,
  fields: Record<string, unknown>,
  timeoutMs: number = computerUseGuestTimeoutMs(command),
): Promise<GuestShot> {
  const reply = await sendGuestCommandRaw(outDir, command, fields, timeoutMs);

  // TCP：JPEG 已经在回执里（回程 64KB 只要 2–6ms），映射目录里没有也不需要任何文件
  if (reply.jpegInline !== undefined) return { jpeg: reply.jpegInline, resp: reply.resp };
  if (reply.file === null) {
    throw new Error(`guest 桥的 ${command} 响应缺 jpeg（TCP 回执里也没有 jpegBase64）`);
  }

  const { cmdDir, baseName } = reply.file;
  const resp = reply.resp;
  const jpegName = resp.jpeg;
  if (typeof jpegName !== "string" || jpegName === "") {
    throw new Error(`guest 桥的 ${command} 响应缺 jpeg 字段（应是兄弟文件名）`);
  }
  // 路径穿越闸门：读盘之前先卡死（理由见 isPlainScreenshotFileName）
  if (!isPlainScreenshotFileName(jpegName)) {
    throw new Error(`guest 桥回了非法的截图文件名：${jpegName}`);
  }

  // resp 里引用的 jpg 先于 resp 落盘（桥的顺序保证），读不到就是同步抖动，重读一次
  const jpgPath = join(cmdDir, jpegName);
  let jpeg: Buffer | null = null;
  try {
    jpeg = await readFile(jpgPath);
  } catch {
    await sleep(RESP_POLL_INTERVAL_MS);
    try {
      jpeg = await readFile(jpgPath);
    } catch {
      throw new Error("guest 桥的响应引用的 JPEG 文件不存在");
    }
  }

  // 读完清理（尽力而为；req 由桥在执行后删除）
  await rm(join(cmdDir, `${baseName}.req.json`), { force: true }).catch(() => {});
  await rm(join(cmdDir, `${baseName}.resp.json`), { force: true }).catch(() => {});
  await rm(jpgPath, { force: true }).catch(() => {});

  return { jpeg: new Uint8Array(jpeg), resp };
}
