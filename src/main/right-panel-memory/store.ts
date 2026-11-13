/**
 * 右栏记忆的落盘（契约在 shared/right-panel-memory.ts）。纯 node，不 import electron，`node --test` 直接测。
 *
 * 一个 JSON（`<userData>/right-panel-memory.json`），整份原子写（临时文件 + rename）。
 * 写入串行：renderer 防抖写盘偶尔会有两次写重叠，排队保证后到的一份最后落盘。
 * 文件不在 / 坏了读回 null（renderer 从空记忆起步）；这是「回到上次的位置」的便利，
 * 不值得为一份坏文件拦住任何事，下一次 save 会把坏文件覆盖掉。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  parseRightPanelMemoryFile,
  RIGHT_PANEL_MEMORY_MAX_CHARS,
  type RightPanelMemoryFile,
} from "../../shared/right-panel-memory.ts";

export class RightPanelMemoryStore {
  private readonly file: string;
  /** 写队列：每次 save 接在上一次后面 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<RightPanelMemoryFile | null> {
    try {
      return parseRightPanelMemoryFile(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return null;
    }
  }

  /** 入参当不可信数据：信封不对 / 体积超限就抛（invoke 在 renderer 侧变 rejected promise） */
  save(raw: unknown): Promise<void> {
    const file = parseRightPanelMemoryFile(raw);
    if (file === null) return Promise.reject(new Error("invalid right panel memory"));
    if (JSON.stringify(file).length > RIGHT_PANEL_MEMORY_MAX_CHARS) return Promise.reject(new Error("right panel memory too large"));
    const next = this.queue.then(() => writeJsonAtomic(this.file, file));
    // 一次写失败不拖垮后面的写（磁盘满、权限……）
    this.queue = next.catch(() => undefined);
    return next;
  }
}
