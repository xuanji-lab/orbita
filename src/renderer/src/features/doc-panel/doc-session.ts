/**
 * 一份打开着的文档的同步状态机（无 DOM、无 React；IO 注入，所以能直接 `node --test`）。
 *
 * 它守三条规矩：
 * 1. **打字路径零开销**：`edit(text)` 只记下新全文并重置防抖计时器，不算差异、不碰 React。
 * 2. **写盘是比较后交换**：写之前带上「我认为盘上现在是什么」（baseHash）。主进程发现盘上
 *    已被 agent 改过就不写、回盘上的现状（conflict）——这里三向合并后再写，
 *    所以 agent 刚写的段落不会被旧版本盖回去（B2）。
 * 3. **全部异步动作串行**：保存、读盘合并排在同一条队列里，合并时用的 local 永远是
 *    「await 之后那一刻」的最新全文（编辑器每次按键同步进 `edit`，没有时间差）。
 *
 * 外部改动经 `onExternal` 交给编辑器：给出相对 local 的最小改动（光标靠 CM 映射）与新增区间（绿边）。
 */
import type { DocFile, DocWriteResult } from "../../../../shared/doc.ts";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { merge3, type TextChange } from "./doc-merge.ts";

export type SyncState = "saved" | "dirty" | "saving" | "error";

export interface DocIo {
  read(): Promise<DocFile>;
  write(text: string, expectedHash: string): Promise<DocWriteResult>;
}

export interface ExternalChange {
  /** 合并后的整份文本 */
  text: string;
  /** 相对合并前 local 的替换（坐标在合并前的 local 里） */
  changes: TextChange[];
  /** 新增 / 改动的区间（坐标在合并后的 text 里） */
  inserted: { from: number; to: number }[];
}

export interface DocSessionHooks {
  onState(state: SyncState, error: string | null): void;
  onExternal(change: ExternalChange): void;
  /** 全文变了（用户编辑或外部合并）：演示文稿的缩略条靠它重画；文档编辑器不需要 */
  onText?(text: string): void;
}

export class DocSession {
  private baseText: string;
  private baseHash: string;
  private local: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private saving = false;
  private error: string | null = null;
  private lastState: SyncState = "saved";
  private disposed = false;
  private readonly io: DocIo;
  private readonly hooks: DocSessionHooks;
  private readonly debounceMs: number;

  constructor(io: DocIo, initial: DocFile, hooks: DocSessionHooks, debounceMs = 500) {
    this.io = io;
    this.hooks = hooks;
    this.debounceMs = debounceMs;
    this.baseText = initial.text;
    this.baseHash = initial.hash;
    this.local = initial.text;
  }

  get text(): string {
    return this.local;
  }

  /** 编辑器每次改动同步调用（只记全文 + 重置防抖） */
  edit(text: string): void {
    if (this.disposed) return;
    this.local = text;
    this.schedule();
    this.publish();
    this.hooks.onText?.(text);
  }

  /** 盘上变了（文件监听 / 兜底轮询）：读一次、合并 */
  diskChanged(): void {
    this.enqueue(async () => {
      let file: DocFile;
      try {
        file = await this.io.read();
      } catch (cause) {
        this.fail(cause);
        return;
      }
      this.error = null;
      if (file.hash === this.baseHash) {
        this.publish();
        return; // 自己写的回声 / 没有实质变化
      }
      this.absorb(file);
      if (this.local !== this.baseText) this.schedule();
      this.publish();
    });
  }

  /** 立刻落盘（关面板 / 导出 / 切文档前）。返回时已写完或已报错 */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.enqueue(() => this.saveLoop());
  }

  /** 关文档：先把没写的写掉，再停掉计时器与后续动作 */
  async close(): Promise<void> {
    await this.flush();
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.saveLoop());
    }, this.debounceMs);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(() => (this.disposed ? undefined : task()));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async saveLoop(): Promise<void> {
    // 冲突后合并再写：最多绕几圈（每圈都是 agent 又写了一次），不死循环
    for (let attempt = 0; attempt < 8 && this.local !== this.baseText; attempt += 1) {
      const snapshot = this.local;
      this.saving = true;
      this.publish();
      let result: DocWriteResult;
      try {
        result = await this.io.write(snapshot, this.baseHash);
      } catch (cause) {
        this.saving = false;
        this.fail(cause);
        return;
      }
      this.saving = false;
      this.error = null;
      if (result.ok) {
        this.baseText = snapshot;
        this.baseHash = result.hash;
        // 写的过程中用户又打了字：交给防抖，不在这里紧接着再写
        if (this.local !== this.baseText) this.schedule();
        this.publish();
        return;
      }
      this.absorb(result.file);
    }
    this.publish();
  }

  /** 把盘上的现状并进 local，更新基线；有实质变化就通知编辑器 */
  private absorb(file: DocFile): void {
    const result = merge3(this.baseText, this.local, file.text);
    this.baseText = file.text;
    this.baseHash = file.hash;
    if (result.text !== this.local) {
      this.local = result.text;
      this.hooks.onExternal({ text: result.text, changes: result.changes, inserted: result.inserted });
      this.hooks.onText?.(result.text);
    }
  }

  private fail(cause: unknown): void {
    this.error = ipcErrorText(cause);
    this.publish();
  }

  private publish(): void {
    const state: SyncState =
      this.error !== null ? "error" : this.saving ? "saving" : this.local !== this.baseText ? "dirty" : "saved";
    if (state === this.lastState && state !== "error") return;
    this.lastState = state;
    this.hooks.onState(state, this.error);
  }
}
