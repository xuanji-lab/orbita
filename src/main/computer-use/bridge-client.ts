/**
 * guest 桥的文件协议客户端 —— 宿主 ↔ 沙箱的唯一通道是映射文件夹。
 *
 * 为什么不走网络：宿主防火墙把宿主↔沙箱的 TCP 当不可测（2026-10-10 真机：ICMP 通、
 * TCP 被丢，且随每次启动时好时坏），调防火墙要提权弹窗，本地优先不接受。
 *
 * 协议（与 guest 桥 Program.cs 严格一致）：
 *   宿主写 out/cmd/<名字>.req.json（tmp+rename 原子写）→ 桥轮询执行 →
 *   写 <名字>.resp.json（截图的 JPEG 是同名 .jpg 兄弟文件，先于 resp 落盘）→ 删 req。
 *   宿主读到响应后负责清理 resp / jpg。名字里带递增序号，桥按名字排序处理。
 *
 * 注意 host→guest 方向开机有 ~20 秒热身期（实测）：桥通告了不代表命令通道已通，
 * 就绪握手（pingGuest）必须在截图之前完成（sandbox.ts 的启动链保证这个顺序）。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { COMPUTER_USE_CMD_DIR } from "../../shared/computer-use.ts";

export interface GuestScreenshot {
  jpeg: Uint8Array;
  nativeWidth: number;
  nativeHeight: number;
}

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

/** 桥不应答时的放弃线（就绪握手之后的命令通道是即时的，15s 没响应 = 桥死了 / 沙箱卡了） */
export const GUEST_COMMAND_TIMEOUT_MS = 15_000;

/** 等响应文件的轮询节奏（映射文件夹同步即时，这只是读盘节奏） */
const RESP_POLL_INTERVAL_MS = 200;

/** 进程内单调递增序号（每次沙箱会话 out/cmd 会被清空，不会撞上一局的文件） */
let commandSeq = 0;

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

/**
 * 文件协议的最小命令往返：写 req → 等 resp → 清理。
 * 抛错：超时（人话）/ 桥回的错误响应（原话带出）。
 */
async function sendGuestCommand(
  outDir: string,
  command: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ resp: Resp; cmdDir: string; baseName: string }> {
  commandSeq += 1;
  const baseName = `cmd-${String(commandSeq).padStart(6, "0")}`;
  const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
  const reqTmp = join(cmdDir, `${baseName}.tmp`);
  const reqPath = join(cmdDir, `${baseName}.req.json`);
  const respPath = join(cmdDir, `${baseName}.resp.json`);

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
        return { resp, cmdDir, baseName };
      }
    }
    if (Date.now() >= deadline) {
      await cleanup();
      throw new Error(`guest 桥 ${timeoutMs}ms 内没有响应（${command} 超时）`);
    }
    await sleep(RESP_POLL_INTERVAL_MS);
  }
}

/**
 * 就绪探针：桥通告了 bridge.json ≠ 命令通道已通（host→guest 有开机热身期）。
 * start() 必须在宣布 running 之前等到 ping 应答。
 */
export async function pingGuest(outDir: string, timeoutMs: number): Promise<void> {
  const { resp, cmdDir, baseName } = await sendGuestCommand(outDir, "ping", {}, timeoutMs);
  await rm(join(cmdDir, `${baseName}.resp.json`), { force: true }).catch(() => {});
  if (resp.ok !== true) throw new Error("guest 桥的 ping 响应畸形");
}

/**
 * 向 guest 桥要一张截图。所有失败都以 Error 抛出（消息已是人话，调用方直接展示）：
 * 超时 / 桥回的错误命令响应 / 响应缺字段 / 文件名非法 / JPEG 缺失。
 */
export async function fetchGuestScreenshot(
  outDir: string,
  maxWidth: number,
  timeoutMs: number = GUEST_COMMAND_TIMEOUT_MS,
): Promise<GuestScreenshot> {
  const { resp, cmdDir, baseName } = await sendGuestCommand(outDir, "screenshot", { maxWidth }, timeoutMs);

  const nativeWidth = resp.nativeWidth;
  const nativeHeight = resp.nativeHeight;
  const jpegName = resp.jpeg;
  if (
    typeof nativeWidth !== "number" ||
    typeof nativeHeight !== "number" ||
    nativeWidth <= 0 ||
    nativeHeight <= 0 ||
    typeof jpegName !== "string" ||
    jpegName === ""
  ) {
    throw new Error("guest 桥的截图响应缺字段（nativeWidth / nativeHeight / jpeg）");
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

  return { jpeg: new Uint8Array(jpeg), nativeWidth, nativeHeight };
}
