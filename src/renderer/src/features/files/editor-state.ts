/**
 * 源码编辑器的**纯状态逻辑**（自动保存调度 / 脏状态 / 冲突判定 / 关标签策略）。
 *
 * 独立成模块的理由同 tree-view.ts / latex-workbench.ts：TexEditorPane.tsx 连着
 * CodeMirror 与 IPC，`node --test` 加载不了；这里全是输入 → 输出（定时器由调用方
 * 注入），直接可测。
 *
 * 词义（docs/ubiquitous-language.md 那条「脏」的先例）：
 * - **基线指纹 savedHash**：编辑器最后一次「从盘上读到的」或「成功写下去的」文本的
 *   contentHash（shared/files.ts，两端同一个函数）。它**按磁盘格式算**（含 CRLF），
 *   不是按 CodeMirror 内部的 `\n` 算——否则一个 Windows 文件永远显示未保存。
 * - **脏 dirty**：当前文档按磁盘格式序列化后的指纹 ≠ 基线指纹。
 * - **冲突 conflict**：盘上内容的指纹 ≠ 基线指纹。自身保存不算冲突：写完当场把
 *   基线换成新指纹，下一次比对自然相等。
 */
import { contentHash } from "../../../../shared/files.ts";

/** 只有 .tex 走编辑器；.bib 等仍走只读预览（PR4 的范围只说 .tex） */
export function isEditableTexFile(path: string): boolean {
  return /\.tex$/i.test(path);
}

export type LineEnding = "\n" | "\r\n";

/**
 * 文件原本的换行。**必须保留**：CodeMirror 的文档模型把 `\r\n` 归一成行，
 * `Text.toString()` 拼回的是 `\n`——直接写回会把整个 Windows 文件变成 LF，
 * 一次「只改了一个字」的保存会在 git 里显示全文件重写。
 *
 * 混合换行的文件按多数派定（少量 Windows 工具会在追加内容时混进 LF）；平票取 LF。
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/** 把编辑器文档（内部恒为 `\n`）序列化成要写盘的文本 */
export function toDiskText(text: string, eol: LineEnding): string {
  // 先归一：文档里理论上不会有 CR，但粘贴进来的文本可能带着
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/** 当前文档是否与基线不同（按磁盘格式算指纹） */
export function isDirty(docText: string, savedHash: string, eol: LineEnding): boolean {
  return contentHash(toDiskText(docText, eol)) !== savedHash;
}

/**
 * 盘上内容变了没有。**只比指纹**：mtime 会因为一次「原样重写」而变（agent 的写工具、
 * 格式化脚本），那不该弹冲突；反过来同一毫秒内的两次写也可能 mtime 相同。
 */
export function isExternalChange(diskHash: string, savedHash: string): boolean {
  return diskHash !== savedHash;
}

/** 保存的调用方（组件里是同一个函数；测试里是一条记录） */
export type SaveTrigger = () => void;

/** 定时器由调用方注入（浏览器 setTimeout / 测试里的手动时钟） */
export interface TimerSource {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: TimerSource = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AutosaveScheduler {
  /** 记一次改动：重置 1.5 s 计时（停手 1.5 s 才落盘，连续打字不写盘） */
  schedule: () => void;
  /** 丢掉待执行的保存（例如发现了冲突：不能再自动写） */
  cancel: () => void;
  /** 立刻执行待执行的保存；没有待执行的返回 false（编译前的强制保存走这里） */
  flush: () => boolean;
  /** 有没有还没执行的保存 */
  pending: () => boolean;
}

/**
 * 自动保存的防抖调度器。
 *
 * `save` 里不需要再判脏——**由调用方判**：调度器只回答「该触发一次保存了」。
 * 这样同一个调度器既能用于自动保存，也能用于「编译前 flush」，不会因为调度器
 * 以为脏就多写一次盘。
 */
export function createAutosaveScheduler(input: {
  delayMs: number;
  save: SaveTrigger;
  timers?: TimerSource;
}): AutosaveScheduler {
  const timers = input.timers ?? defaultTimers;
  let handle: unknown = null;
  let waiting = false;

  const cancel = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    waiting = false;
  };

  const schedule = (): void => {
    waiting = true;
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      handle = null;
      if (!waiting) return;
      waiting = false;
      input.save();
    }, input.delayMs);
  };

  const flush = (): boolean => {
    const had = waiting;
    cancel();
    if (had) input.save();
    return had;
  };

  return { schedule, cancel, flush, pending: () => waiting };
}

/**
 * 关闭标签（或切换到别的标签）时怎么处理未保存内容：
 * - close：干净，直接关
 * - save：先存再关（自动保存的 1.5 s 还没到，不能因为切走就丢）
 * - block：有冲突，不能替用户做决定——标签留着，让他在「重新加载 / 保留我的」里选
 */
export type CloseDecision = "close" | "save" | "block";

export function closeDecision(input: { dirty: boolean; conflicted: boolean }): CloseDecision {
  if (!input.dirty) return "close";
  return input.conflicted ? "block" : "save";
}

/** 状态行 / 标签圆点用的阶段（i18n 文案在组件里取） */
export type EditorPhase = "saved" | "dirty" | "saving" | "error" | "conflict";

/** 光标位置（1 起算，与编辑器状态行的 Ln / Col 一致）；`doc` 是 CodeMirror 的 Text */
export function cursorPosition(
  doc: { lineAt: (offset: number) => { number: number; from: number } },
  head: number,
): { line: number; column: number } {
  const line = doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}
