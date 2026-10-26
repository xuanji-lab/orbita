/**
 * 流式按行扫 JSONL：**先看行首几百字节决定要不要这一行，不要的整行不解码、不攒**。
 *
 * ## 为什么（审核 F-3，2026-10-25）
 * 任务账本回填原来 `readFile(..., "utf8")` 整份读会话再逐行 parse：开发数据 1.06GB 里最大一条
 * 会话 145MB，读成字符串约 290MB，峰值 RSS 102MB → 1.2GB 以上，整份 split + parse 在主进程卡
 * 事件循环 200ms 以上。回填其实只要 assistant / intent-recall 这几种小行；工具结果、带附件的用户
 * 消息这种几 MB 的大行才是开销的大头，而它们的 role 键就在行首（开发数据 14 万行实测 role 键
 * 最晚出现在第 45 个字符）。所以按字节切行，行首够 HEAD_BYTES 或遇到换行就做决定：
 * 不要的行后续字节直接丢，内存只跟「被留下的行」走。
 *
 * ## 让步
 * 按时间片让事件循环：每处理完一个块看一眼，距上次让步超过 sliceMs 就 `setImmediate` 一次。
 * 不按「每 N 行 / 每条会话」让——行和会话的大小差三个数量级，固定计数要么让得太勤要么太稀。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import { createReadStream } from "node:fs";

/** 行首判定窗口：要判定的键（role / type）都在行首几十字节内，留足余量 */
export const HEAD_BYTES = 256;

const NEWLINE = 0x0a;

/** 时间片让步器：调用时若距上次让步已超过 sliceMs，就让一次事件循环 */
export function timeSlicer(sliceMs = 8): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };
}

/**
 * 逐行扫一个文件。`keep(head)` 拿行首（至多 HEAD_BYTES 字节解码出的文本，可能截在多字节字符中间）
 * 判断要不要；要的整行解码后交给 `onLine`。行的切法与 `text.split("\n")` 一致（含最后一行无换行）。
 * 读失败（不存在 / 权限 / 中途出错）原样抛出，由调用方决定怎么兜底。
 */
export async function scanJsonlLines(
  path: string,
  keep: (head: string) => boolean,
  onLine: (line: string) => void,
  yieldSlice: () => Promise<void> = timeSlicer(),
): Promise<void> {
  const line = new LineState(keep, onLine);
  const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      line.append(chunk, start, nl === -1 ? chunk.length : nl);
      if (nl === -1) break;
      line.finish();
      start = nl + 1;
    }
    await yieldSlice();
  }
  line.finish();
}

/** 正在切的那一行：攒字节、到行首窗口就做决定、换行时交出 */
class LineState {
  private readonly keep: (head: string) => boolean;
  private readonly onLine: (line: string) => void;
  /** 还没决定 / 要 / 不要 */
  private state: "pending" | "keep" | "skip" = "pending";
  private parts: Buffer[] = [];
  private length = 0;

  constructor(keep: (head: string) => boolean, onLine: (line: string) => void) {
    this.keep = keep;
    this.onLine = onLine;
  }

  append(chunk: Buffer, start: number, end: number): void {
    if (this.state === "skip" || end <= start) return;
    // subarray 不拷贝；被留下的行最后 concat 一次
    this.parts.push(chunk.subarray(start, end));
    this.length += end - start;
    if (this.state === "pending" && this.length >= HEAD_BYTES) this.decide();
  }

  /** 一行结束（遇到换行或文件尾）：要的交出去，然后复位。空行不交（与 split 后跳空行一致） */
  finish(): void {
    if (this.state === "pending" && this.length > 0) this.decide();
    if (this.state === "keep") this.onLine(Buffer.concat(this.parts, this.length).toString("utf8"));
    this.parts = [];
    this.length = 0;
    this.state = "pending";
  }

  private decide(): void {
    const head = Buffer.concat(this.parts, Math.min(this.length, HEAD_BYTES)).toString("utf8");
    this.state = this.keep(head) ? "keep" : "skip";
    if (this.state === "skip") {
      this.parts = [];
      this.length = 0;
    }
  }
}

/**
 * 行首里第一个 `"<key>":"` 的值（JSON.stringify 写出的紧凑形，键后无空格）；行首里没有返回 undefined。
 * 调用方拿 undefined 应当**保守地留下**这一行整行解析——手写或旧格式的行键序可能不同，不能因为
 * 粗筛而漏账。
 */
export function headStringField(head: string, key: string): string | undefined {
  const marker = `"${key}":"`;
  const at = head.indexOf(marker);
  if (at === -1) return undefined;
  const from = at + marker.length;
  const end = head.indexOf('"', from);
  return end === -1 ? undefined : head.slice(from, end);
}
