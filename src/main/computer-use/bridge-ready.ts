/**
 * guest 桥就绪发现 —— 桥的自我通告走文件（映射文件夹是唯一可靠的通道）。
 *
 * 背景：宿主↔沙箱的 TCP 曾经被宿主防火墙当成不可测（2026-10-10 真机：ICMP 通、TCP 被丢），
 * 2026-10-25 的隔离沙箱实验里则完全可用（握手 30ms、小包中位 1ms）。所以通告仍然走文件
 * （映射文件夹双向实时同步、每次都可靠），桥启动后把 {version,pid,port,token,ipv4} 写进
 * out/bridge.json（tmp+rename 原子写）——它出现即代表命令循环已上线。之后的命令通信
 * 优先走这条 TCP（bridge-client.ts），回退走同一目录里的文件协议。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BRIDGE_INFO_FILE, bridgeTcpFields, type GuestTcpChannel } from "../../shared/computer-use.ts";

/**
 * 桥在 bridge.json 里通告的就绪信息（version/pid 仅日志与排障用，不参与协议判断）。
 *
 * 0.8.0 起多了可选的 `tcp`：三个字段（port / token / ipv4）齐了才有，缺一个就是老桥
 * （或 TCP 监听没起来）——那种情况下宿主行为与改动前完全一致：纯文件协议。
 */
export interface BridgeInfo {
  version: string;
  pid: number;
  /** TCP 命令通道；undefined = 没有（老桥 / 监听没起来 / 字段不全） */
  tcp?: GuestTcpChannel;
}

/**
 * 解析 TCP 通道字段。**三个都合法才算可用**：宁可回退文件协议，也不拿半张通告去撞连接
 * ——半张通告只会在每条命令上多花 1.5s × 候选地址的等待。
 */
function parseTcpChannel(record: Record<string, unknown>): GuestTcpChannel | undefined {
  const port = record[bridgeTcpFields.port];
  const token = record[bridgeTcpFields.token];
  const ipv4 = record[bridgeTcpFields.ipv4];
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (typeof token !== "string" || token === "") return undefined;
  if (!Array.isArray(ipv4)) return undefined;
  const addresses = ipv4.filter((value): value is string => typeof value === "string" && value !== "");
  if (addresses.length === 0) return undefined;
  return { port, token, ipv4: addresses };
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
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  const pid = record["pid"];
  if (typeof version !== "string" || version === "") return null;
  const tcp = parseTcpChannel(record);
  return {
    version,
    pid: typeof pid === "number" && Number.isInteger(pid) ? pid : 0,
    ...(tcp === undefined ? {} : { tcp }),
  };
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
