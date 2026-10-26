/**
 * guest 桥就绪发现 —— 桥的自我通告走文件（映射文件夹是唯一可靠的通道）。
 *
 * 背景：宿主↔沙箱的 TCP 被宿主防火墙当成不可测（2026-10-10 真机：ICMP 通、TCP 被丢，
 * 且随每次启动时好时坏），调防火墙规则要提权弹窗，本地优先不接受。而 .wsb 的读写映射
 * 文件夹双向实时同步，桥启动后把 {"version","pid"} 写进 out/bridge.json（tmp+rename
 * 原子写）——它出现即代表桥的命令循环已上线。之后的命令通信也走同一目录（bridge-client.ts）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BRIDGE_INFO_FILE } from "../../shared/computer-use.ts";

/** 桥在 bridge.json 里通告的就绪信息（version/pid 仅日志与排障用，不参与协议判断） */
export interface BridgeInfo {
  version: string;
  pid: number;
}

/** 解析 bridge.json；任何不完整（半截、坏 JSON、缺字段）都回 null，调用方继续等 */
export function parseBridgeInfo(raw: string): BridgeInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { version, pid } = parsed as { version?: unknown; pid?: unknown };
  if (typeof version !== "string" || version === "") return null;
  return { version, pid: typeof pid === "number" && Number.isInteger(pid) ? pid : 0 };
}

export interface WaitForBridgeOptions {
  /** 等桥通告的 deadline（沙箱冷启动实测可达 105 秒+，默认由调用方给足） */
  timeoutMs: number;
  /** 轮询间隔，默认 500ms */
  intervalMs?: number;
  /** 取消谓词（stop()/dispose()/子进程先死），返回 true 时 resolve null 而不是抛 */
  isCancelled?: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询 out 目录等桥的 bridge.json 通告。
 * resolve BridgeInfo = 桥就绪；resolve null = 被取消；超时抛错（消息已是人话）。
 */
export async function waitForBridgeInfo(outDir: string, options: WaitForBridgeOptions): Promise<BridgeInfo | null> {
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  const filePath = join(outDir, BRIDGE_INFO_FILE);
  for (;;) {
    if (options.isCancelled?.() === true) return null;
    let raw: string | null = null;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // ENOENT = 桥还没写，继续等；其它读错也按「还没好」处理（映射文件夹同步抖动）
    }
    if (raw !== null) {
      // 桥是 tmp+rename 原子写，极小概率撞上同步中的半截文件——这轮当没看见，下轮再读
      const info = parseBridgeInfo(raw);
      if (info !== null) return info;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${Math.round(options.timeoutMs / 1000)} 秒内没等到 guest 桥就绪（bridge.json 未出现）——沙箱可能还在启动，或桥启动失败`,
      );
    }
    await sleep(intervalMs);
  }
}
